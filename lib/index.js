/**
 * dsh-context-offload
 *
 * 把已经完成的会话工作从「发给模型的上文」里卸下来，替换成一条墓碑提示。
 *
 * 与压缩（compaction）的区别：不调用任何模型、不生成摘要、不花时间。
 * 原理是 DSH 表面（surface）的 `surfaceOp` 替换：把一段表面节点整体换成
 * 一条消息。被替换的原始事件仍完整保留在会话日志里，所以界面照常显示、
 * 随时可以取消。
 *
 * API 用法参考了同机上的 `smart-compaction`（MIT）与 DSH 自带的
 * `compaction-basic` / `compaction-tool-result-pruner`。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { readdirSync, existsSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import zlib from 'node:zlib';

export const name = 'context-offload';
export const inject = ['tools', 'agents'];

// dsh 0.2（session format v4）要求每个产出方给自己的 kind，不能用通用 'plugin'。
const PLUGIN_SOURCE = { kind: 'context-offload' };

/** 最近一次活动过的会话（HTTP 请求没有 agent 上下文时用它兜底）。 */
let lastSession = null;

/** 取当前会话；拿不到就报错（不在 agent 调用里时会这样）。 */
function currentSession(ctx) {
  const agent = ctx.agents?.currentInitiator?.();
  const session = agent?.session;
  if (session) return session;
  if (lastSession) return lastSession;
  throw new Error('context-offload: 拿不到当前会话（可能不在 agent 调用中）');
}

/**
 * 请求指定的会话必须就是当前会话，否则拒绝。
 *
 * 为什么必须拦：seq 是会话内递增的，不同会话会撞号（都从 8 开始）。
 * HTTP 请求没有 agent 上下文，`currentSession()` 会退到 lastSession（最近活动的会话），
 * 如果它和用户正在看的会话不是同一个，就可能拿着 A 的 seq 去剪 B 的表面。
 */
function assertSession(session, wantId) {
  if (!wantId) return;
  const actual = session && session.id ? String(session.id) : '';
  if (actual && actual !== String(wantId)) {
    throw new Error(
      '会话不匹配：当前会话是 ' + actual + '，请求要操作 ' + wantId + '。请先切回那个会话再操作'
    );
  }
}

/** 把一条消息压成一行可读文本，用于列表预览。 */
/** 粗估 token：中文约 0.7/字，其余约 1/3.8 字符。比纯 chars/2.5 准。 */
function estTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.round(cjk * 0.7 + other / 3.8);
}

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') return `[调用 ${block.name}]`;
      if (block.type === 'tool_result') return '[工具结果]';
      if (block.type === 'image') return '[图片]';
      return `[${block.type}]`;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取一句话（到第一个句末标点为止），用于 gist。 */
function firstSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.{6,90}?[。！？.!?])/.exec(t);
  return (m ? m[1] : t).trim();
}

/** 安全地取事件对应的消息。 */
function safeMessage(session, seq) {
  try {
    const ev = session.eventAt(seq);
    if (!ev) return null;
    return session.deriveEventMessage?.(ev) ?? null;
  } catch {
    return null;
  }
}

/** 重建结果的缓存：5MB 会话解压一次要 200~500ms，切会话时不该反复付这个钱。 */
const SURFACE_CACHE = new Map();

/** 从会话文件重建表面（用于其他会话的候选分析）。 */
function loadSurfaceFromFile(session) {
  try {
    const file = join(homedir(), '.dsh', 'sessions', session.wsDir, session.id, 'session.v4.jsonl.zstd');
    let st = null;
    try {
      st = statSync(file);
    } catch {
      st = null;
    }
    if (st) {
      const hit = SURFACE_CACHE.get(session.id);
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.value;
    }
    const buf = readFileSync(file);
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
    }
    if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
    starts.push(buf.length);
    const events = [];
    const bySeq = new Map();
    for (let k = 0; k < starts.length - 1; k += 1) {
      let out;
      try {
        out = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]));
      } catch {
        continue;
      }
      for (const line of out.toString('utf8').split('\n')) {
        const t = line.trim();
        if (!t || t[0] !== '{') continue;
        let ev;
        try {
          ev = JSON.parse(t);
        } catch {
          continue;
        }
        events.push(ev);
        bySeq.set(ev.seq, ev);
      }
    }
    const surface = [];
    let userMessages = 0;
    let chars = 0;
    for (const ev of events) {
      // 顺手累计统计，省得再单独解压一遍（以前 /state 里 analyzeSessionFile + loadSurfaceFromFile 各来一次）
      if (ev.type === 'user/message' && ev.data && ev.data.source && ev.data.source.kind === 'user') {
        userMessages += 1;
      }
      if (ev.type === 'user/message' || ev.type === 'assistant/message') {
        chars += textOf(ev.data).length;
      }
      const op = ev.surfaceOp;
      if (!op) {
        // 没有 surfaceOp 的事件：消息类默认进表面（否则重建出来的表面是空的）
        if (ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result') {
          surface.push(ev.seq);
        }
        continue;
      }
      if (op === 'append') {
        surface.push(ev.seq);
        continue;
      }
      if (typeof op === 'object' && op.op === 'replace') {
        const i = surface.indexOf(op.startSeq);
        const j = surface.indexOf(op.endSeq);
        if (i >= 0 && j >= i) surface.splice(i, j - i + 1, ev.seq);
        else surface.push(ev.seq);
        continue;
      }
      surface.push(ev.seq);
    }
    const value = {
      shim: {
        surface: { nodes: surface },
        eventAt: (s) => bySeq.get(s),
        // 事件里的 data 本身就是 message 结构（content/role/source/id），
        // 不要再往 .message 找，否则标题全空。
        deriveEventMessage: (ev) => {
          if (!ev || !ev.data) return null;
          const d = ev.data;
          if (d.message && typeof d.message === 'object') return d.message;
          if (d.content || d.role) return d;
          return null;
        },
      },
      events: events.length,
      surfaceNodes: surface.length,
      userMessages,
      chars,
      tokens: Math.round(chars / 3),
    };
    if (st) {
      SURFACE_CACHE.set(session.id, { size: st.size, mtime: st.mtimeMs, value });
      // 只留最近 4 个，避免长时间运行把内存吃满
      while (SURFACE_CACHE.size > 4) {
        const oldest = SURFACE_CACHE.keys().next().value;
        SURFACE_CACHE.delete(oldest);
      }
    }
    return value;
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

/** 按 user/message 切段，返回较大的候选（按大小降序）。 */
function listCandidates(session, max = 12) {
  const nodes = session?.surface?.nodes ?? [];
  const marks = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const ev = session.eventAt(nodes[i]);
    if (ev?.type !== 'user/message') continue;
    // 只要真人消息：runtime context / system-reminder 这类系统注入不算一段工作
    const src = ev?.data?.source;
    if (src && src.kind && src.kind !== 'user') continue;
    marks.push({ i, seq: nodes[i], text: textOf(safeMessage(session, nodes[i])) });
  }
  const out = [];
  for (let k = 0; k < marks.length - 1; k += 1) {
    const startI = marks[k].i;
    const endI = marks[k + 1].i - 1;
    if (endI <= startI) continue;
    let chars = 0;
    let tokens = 0;
    let lastAsst = '';
    let firstAsst = '';
    for (let j = startI; j <= endI; j += 1) {
      const m = safeMessage(session, nodes[j]);
      const t = textOf(m);
      chars += t.length;
      tokens += estTokens(t);
      if (m && m.role === 'assistant' && t.length > 30) {
        if (!firstAsst) firstAsst = t;
        lastAsst = t;
      }
    }
    if (chars < 4000) continue;
    const conclusion = firstSentence(lastAsst);
    const opening = firstSentence(firstAsst);
    const gistParts = [];
    if (opening && opening !== conclusion) gistParts.push(opening);
    if (conclusion) gistParts.push(conclusion);
    const gist = (gistParts.join(' → ') || marks[k].text || '').slice(0, 90);
    const reasons = [];
    if (chars >= 20000) reasons.push(`块头够大（${tokens} tokens），剪了划算`);
    if (k <= marks.length - 4) reasons.push('不是最近几段的，后续大概率不再引用原文');
    if (/(完成|好了|成功|搞定|修好|通过|可以了|已解决|结束)/.test(lastAsst)) reasons.push('这段回复里出现了收尾语气，像是已经做完');
    if (!/(记住|以后都|以后要|偏好|我喜欢|我不要|叫我|称呼|习惯)/.test(gist + marks[k].text)) reasons.push('不含记忆或偏好类内容');
    if (reasons.length === 0) reasons.push('按大小排在前面，但没检测到明显的收尾特征，建议先看一眼再决定');
    out.push({
      id: `r${marks[k].seq}-${nodes[endI]}`,
      startSeq: marks[k].seq,
      endSeq: nodes[endI],
      title: (marks[k].text || '(无标题)').replace(/\s+/g, ' ').slice(0, 20),
      gist,
      tokens,
      chars,
      reasons,
    });
  }
  out.sort((a, b) => b.chars - a.chars);
  return out.slice(0, max);
}

// ---------------- 自动模式 ----------------

const AUTO_CFG = join(homedir(), '.dsh', 'context-offload-auto.json');
let autoBusy = false;

function readAutoCfg() {
  try {
    return JSON.parse(readFileSync(AUTO_CFG, 'utf8'));
  } catch {
    return { auto: false, cooldownTurns: 10, lastOffloadTurn: 0, lastOffloadAt: 0, minTokens: 20000 };
  }
}

function writeAutoCfg(cfg) {
  try {
    writeFileSync(AUTO_CFG, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

const AUTO_HISTORY = join(homedir(), '.dsh', 'context-offload-history.json');

function readHistory() {
  try {
    const a = JSON.parse(readFileSync(AUTO_HISTORY, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function appendHistory(rec) {
  try {
    const list = readHistory();
    list.unshift(rec);
    writeFileSync(AUTO_HISTORY, JSON.stringify(list.slice(0, 50), null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

// 硬约束：出现这些词的段落，自动模式永不触碰（约定、承诺、长期偏好不可剪）
const MEMORY_WORDS = [
  '记住', '别忘', '不要忘', '以后都', '不许', '答应我', '承诺', '约定',
  '永远', '一直', '陪着我', '别走', '重要', '说定了', '保证', '在乎',
  '喜欢', '讨厌', '委屈', '偏好',
];

function hasMemorySignal(text) {
  if (!text) return false;
  const t = String(text);
  for (const w of MEMORY_WORDS) if (t.includes(w)) return true;
  return false;
}

/** 数「用户发言」条数，作为轮次。 */
function turnOf(session) {
  let n = 0;
  const nodes = session?.surface?.nodes ?? [];
  for (const seq of nodes) {
    const ev = session.eventAt(seq);
    if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'user') n += 1;
  }
  return n;
}

/** 执行一次剪切（路由与自动模式共用）。 */
function performOffload(session, startSeq, endSeq, title, gist) {
  const nodes = session.surface.nodes;
  const si = nodes.indexOf(startSeq);
  const ei = nodes.indexOf(endSeq);
  if (si === -1 || ei === -1) throw new Error('seq 不在当前表面上');
  if (si > ei) throw new Error('startSeq 在 endSeq 之后');
  let bal = false;
  try {
    bal = toolPairingBalancedBefore(session, startSeq) === true;
  } catch {
    bal = false;
  }
  if (!bal) throw new Error('seq ' + startSeq + ' 不是安全边界（会劈开工具调用对）');
  // 结尾也要校验：只查头不查尾，可能把 tool_use 后面那段 tool_result 留在表面上。
  let balEnd = true;
  try {
    balEnd = toolPairingBalancedAfter(session, endSeq) === true;
  } catch {
    balEnd = false;
  }
  if (!balEnd) throw new Error('seq ' + endSeq + ' 不是安全边界（会劈开工具调用对）');
  const span = nodes.slice(si, ei + 1);
  const text = [
    `〔已卸下：${title}〕`,
    gist ? `  └ ${gist}` : null,
    `  ${span.length} 个节点 · seq ${startSeq}..${endSeq}`,
    `  origin: ${startSeq}..${endSeq}`,
    '  原文仍保留在会话中（界面可见、可随时取消），只是不再发给模型。',
  ]
    .filter(Boolean)
    .join('\n');
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form: 'notice', summary: title },
  });
  const appended = session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq, endSeq },
    sourceEventSeqs: span,
  });
  return { tombSeq: appended?.seq ?? null, nodes: span.length };
}

/** 自动模式主逻辑：够了就剪（prompt 模式只记账不动手）。 */
function maybeAutoOffload(session) {
  const cfg = readAutoCfg();
  if (!cfg.auto && !cfg.prompt) return { skipped: 'off' };
  const turn = turnOf(session);
  const cooldown = Number(cfg.cooldownTurns) || 10;
  if (turn - (Number(cfg.lastOffloadTurn) || 0) < cooldown) return { skipped: 'cooldown' };

  const nodes = session.surface.nodes;
  const userSeqs = [];
  for (const seq of nodes) {
    const ev = session.eventAt(seq);
    if (ev?.type === 'user/message' && ev?.data?.source?.kind === 'user') userSeqs.push(seq);
  }
  // 最近 2 轮保留
  const keepFrom = userSeqs.length >= 2 ? userSeqs[userSeqs.length - 2] : -1;

  const cands = listCandidates(session, 60).filter((c) => {
    if (keepFrom >= 0 && c.endSeq >= keepFrom) return false;
    if (hasMemorySignal(c.title + ' ' + c.gist)) return false;
    return c.tokens >= 800;
  });
  const total = cands.reduce((a, c) => a + c.tokens, 0);
  if (total < (Number(cfg.minTokens) || 20000)) return { skipped: 'below-min', total };

  // 提示模式：只挂一条“建议”，等用户点头
  if (cfg.prompt && !cfg.auto) {
    cfg.pending = {
      at: Date.now(),
      sessionId: session.id,
      count: cands.length,
      tokens: total,
      turn,
      segments: cands.slice(0, 20).map((c) => ({ title: c.title, gist: c.gist, tokens: c.tokens, startSeq: c.startSeq, endSeq: c.endSeq })),
    };
    cfg.lastOffloadTurn = turn;
    writeAutoCfg(cfg);
    return { suggested: true, total, count: cands.length };
  }

  // 从后往前剪：后面的先剪，前面的 seq 不受影响
  cands.sort((a, b) => b.startSeq - a.startSeq);
  let count = 0;
  let saved = 0;
  for (const c of cands) {
    try {
      performOffload(session, c.startSeq, c.endSeq, c.title, c.gist);
      count += 1;
      saved += c.tokens;
    } catch {
      /* 跳过剪不动的 */
    }
  }
  if (count === 0) return { skipped: 'none-cut' };

  try {
    const note = `〔自动剪切 · 剪了 ${count} 段，省 ${Math.round(saved / 1000)}K〕`;
    const msg = createUserMessage({
      content: [{ type: 'text', text: note }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: '自动剪切' },
    });
    session.append('user/message', msg);
  } catch {
    /* 留痕失败不影响剪切 */
  }

  cfg.lastOffloadTurn = turn;
  cfg.lastOffloadAt = Date.now();
  writeAutoCfg(cfg);
  appendHistory({
    at: cfg.lastOffloadAt,
    count,
    saved,
    turn,
    segments: cands.slice(0, count).map((c) => ({ title: c.title, gist: c.gist, tokens: c.tokens })),
  });
  return { count, saved, turn };
}

/** 找出已卸下的段（墓碑消息）。 */
function listOffloaded(session) {
  const nodes = session?.surface?.nodes ?? [];
  const out = [];
  for (const seq of nodes) {
    const msg = safeMessage(session, seq);
    if (!msg) continue;
    if (msg?.source?.form !== 'notice') continue;
    const text = textOf(msg);
    const m = text.match(/〔已卸下：(.+?)〕/);
    if (!m) continue;
    const lines = String(text).split('\n');
    const rawGist = (lines[1] ?? '').replace(/^\s*└\s*/, '').trim();
    // 墓碑没写 gist 时，第二行是「N 个节点 · seq …」，别把它当成摘要显示
    const gist = /个节点/.test(rawGist) ? '' : rawGist;
    const nm = /(\d+)\s*个节点/.exec(text);
    const om = /origin:\s*(\d+)\.\.(\d+)/.exec(text);
    const nodeCount = nm ? Number(nm[1]) : 0;
    let tk = 0;
    if (om) {
      const a = Number(om[1]);
      const b = Math.min(Number(om[2]), a + 20000);
      for (let s0 = a; s0 <= b; s0 += 1) {
        let e0 = null;
        try {
          e0 = session.eventAt(s0);
        } catch {
          continue; // 无效 seq 不该让整个列表崩
        }
        if (!e0) continue;
        let m0 = null;
        try {
          m0 = session.deriveEventMessage(e0);
        } catch {
          m0 = null;
        }
        tk += estTokens(textOf(m0));
      }
    }
    if (!tk) tk = nodeCount * 200;
    const ev0 = session.eventAt(seq);
    const when = ev0 && ev0.time ? new Date(ev0.time) : null;
    const date = when
      ? `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
      : '';
    out.push({
      id: `t${seq}`,
      tombSeq: seq,
      title: m[1],
      gist: gist.slice(0, 56),
      tokens: tk,
      nodes: nodeCount,
      originStart: om ? Number(om[1]) : 0,
      originEnd: om ? Number(om[2]) : 0,
      origin: om ? om[1] + '..' + om[2] : '',
      msgId: (msg && msg.id) || '',
      date,
    });
  }
  return out;
}

/** 读会话标题（从 projcache 的前 16KB 里抠出来，不解压会话本体）。 */
function readTitle(id) {
  try {
    const f = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', id + '.json');
    const fd = openSync(f, 'r');
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, 16384, 0);
    closeSync(fd);
    const s = buf.subarray(0, n).toString('utf8');
    const m = s.match(/"title"\s*:\s*\{[^}]*?"val"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse('"' + m[1] + '"') : '(无标题)';
  } catch {
    return '(无标题)';
  }
}

/** 列出所有会话（按文件大小降序）。 */
function listAllSessions() {
  const root = join(homedir(), '.dsh', 'sessions');
  const out = [];
  let wsDirs = [];
  try {
    wsDirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const wsDir of wsDirs) {
    let ids = [];
    try {
      ids = readdirSync(join(root, wsDir));
    } catch {
      continue;
    }
    for (const id of ids) {
      if (!id.startsWith('session-')) continue;
      const file = join(root, wsDir, id, 'session.v4.jsonl.zstd');
      if (!existsSync(file)) continue;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      out.push({ id, wsDir, size, title: readTitle(id) });
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** 解压一个会话文件（多帧 zstd），返回事件数量 / 用户消息数 / 字符数。 */
function analyzeSessionFile(session) {
  try {
    const file = join(homedir(), '.dsh', 'sessions', session.wsDir, session.id, 'session.v4.jsonl.zstd');
    const buf = readFileSync(file);
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i += 1) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
    }
    if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
    starts.push(buf.length);
    let events = 0;
    let userMessages = 0;
    let chars = 0;
    let tkAll = 0;
    let firstText = '';
    for (let k = 0; k < starts.length - 1; k += 1) {
      let out;
      try {
        out = zlib.zstdDecompressSync(buf.subarray(starts[k], starts[k + 1]));
      } catch {
        continue;
      }
      const text = out.toString('utf8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t[0] !== '{') continue;
        let ev;
        try {
          ev = JSON.parse(t);
        } catch {
          continue;
        }
        events += 1;
        if (ev.type !== 'user/message') continue;
        userMessages += 1;
        const c = ev.data?.content;
        if (!Array.isArray(c)) continue;
        for (const b of c) {
          if (b?.type === 'text' && typeof b.text === 'string') {
            chars += b.text.length;
            tkAll += estTokens(b.text);
            if (!firstText && b.text.length > 2) firstText = b.text.slice(0, 40);
          }
        }
      }
    }
    return { events, userMessages, chars, tokens: tkAll, firstText };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

export function apply(ctx) {
  // ── 0. 记住最近活动的会话（HTTP 接口没有 agent 上下文时用）──────
  if (typeof ctx.on === 'function') {
    ctx.on('session/created', (s) => {
      if (s) lastSession = s;
    });
    ctx.on('session/event', (s, ev) => {
      if (s) lastSession = s;
      if (!s || !ev || autoBusy) return;
      if (ev.type !== 'user/message') return;
      const kind = ev.data && ev.data.source ? ev.data.source.kind : '';
      if (kind !== 'user') return;
      autoBusy = true;
      setTimeout(() => {
        try {
          const r = maybeAutoOffload(s);
          if (r && r.count) {
            try {
              ctx.logger?.info?.('[context-offload] 自动剪切 ' + r.count + ' 段，省 ' + r.saved);
            } catch {
              /* 忽略 */
            }
          }
        } catch (e) {
          try {
            ctx.logger?.warn?.('[context-offload] 自动剪切失败: ' + (e && e.message ? e.message : e));
          } catch {
            /* 忽略 */
          }
        } finally {
          autoBusy = false;
        }
      }, 0);
    });
  }

  // ── 1. 列出表面节点，供挑选范围 ────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'offload_list',
      description:
        '列出当前会话的表面节点（seq / 事件类型 / 内容摘要 / 是否安全边界），用于挑选要卸下的范围。seq 是事件追加序号，不是消息序号。节点多时必须传 tail，否则输出会大到无法阅读。',
      parameters: {
        tail: { type: 'number', description: '只看最后 N 个节点（推荐 40；不传则列出全部，输出可能上百 KB）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const session = currentSession(ctx);
        const nodes = session.surface.nodes;
        const tailN = Math.max(0, Number(args?.tail ?? 0) || 0);
        const show = tailN > 0 ? nodes.slice(-tailN) : nodes;
        const lines = [
          `表面节点 ${nodes.length} 个（★ = 可作为剪切起点的安全边界）${tailN > 0 ? `，只显示最后 ${show.length} 个` : '，全部显示'}：`,
        ];
        for (const seq of show) {
          const event = session.eventAt(seq);
          if (!event) continue;
          let message = null;
          try {
            message = session.deriveEventMessage(event);
          } catch {
            message = null;
          }
          let safe = false;
          try {
            safe = toolPairingBalancedBefore(session, seq) === true;
          } catch {
            safe = false;
          }
          const head = textOf(message).slice(0, 96);
          lines.push(
            `  ${safe ? '★' : ' '} ${String(seq).padStart(6)}  ${String(event?.type ?? '?').padEnd(12)} ${head}`,
          );
        }
        return lines.join('\n');
      },
    }),
  );

  // ── 1.5 自动识别候选段（不用手算 seq）────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'offload_candidates',
      description:
        '按用户消息自动切分当前表面，列出所有「工作段」（段序号、起止 seq、节点数、开头摘要），从新到旧排列。不给字符量/token 估算——那个数字失真严重（含被投影掉的内容），真实节省只能剪完实测。',
      parameters: {
        minNodes: { type: 'number', description: '只列节点数 ≥ 该值的段，默认 5' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const session = currentSession(ctx);
        const nodes = session.surface.nodes;
        const min = Number(args?.minNodes ?? 5);
        const segs = [];
        let cur = null;
        for (const seq of nodes) {
          const event = session.eventAt(seq);
          if (!event) continue;
          let message = null;
          try {
            message = session.deriveEventMessage(event);
          } catch {
            message = null;
          }
          const flat = textOf(message);
          if (event.type === 'user/message') {
            const t = flat.replace(/\s+/g, ' ').trim();
            const skip =
              /^(Current runtime context|Time sampled|\[图片\])|Runtime context\. This snapshot/.test(t);
            if (!skip) {
              if (cur) segs.push(cur);
              cur = {
                start: seq,
                end: seq,
                head: t.slice(0, 44),
                nodes: 0,
              };
            }
          }
          if (cur) {
            cur.end = seq;
            cur.nodes += 1;
          }
        }
        if (cur) segs.push(cur);
        const all = segs.map((s, i) => ({ ...s, no: i + 1 }));
        const hit = all.filter((s) => s.nodes >= min).sort((a, b) => b.no - a.no);
        const lines = [
          `表面 ${nodes.length} 个节点，切成 ${segs.length} 段（按段序号从新到旧）：`,
          `#N = 第几段（1 最旧）。字符量已刻意不给——它含被投影掉的内容，严重失真，真实节省只能剪完实测。`,
        ];
        for (const s of hit) {
          lines.push(
            `  #${String(s.no).padStart(3)}  ${String(s.start).padStart(6)}-${String(s.end).padEnd(6)} ${String(s.nodes).padStart(3)}节点  ${s.head}`,
          );
        }
        return lines.join('\n');
      },
    }),
  );

  // ── 2. 卸下一段 ──────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'offload_context',
      description:
        '把 startSeq..endSeq 这段已完成的会话工作从发给模型的上文中卸下，替换成一条墓碑提示。原文仍保留在会话历史与界面中，不会删除，可随时取消。不调用模型，瞬间完成。',
      parameters: {
        startSeq: { type: 'number', required: true, description: '起始表面节点 seq（须是 ★ 安全边界）' },
        endSeq: { type: 'number', required: true, description: '结束表面节点 seq（含）' },
        title: { type: 'string', required: true, description: '这段工作的简短标题' },
        gist: { type: 'string', description: '一句话微摘要（可选），便于日后想起内容' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const session = currentSession(ctx);
        const nodes = session.surface.nodes;
        const startSeq = Number(args.startSeq);
        const endSeq = Number(args.endSeq);
        const startIdx = nodes.indexOf(startSeq);
        const endIdx = nodes.indexOf(endSeq);
        if (startIdx === -1 || endIdx === -1) {
          throw new Error(
            `seq 不在当前表面上：${startSeq}..${endSeq}（表面共 ${nodes.length} 个节点，首=${nodes[0]}，末=${nodes[nodes.length - 1]}，类型 start=${typeof args.startSeq} end=${typeof args.endSeq}）`,
          );
        }
        if (startIdx > endIdx) {
          throw new Error(`startSeq(${startSeq}) 在 endSeq(${endSeq}) 之后`);
        }
        let balanced = false;
        try {
          balanced = toolPairingBalancedBefore(session, startSeq) === true;
        } catch {
          balanced = false;
        }
        if (!balanced) {
          throw new Error(
            `seq ${startSeq} 不是安全边界：从这里切会把某一步的工具调用和结果劈开。请改用 offload_list 里标 ★ 的节点。`,
          );
        }

        const span = nodes.slice(startIdx, endIdx + 1);

        // origin：如果 span 里含有"取回"的副本，继承它记录的原始范围。
        // 这样不管中间被 ACP 压过几轮，取回时都还能找到最初那份原文。
        // 注意：一旦找到 origin，就用它的范围，不要和自己的 seq 取 min/max，
        // 否则新位置会被并进来，范围越滚越大。
        let originStart = startSeq;
        let originEnd = endSeq;
        let foundOrigin = false;
        for (const seq of span) {
          const ev = session.eventAt(seq);
          if (!ev) continue;
          let msg = null;
          try {
            msg = session.deriveEventMessage(ev);
          } catch {
            msg = null;
          }
          const m = /origin:\s*(\d+)\.\.(\d+)/.exec(textOf(msg));
          if (m) {
            if (!foundOrigin) {
              originStart = Number(m[1]);
              originEnd = Number(m[2]);
              foundOrigin = true;
            } else {
              originStart = Math.min(originStart, Number(m[1]));
              originEnd = Math.max(originEnd, Number(m[2]));
            }
          }
        }

        const text = [
          `〔已卸下：${args.title}〕`,
          args.gist ? `  └ ${args.gist}` : null,
          `  ${span.length} 个节点 · seq ${startSeq}..${endSeq}`,
          `  origin: ${originStart}..${originEnd}`,
          '  原文仍保留在会话中（界面可见、可随时取消），只是不再发给模型。',
        ]
          .filter(Boolean)
          .join('\n');

        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: args.title },
        });

        const appended = session.append('user/message', message, {
          surfaceOp: { op: 'replace', startSeq, endSeq },
          sourceEventSeqs: span,
        });

        return `已卸下「${args.title}」：${span.length} 个节点，替换为一条墓碑（新事件 seq=${appended?.seq ?? '?'}）`;
      },
    }),
  );

  // ── 3. 取消剪切（把墓碑换回原文）──────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'offload_cancel',
      description:
        '取消一次剪切：把墓碑换回被卸下的原文（拼成一条消息重新注入上下文）。原文体积可能很大，取回后 token 会回升。tombSeq 是墓碑事件的 seq。',
      parameters: {
        tombSeq: {
          type: 'number',
          required: true,
          description: '墓碑事件的 seq（offload_list 里内容是〔已卸下：…〕的那个节点）',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const session = currentSession(ctx);
        const tombSeq = Number(args.tombSeq);
        const event = session.eventAt(tombSeq);
        if (!event) throw new Error(`找不到 seq ${tombSeq} 的事件`);
        if (!session.surface.nodes.includes(tombSeq)) {
          throw new Error(
            `墓碑 seq ${tombSeq} 已不在表面上（多半被 ACP 压缩吃掉了），无法再取回。`,
          );
        }
        // 优先按墓碑里记的 origin 范围取原文（绕开中间的压缩），
        // 没有 origin 时才退回 sourceEventSeqs。
        let tombMessage = null;
        try {
          tombMessage = session.deriveEventMessage(event);
        } catch {
          tombMessage = null;
        }
        const originMatch = /origin:\s*(\d+)\.\.(\d+)/.exec(textOf(tombMessage));
        let src;
        if (originMatch) {
          const a = Number(originMatch[1]);
          const b = Number(originMatch[2]);
          if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b - a > 200000) {
            throw new Error(`墓碑里的 origin 范围不合法：${originMatch[1]}..${originMatch[2]}`);
          }
          src = [];
          for (let s = a; s <= b; s++) src.push(s);
        } else {
          src = event.sourceEventSeqs ?? event.data?.sourceEventSeqs ?? [];
        }
        if (!Array.isArray(src) || src.length === 0) {
          throw new Error(
            `seq ${tombSeq} 不是墓碑（既没有 origin 也没有 sourceEventSeqs）。实际字段：${Object.keys(event).join(',')}`,
          );
        }
        const originTag = originMatch
          ? `origin: ${originMatch[1]}..${originMatch[2]}`
          : `origin: ${src[0]}..${src[src.length - 1]}`;
        const parts = [];
        for (const seq of src) {
          const ev = session.eventAt(seq);
          if (!ev) continue;
          let msg = null;
          try {
            msg = session.deriveEventMessage(ev);
          } catch {
            msg = null;
          }
          const t = textOf(msg);
          if (t) parts.push(t);
        }
        if (parts.length === 0) {
          throw new Error(`墓碑 seq ${tombSeq} 的 ${src.length} 段原文都已不在日志中，无法取回`);
        }
        const body = parts.join('\n\n');
        const text = [
          `〔已取回：${originTag}，${parts.length} 段〕`,
          '',
          body,
        ].join('\n');

        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: '取回上下文' },
        });

        const appended = session.append('user/message', message, {
          surfaceOp: { op: 'replace', startSeq: tombSeq, endSeq: tombSeq },
          sourceEventSeqs: [tombSeq],
        });

        return `已取回 ${originTag}：${parts.length} 段、${body.length} 字符，新事件 seq=${appended?.seq ?? '?'}`;
      },
    }),
  );

  // ── 4.5 临时读取已卸下的原文（只读，墓碑保留）────────────────
  ctx.tools.register(
    defineTool({
      name: 'load_context',
      description:
        '临时读取某段已卸下的原文（只读，墓碑保留、不占永久上下文）。适合「我需要看看那段里到底写了什么」，看完就丢；想永久取回请用 offload_cancel。',
      parameters: {
        tombSeq: {
          type: 'number',
          required: true,
          description: '墓碑事件的 seq（offload_list 里内容是〔已卸下：…〕的那个节点）',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const session = currentSession(ctx);
        const tombSeq = Number(args.tombSeq);
        const event = session.eventAt(tombSeq);
        if (!event) throw new Error(`找不到 seq ${tombSeq} 的事件`);
        let tombMessage = null;
        try {
          tombMessage = session.deriveEventMessage(event);
        } catch {
          tombMessage = null;
        }
        const t = textOf(tombMessage);
        const originMatch = /origin:\s*(\d+)\.\.(\d+)/.exec(t);
        let src = [];
        if (originMatch) {
          const a = Number(originMatch[1]);
          const b = Number(originMatch[2]);
          if (!Number.isFinite(a) || !Number.isFinite(b) || b < a || b - a > 200000) {
            throw new Error(`墓碑里的 origin 范围不合法：${originMatch[1]}..${originMatch[2]}`);
          }
          for (let s = a; s <= b; s++) src.push(s);
        } else {
          src = event.sourceEventSeqs ?? event.data?.sourceEventSeqs ?? [];
        }
        if (!Array.isArray(src) || src.length === 0) {
          throw new Error(`seq ${tombSeq} 不是墓碑（没有 origin / sourceEventSeqs）`);
        }
        const parts = [];
        const seen = new Set();
        const expand = (a, b) => {
          const lo = Math.max(0, Math.min(a, b));
          const hi = Math.min(1000000, Math.max(a, b));
          for (let s0 = lo; s0 <= hi; s0++) {
            if (seen.has(s0)) continue;
            seen.add(s0);
            const ev = session.eventAt(s0);
            if (!ev) continue;
            let m = null;
            try {
              m = session.deriveEventMessage(ev);
            } catch {
              m = null;
            }
            const tt = textOf(m);
            if (!tt) continue;
            const inner = /〔已取回：origin:\s*(\d+)\.\.(\d+)/.exec(tt);
            if (inner) expand(Number(inner[1]), Number(inner[2]));
            else parts.push(tt);
          }
        };
        for (const s of src) expand(s, s);
        if (parts.length === 0) throw new Error('原文已不在日志中');
        const body = parts.join('\n\n');
        const MAX = 20000;
        const clipped = body.length > MAX ? body.slice(0, MAX) + `\n\n……（已截断，原长 ${body.length} 字符）` : body;
        return `（只读加载 · 墓碑仍保留在会话里）\n\n${clipped}`;
      },
    }),
  );

  // ── 5. 前端 HTTP 接口（设置页「上下文剪切」用）──────────────────
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sub) => {
      const ws = sub?.webServer;
      if (ws === undefined || typeof ws.register !== 'function') return;
      const off = ws.register({
        kind: 'prefix',
        path: '/context-offload/api',
        handler: (req, res) => {
          const send = (code, obj) => {
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(obj));
          };
          try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname.replace(/^\/context-offload\/api/, '') || '/';
            if (path === '/ask-ai' && req.method === 'POST') {
              let body = '';
              req.on('data', (c) => {
                body += c;
              });
              req.on('end', () => {
                try {
                  const args = JSON.parse(body || '{}');
                  const rows = Array.isArray(args.rows) ? args.rows : [];
                  if (rows.length === 0) return send(400, { ok: false, error: '没有要裁决的块' });
                  const session = currentSession(ctx);
                  assertSession(session, args.sessionId);
                  const total = rows.reduce((a, c) => a + (Number(c.tokens) || 0), 0);
                  const lines = rows.map(
                    (c, i) =>
                      `  ${i + 1}. ${c.title}（${Math.round((Number(c.tokens) || 0) / 1000)}K，seq ${c.startSeq}..${c.endSeq}）\n     ${c.gist || ''}`,
                  );
                  const text = [
                    `〔待 AI 裁决 · ${rows.length} 块，共约 ${Math.round(total / 1000)}K token〕`,
                    ...lines,
                    '',
                    '这些块用户选择「交给 AI」判断，请逐块评估：',
                    '  · 结论是否已经落到别处（文件 / 回复正文 / 配置）？',
                    '  · 后面还会不会用到原文？',
                    '能剪的，直接调 offload_context(startSeq, endSeq, title)；',
                    '不该剪的，说清理由并保留。判完回一句话给用户。',
                  ].join('\n');
                  const msg = createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { ...PLUGIN_SOURCE, form: 'notice', summary: '待 AI 裁决' },
                  });
                  const appended = session.append('user/message', msg);
                  return send(200, { ok: true, seq: appended && appended.seq ? appended.seq : null });
                } catch (err) {
                  return send(500, { ok: false, error: String(err && err.message ? err.message : err) });
                }
              });
              return;
            }
            if (path === '/apply-pending' && req.method === 'POST') {
              try {
                const cfg = readAutoCfg();
                const p = cfg.pending;
                if (!p || !Array.isArray(p.segments) || p.segments.length === 0) {
                  return send(400, { ok: false, error: '没有待处理的剪切建议' });
                }
                const session = currentSession(ctx);
                assertSession(session, p.sessionId);
                const segs = p.segments.slice().sort((a, b) => b.startSeq - a.startSeq);
                let count = 0;
                let saved = 0;
                for (const s of segs) {
                  try {
                    performOffload(session, Number(s.startSeq), Number(s.endSeq), s.title || '未命名', s.gist || '');
                    count += 1;
                    saved += Number(s.tokens) || 0;
                  } catch {
                    /* 跳过剪不动的 */
                  }
                }
                cfg.pending = null;
                cfg.lastOffloadTurn = turnOf(session);
                cfg.lastOffloadAt = Date.now();
                writeAutoCfg(cfg);
                if (count > 0) {
                  appendHistory({ at: cfg.lastOffloadAt, count, saved, turn: cfg.lastOffloadTurn, segments: segs.slice(0, count) });
                  try {
                    const note = `〔按建议剪切 · 剪了 ${count} 段，省 ${Math.round(saved / 1000)}K〕`;
                    session.append(
                      'user/message',
                      createUserMessage({
                        content: [{ type: 'text', text: note }],
                        source: { ...PLUGIN_SOURCE, form: 'notice', summary: '按建议剪切' },
                      }),
                    );
                  } catch {
                    /* 忽略 */
                  }
                }
                return send(200, { ok: true, count, saved });
              } catch (err) {
                return send(500, { ok: false, error: String(err && err.message ? err.message : err) });
              }
            }
            if (path === '/history') {
              return send(200, { ok: true, history: readHistory() });
            }
            if (path === '/auto') {
              if (req.method === 'GET') {
                return send(200, { ok: true, cfg: readAutoCfg() });
              }
              let body = '';
              req.on('data', (c) => {
                body += c;
              });
              req.on('end', () => {
                try {
                  const patch = JSON.parse(body || '{}');
                  const before = readAutoCfg();
                  const cfg = Object.assign({}, before, patch);
                  // 从「关」切到「开」时，把冷却起点设为当前轮次，
                  // 避免一开启就立刻剪一大片。
                  if ((patch.auto === true || patch.prompt === true) && !before.auto && !before.prompt) {
                    try {
                      const s = currentSession(ctx);
                      cfg.lastOffloadTurn = turnOf(s);
                      cfg.lastOffloadAt = Date.now();
                    } catch {
                      cfg.lastOffloadTurn = 0;
                    }
                  }
                  writeAutoCfg(cfg);
                  return send(200, { ok: true, cfg });
                } catch (err) {
                  return send(500, { ok: false, error: String(err && err.message ? err.message : err) });
                }
              });
              return;
            }
            if (path === '/sessions') {
              return send(200, { ok: true, sessions: listAllSessions() });
            }
            if (path === '/offload' && req.method === 'POST') {
              let body = '';
              req.on('data', (c) => {
                body += c;
              });
              req.on('end', () => {
                try {
                  const args = JSON.parse(body || '{}');
                  const session = currentSession(ctx);
                  assertSession(session, args.sessionId);
                  const s = Number(args.startSeq);
                  const e = Number(args.endSeq);
                  const title = String(args.title || '未命名');
                  const gist = args.gist ? String(args.gist) : '';
                  const nodes = session.surface.nodes;
                  const si = nodes.indexOf(s);
                  const ei = nodes.indexOf(e);
                  if (si === -1 || ei === -1) return send(400, { ok: false, error: 'seq 不在当前表面上' });
                  if (si > ei) return send(400, { ok: false, error: 'startSeq 在 endSeq 之后' });
                  let bal = false;
                  try {
                    bal = toolPairingBalancedBefore(session, s) === true;
                  } catch {
                    bal = false;
                  }
                  if (!bal) return send(400, { ok: false, error: 'seq ' + s + ' 不是安全边界' });
                  const span = nodes.slice(si, ei + 1);
                  const os = s;
                  const oe = e;
                  const text = [
                    `〔已卸下：${title}〕`,
                    gist ? `  └ ${gist}` : null,
                    `  ${span.length} 个节点 · seq ${s}..${e}`,
                    `  origin: ${os}..${oe}`,
                    '  原文仍保留在会话中（界面可见、可随时取消），只是不再发给模型。',
                  ]
                    .filter(Boolean)
                    .join('\n');
                  const message = createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { ...PLUGIN_SOURCE, form: 'notice', summary: title },
                  });
                  const appended = session.append('user/message', message, {
                    surfaceOp: { op: 'replace', startSeq: s, endSeq: e },
                    sourceEventSeqs: span,
                  });
                  return send(200, { ok: true, tombSeq: appended?.seq ?? null, nodes: span.length });
                } catch (err) {
                  return send(500, { ok: false, error: String(err?.message ?? err) });
                }
              });
              return;
            }
            if ((path === '/cancel' || path === '/read') && req.method === 'POST') {
              let body = '';
              req.on('data', (c) => {
                body += c;
              });
              req.on('end', () => {
                try {
                  const args = JSON.parse(body || '{}');
                  const session = currentSession(ctx);
                  assertSession(session, args.sessionId);
                  if (path === '/read' && args.startSeq !== undefined) {
                    const a0 = Number(args.startSeq);
                    const b0 = Number(args.endSeq);
                    if (!Number.isFinite(a0) || !Number.isFinite(b0)) {
                      return send(400, { ok: false, error: '范围不合法' });
                    }
                    const parts0 = [];
                    const seen0 = new Set();
                    const expand0 = (a, b) => {
                      const lo = Math.max(0, Math.min(a, b));
                      const hi = Math.min(1000000, Math.max(a, b));
                      for (let s0 = lo; s0 <= hi; s0 += 1) {
                        if (seen0.has(s0)) continue;
                        seen0.add(s0);
                        const e0 = session.eventAt(s0);
                        if (!e0) continue;
                        let m0 = null;
                        try {
                          m0 = session.deriveEventMessage(e0);
                        } catch {
                          m0 = null;
                        }
                        const t0 = textOf(m0);
                        if (!t0) continue;
                        const in0 = /〔已取回：origin:\s*(\d+)\.\.(\d+)/.exec(t0);
                        if (in0) expand0(Number(in0[1]), Number(in0[2]));
                        else parts0.push(t0);
                      }
                    };
                    expand0(a0, b0);
                    return send(200, { ok: true, text: parts0.join('\n\n'), parts: parts0.length });
                  }
                  const seq = Number(args.tombSeq);
                  const event = session.eventAt(seq);
                  if (!event) return send(404, { ok: false, error: '找不到墓碑 seq ' + seq });
                  if (path === '/cancel' && !session.surface.nodes.includes(seq)) {
                    return send(400, { ok: false, error: '墓碑已不在表面上' });
                  }
                  let tombMessage = null;
                  try {
                    tombMessage = session.deriveEventMessage(event);
                  } catch {
                    tombMessage = null;
                  }
                  const originMatch = /origin:\s*(\d+)\.\.(\d+)/.exec(textOf(tombMessage));
                  let src = [];
                  if (originMatch) {
                    const a = Number(originMatch[1]);
                    const b = Number(originMatch[2]);
                    for (let s = a; s <= b; s += 1) src.push(s);
                  } else {
                    src = event.sourceEventSeqs ?? event.data?.sourceEventSeqs ?? [];
                  }
                  if (!Array.isArray(src) || src.length === 0) {
                    return send(400, { ok: false, error: '该节点不是墓碑（没有 origin / sourceEventSeqs）' });
                  }
                  const parts = [];
                  const seen = new Set();
                  const expand = (a, b) => {
                    const lo = Math.max(0, Math.min(a, b));
                    const hi = Math.min(1000000, Math.max(a, b));
                    for (let s0 = lo; s0 <= hi; s0 += 1) {
                      if (seen.has(s0)) continue;
                      seen.add(s0);
                      const ev = session.eventAt(s0);
                      if (!ev) continue;
                      let m = null;
                      try {
                        m = session.deriveEventMessage(ev);
                      } catch {
                        m = null;
                      }
                      const t = textOf(m);
                      if (!t) continue;
                      const inner = /〔已取回：origin:\s*(\d+)\.\.(\d+)/.exec(t);
                      if (inner) {
                        expand(Number(inner[1]), Number(inner[2]));
                      } else {
                        parts.push(t);
                      }
                    }
                  };
                  for (const s of src) expand(s, s);
                  if (parts.length === 0) return send(400, { ok: false, error: '原文已不在日志中' });
                  const full = parts.join('\n\n');
                  if (path === '/read') {
                    return send(200, { ok: true, text: full, parts: parts.length });
                  }
                  const text = [`〔已取回：origin: ${src[0]}..${src[src.length - 1]}，${parts.length} 段〕`, '', full].join('\n');
                  const message = createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { ...PLUGIN_SOURCE, form: 'notice', summary: '取回上下文' },
                  });
                  const appended = session.append('user/message', message, {
                    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
                    sourceEventSeqs: [seq],
                  });
                  return send(200, { ok: true, seq: appended?.seq ?? null, parts: parts.length });
                } catch (err) {
                  return send(500, { ok: false, error: String(err?.message ?? err) });
                }
              });
              return;
            }
            if (path === '/merge' && req.method === 'POST') {
              let body = '';
              req.on('data', (c) => {
                body += c;
              });
              req.on('end', () => {
                try {
                  const args = JSON.parse(body || '{}');
                  const session = currentSession(ctx);
                  assertSession(session, args.sessionId);
                  const a = Number(args.tombSeqA);
                  const b = Number(args.tombSeqB);
                  const nodes = session.surface.nodes;
                  const ia = nodes.indexOf(a);
                  const ib = nodes.indexOf(b);
                  if (ia < 0 || ib < 0) return send(400, { ok: false, error: '两块都要在表面上' });
                  if (ib !== ia + 1) return send(400, { ok: false, error: '两块不相邻，不能合并' });
                  const tA = textOf(safeMessage(session, a));
                  const tB = textOf(safeMessage(session, b));
                  const oA = /origin:\s*(\d+)\.\.(\d+)/.exec(tA);
                  const oB = /origin:\s*(\d+)\.\.(\d+)/.exec(tB);
                  if (!oA || !oB) return send(400, { ok: false, error: '其中一块不是墓碑' });
                  const nA = /〔已卸下：(.+?)〕/.exec(tA);
                  const nB = /〔已卸下：(.+?)〕/.exec(tB);
                  const os = Math.min(Number(oA[1]), Number(oB[1]));
                  const oe = Math.max(Number(oA[2]), Number(oB[2]));
                  const title = ((nA && nA[1]) || '未命名') + ' + ' + ((nB && nB[1]) || '未命名');
                  const text = [
                    `〔已卸下：${title.slice(0, 36)}〕`,
                    '  └ 由两块合并而来',
                    `  origin: ${os}..${oe}`,
                    '  原文仍保留在会话中（界面可见、可随时取消），只是不再发给模型。',
                  ].join('\n');
                  const message = createUserMessage({
                    content: [{ type: 'text', text }],
                    source: { ...PLUGIN_SOURCE, form: 'notice', summary: title.slice(0, 36) },
                  });
                  const appended = session.append('user/message', message, {
                    surfaceOp: { op: 'replace', startSeq: a, endSeq: b },
                    sourceEventSeqs: [a, b],
                  });
                  return send(200, { ok: true, tombSeq: appended?.seq ?? null });
                } catch (err) {
                  return send(500, { ok: false, error: String(err?.message ?? err) });
                }
              });
              return;
            }
            if (path === '/state' || path === '/') {
              let session = null;
              try {
                session = currentSession(ctx);
              } catch {
                session = null;
              }
              const nodes = session?.surface?.nodes ?? [];
              const href = url.searchParams.get('href') || '';
              const wantId = url.searchParams.get('sessionId') || '';
              if (wantId && (!session || session.id !== wantId)) {
                const meta = listAllSessions().find((s) => s.id === wantId);
                if (!meta) return send(404, { ok: false, error: '找不到会话 ' + wantId });
                const rebuilt = loadSurfaceFromFile(meta);
                // rebuilt 现在自带 stats（解压一次顺带算完），不再另外调 analyzeSessionFile
                const info = rebuilt.error ? analyzeSessionFile(meta) : rebuilt;
                const cands = rebuilt.shim ? listCandidates(rebuilt.shim) : [];
                const offs = rebuilt.shim ? listOffloaded(rebuilt.shim) : [];
                const offSum = offs.reduce((a, o) => a + (o.tokens || 0), 0);
                return send(200, {
                  ok: true,
                  href,
                  nodeCount: rebuilt.surfaceNodes || 0,
                  sessionId: wantId,
                  sessionTitle: meta.title,
                  readOnly: true,
                  note: rebuilt.error ? '其他会话（重建失败：' + rebuilt.error + '）' : '其他会话（只读分析，剪不了）',
                  stats: {
                    used: info.tokens || (info.chars ? Math.round(info.chars / 3) : 0),
                    total: 1000000,
                    offloaded: offSum,
                    blocks: 0,
                    compressed: 0,
                    savedByCompress: 0,
                  },
                  candidates: cands,
                  offloaded: offs,
                  summary: info,
                });
              }
              const candidates = session ? listCandidates(session) : [];
              const offloaded = session ? listOffloaded(session) : [];
              let totalChars = 0;
              for (const seq of nodes) {
                totalChars += textOf(safeMessage(session, seq)).length;
              }
              const used = Math.round(totalChars / 2.5);
              const savedTokens = offloaded.reduce((s, o) => s + (o.tokens || 0), 0);
              return send(200, {
                ok: true,
                href,
                nodeCount: nodes.length,
                sessionId: session?.id ?? null,
                note: session ? '真数据' : '未取到会话（先发一条消息再刷新）',
                stats: {
                  used,
                  total: 1000000,
                  offloaded: savedTokens,
                  blocks: offloaded.length,
                  compressed: 0,
                  savedByCompress: 0,
                },
                candidates,
                offloaded,
              });
            }
            return send(404, { ok: false, error: 'unknown path: ' + path });
          } catch (e) {
            return send(500, { ok: false, error: String(e?.message ?? e) });
          }
        },
      });
      return () => {
        if (typeof off === 'function') off();
      };
    });
  }
}
