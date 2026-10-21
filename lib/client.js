window.__ModuleLoader__.load({
  id: "dsh-context-offload",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    // 右键菜单要挂到 body：设置页容器上若有 transform / zoom（DSH 支持界面缩放），
    // position:fixed 会按那个祖先的缩放比走，于是菜单"按比例"偏到别处、点不着。
    // 挂到 document.body 才是真正的视口坐标。拿不到 react-dom 就退回原地渲染。
    let __createPortal = null;
    try {
      const RD = require("react-dom");
      if (RD && typeof RD.createPortal === "function") __createPortal = RD.createPortal;
    } catch (e) {
      __createPortal = null;
    }

    // ---------------- 主题 ----------------
    const C = {
      text: "#e6e9ef",
      dim: "rgba(230,233,239,.62)",
      faint: "rgba(230,233,239,.40)",
      line: "rgba(255,255,255,.07)",
      card: "rgba(255,255,255,.028)",
      accent: "#4c8dff",
      green: "#3fbf6f",
      red: "#ff6b6b",
    };

    const cardStyle = {
      marginTop: 14,
      padding: "14px 16px",
      border: "1px solid " + C.line,
      borderRadius: 10,
      background: C.card,
    };

    const btnStyle = {
      display: "inline-flex",
      alignItems: "center",
      height: 26,
      padding: "0 10px",
      border: "1px solid " + C.line,
      borderRadius: 6,
      background: "rgba(255,255,255,.04)",
      color: C.text,
      fontSize: 12,
      cursor: "pointer",
      userSelect: "none",
    };

    function Btn(props) {
      const s = Object.assign(
        {},
        btnStyle,
        props.primary ? { background: "rgba(76,141,255,.16)", borderColor: "rgba(76,141,255,.45)" } : null,
        props.green ? { background: "rgba(63,191,111,.16)", borderColor: "rgba(63,191,111,.45)" } : null,
        props.disabled ? { opacity: 0.38, cursor: "default" } : null,
        props.style
      );
      return h("span", { style: s, onClick: props.disabled ? undefined : props.onClick }, props.children);
    }

    // ---------------- 兜底（接口异常时的空壳） ----------------
    const DEMO = {
      stats: { used: 0, total: 0, offloaded: 0, blocks: 0, compressed: 0, savedByCompress: 0 },
      candidates: [],
      offloaded: [],
    };

    const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n));

    // ---------------- 占用条 ----------------
    function StatBar(props) {
      const total = props.total || 1;
      const usedPct = Math.min(100, (props.used / total) * 100);
      const offPct = Math.min(100 - usedPct, (props.offloaded / total) * 100);
      return h(
        "div",
        null,
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 } },
          h("span", { style: { fontSize: 13, fontWeight: 600 } }, "本会话")
        ),
        h(
          "div",
          { style: { position: "relative", height: 8, borderRadius: 4, background: "rgba(255,255,255,.06)", overflow: "hidden" } },
          h("div", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: usedPct + "%", background: C.accent } }),
          h("div", { style: { position: "absolute", left: usedPct + "%", top: 0, bottom: 0, width: offPct + "%", background: "rgba(76,141,255,.34)" } })
        ),
        h(
          "div",
          { style: { marginTop: 8, color: C.dim, fontSize: 12 } },
          "上下文 " + fmtK(props.used) + " / " + fmtK(props.total) + "（" + usedPct.toFixed(0) + "%）" +
            " · 其中已剪 " + fmtK(props.offloaded) +
            " · 剪切 " + props.blocks + " 段" +
            " · 压缩 " + props.compressed + " 块（省 " + fmtK(props.savedByCompress) + "）"
        )
      );
    }

    // ---------------- 候选行 ----------------
    function CandRow(props) {
      const c = props.item;
      const on = props.selected;
      const [open, setOpen] = React.useState(false);
      return h(
        "div",
        {
          style: Object.assign({}, cardStyle, {
            marginTop: 8,
            padding: "11px 13px",
            background: on ? "rgba(76,141,255,.055)" : "transparent",
            borderColor: on ? "rgba(76,141,255,.38)" : C.line,
            cursor: "pointer",
          }),
          onClick: () => props.onOpen && props.onOpen(c),
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "flex-start", gap: 10 } },
          h(
            "div",
            {
              onClick: (e) => {
                if (e && e.stopPropagation) e.stopPropagation();
                props.onToggle();
              },
              style: {
                flex: "none", width: 16, height: 16, marginTop: 1, borderRadius: 4, cursor: "pointer",
                border: "1.5px solid " + (on ? C.accent : "rgba(255,255,255,.22)"),
                background: on ? C.accent : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 11, lineHeight: 1,
              },
            },
            on ? "✓" : ""
          ),
          h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, c.title),
            h("div", { style: { marginTop: 3, color: C.dim, fontSize: 12, lineHeight: 1.6 } }, c.gist),
            h(
              "div",
              { style: { marginTop: 5, color: C.faint, fontSize: 11.5, display: "flex", gap: 10, alignItems: "center" } },
              h("span", null, c.date),
              h("span", null, fmtK(c.tokens)),
              h("span", { style: { cursor: "pointer", color: C.dim }, onClick: () => setOpen(!open) }, open ? "▾ 判断依据" : "▸ 判断依据"),
              props.act === "drop" ? h("span", { style: { color: C.red } }, "· 去掉") : null,
              props.act === "keep" ? h("span", { style: { color: C.green } }, "· 保留") : null,
              props.act === "ai" ? h("span", { style: { color: C.accent } }, "· 交给 AI") : null
            ),
            open
              ? h(
                  "div",
                  { style: { marginTop: 8, padding: "9px 11px", borderLeft: "2px solid rgba(76,141,255,.45)", background: "rgba(76,141,255,.05)", borderRadius: 4, color: C.dim, fontSize: 12, lineHeight: 1.8 } },
                  (c.reasons && c.reasons.length
                    ? c.reasons
                    : ["按大小排在前面，但没有额外线索，建议先看一眼原文再决定"]
                  ).map((r, i) => h("div", { key: i }, "· " + r))
                )
              : null
          )
        )
      );
    }

    function aliasOf(tombSeq) {
      try {
        const m = JSON.parse(window.localStorage.getItem("ctxOffloadAlias") || "{}");
        return m[tombSeq] || "";
      } catch {
        return "";
      }
    }

    // ---------------- 已剪行 ----------------
    function OffRow(props) {
      const o = props.item;
      const shown = aliasOf(o.tombSeq) || o.title;
      return h(
        "div",
        {
          style: Object.assign({}, cardStyle, { marginTop: 8, padding: "10px 13px", cursor: "pointer" }),
          onClick: () => props.onOpen && props.onOpen(o),
          onContextMenu: (e) => {
            e.preventDefault();
            if (props.onMenu) props.onMenu(e, o);
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 10 } },
          h(
            "div",
            { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: 13, fontWeight: 600 } }, shown),
            h("div", { style: { marginTop: 3, color: C.dim, fontSize: 12, lineHeight: 1.6 } }, o.gist),
            h("div", { style: { marginTop: 5, color: C.faint, fontSize: 11.5 } }, o.date + " · " + fmtK(o.tokens) + " · 已剪")
          ),
          h(
            "span",
            { style: { flex: "none", padding: "2px 7px", borderRadius: 20, fontSize: 11, background: "rgba(63,191,111,.14)", color: C.green, border: "1px solid rgba(63,191,111,.35)" } },
            "已剪"
          )
        )
      );
    }

    // ---------------- 主页面 ----------------
    function Page() {
      const [remote, setRemote] = React.useState(null);
      const [err, setErr] = React.useState(null);
      const [enabled, setEnabled] = React.useState(true);
      const [sel, setSel] = React.useState(new Set());
      const [q, setQ] = React.useState("");
      const [sessions, setSessions] = React.useState([]);
      const [picked, setPicked] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [again, setAgain] = React.useState(0);
      const [menu, setMenu] = React.useState(null);
      const [note, setNote] = React.useState("");
      const [act, setAct] = React.useState({});
      const [drawer, setDrawer] = React.useState(null);
      const [auto, setAuto] = React.useState(null);
      const [history, setHistory] = React.useState([]);
      const [openHist, setOpenHist] = React.useState({});

      React.useEffect(() => {
        let alive = true;
        fetch("/context-offload/api/sessions")
          .then((r) => r.json())
          .then((j) => {
            if (alive && j && j.ok) setSessions(j.sessions || []);
          })
          .catch(() => {});
        fetch("/context-offload/api/auto")
          .then((r) => r.json())
          .then((j) => {
            if (alive && j && j.ok) setAuto(j.cfg);
          })
          .catch(() => {});
        fetch("/context-offload/api/history")
          .then((r) => r.json())
          .then((j) => {
            if (alive && j && j.ok) setHistory(Array.isArray(j.history) ? j.history : []);
          })
          .catch(() => {});
        const here = (typeof location !== "undefined" && location.href) || "";
        fetch("/context-offload/api/state?href=" + encodeURIComponent(here) + "&sessionId=" + encodeURIComponent(picked), { headers: { accept: "application/json" } })
          .then((r) => r.text())
          .then((raw) => {
            let j;
            try {
              j = JSON.parse(raw);
            } catch {
              throw new Error("接口返回的不是 JSON：" + String(raw).slice(0, 80));
            }
            if (!alive) return;
            if (j && j.ok) setRemote(j);
            else setErr((j && j.error) || "接口返回异常");
          })
          .catch((e) => {
            if (alive) setErr(String(e && e.message ? e.message : e));
          });
        return () => {
          alive = false;
        };
      }, [picked, again]);

      const stats = (remote && remote.stats) || DEMO.stats;
      // 切到别的会话时只能看不能剪：seq 是会话内编号，跨会话剪会拿错号
      // 优先用后端给的 readOnly 标记，note 文案只作兜底（改字就失效）
      const isOther = !!(remote && (remote.readOnly === true || (remote.note && String(remote.note).indexOf("其他会话") >= 0)));
      const candidates = (remote && remote.candidates) || DEMO.candidates;
      const offloadedList = (remote && remote.offloaded) || DEMO.offloaded;

      const toggle = (id) => {
        const next = new Set(sel);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSel(next);
      };
      const allSel = candidates.length > 0 && sel.size === candidates.length;
      const toggleAll = () => setSel(allSel ? new Set() : new Set(candidates.map((c) => c.id)));
      const mark = (kind) => {
        if (sel.size === 0) return;
        const next = Object.assign({}, act);
        for (const id of sel) next[id] = kind;
        setAct(next);
        const label = kind === "drop" ? "去掉" : kind === "keep" ? "保留" : "交给 AI";
        setNote("已把勾选的 " + sel.size + " 块标记为「" + label + "」");
      };

      const doOffload = async () => {
        const rows = candidates.filter((c) => sel.has(c.id) && act[c.id] !== "keep");
        if (rows.length === 0) {
          setNote("勾选里没有要剪的（标成「保留」的不会剪）");
          return;
        }
        const dropRows = rows.filter((c) => act[c.id] !== "ai");
        const aiRows = rows.filter((c) => act[c.id] === "ai");
        setBusy(true);
        setErr(null);
        try {
          let done = 0;
          for (const c of dropRows) {
            const r = await fetch("/context-offload/api/offload", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                sessionId: picked,
                startSeq: c.startSeq,
                endSeq: c.endSeq,
                title: c.title,
                gist: c.gist,
              }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || "剪切失败");
            done += 1;
          }
          if (aiRows.length > 0) {
            const r = await fetch("/context-offload/api/ask-ai", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: picked, rows: aiRows }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || "提交裁决失败");
            setNote("已剪 " + done + " 段；" + aiRows.length + " 段已交给 AI 裁决，下一条消息里我会逐块判断");
          } else {
            setNote("已剪 " + done + " 段");
          }
          setSel(new Set());
          setAct({});
          setAgain((x) => x + 1);
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const doCancel = async (item) => {
        setMenu(null);
        setNote("正在取回…");
        try {
          const r = await fetch("/context-offload/api/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: picked, tombSeq: item.tombSeq }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "取回失败");
          setNote("已取回 " + (j.parts || 0) + " 段");
          setAgain((x) => x + 1);
        } catch (e) {
          setNote("取回失败：" + String((e && e.message) || e));
        }
      };

      const readTomb = async (item) => {
        const r = await fetch("/context-offload/api/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: picked, tombSeq: item.tombSeq }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "读取失败");
        return String(j.text || "");
      };

      const readAlias = () => {
        try {
          return JSON.parse(window.localStorage.getItem("ctxOffloadAlias") || "{}");
        } catch {
          return {};
        }
      };

      const doRename = (item) => {
        setMenu(null);
        const cur = readAlias()[item.tombSeq] || item.title;
        const next = window.prompt("给这块起个名字", cur);
        if (next === null) return;
        const name = String(next).trim();
        if (name === "") return;
        const map = readAlias();
        map[item.tombSeq] = name;
        try {
          window.localStorage.setItem("ctxOffloadAlias", JSON.stringify(map));
        } catch {}
        setNote("已改名为「" + name + "」");
        setAgain((x) => x + 1);
      };


      const openDrawer = async (item) => {
        setDrawer({ title: item.title, text: "", loading: true });
        try {
          const body =
            item.tombSeq !== undefined && item.tombSeq !== null
              ? { tombSeq: item.tombSeq }
              : { startSeq: item.startSeq, endSeq: item.endSeq };
          const r = await fetch("/context-offload/api/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(Object.assign({ sessionId: picked }, body)),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "读取失败");
          setDrawer({ title: item.title, text: String(j.text || ""), loading: false });
        } catch (e) {
          setDrawer({ title: item.title, text: "读取失败：" + String((e && e.message) || e), loading: false });
        }
      };

      const doCopy = async (item) => {
        setMenu(null);
        setNote("正在读取…");
        try {
          const text = await readTomb(item);
          await navigator.clipboard.writeText(text);
          setNote("已复制 " + text.length + " 字符");
        } catch (e) {
          setNote("复制失败：" + String((e && e.message) || e));
        }
      };

      const doExport = async (item) => {
        setMenu(null);
        setNote("正在读取…");
        try {
          const text = await readTomb(item);
          const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = String(item.title || "context").replace(/[\\/:*?"<>|]/g, "_") + ".md";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
          setNote("已导出 " + text.length + " 字符");
        } catch (e) {
          setNote("导出失败：" + String((e && e.message) || e));
        }
      };

      const doMerge = async (item) => {
        setMenu(null);
        const idx = offloadedList.findIndex((o) => o.tombSeq === item.tombSeq);
        if (idx <= 0) {
          setNote("上面没有可合并的块");
          return;
        }
        const prev = offloadedList[idx - 1];
        if (!window.confirm("把「" + item.title + "」合并到「" + prev.title + "」？\n\n注意：合并后无法拆开，只能整块「取消剪切」再重剪。")) return;
        setNote("合并中…");
        try {
          const r = await fetch("/context-offload/api/merge", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: picked, tombSeqA: prev.tombSeq, tombSeqB: item.tombSeq }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "合并失败");
          setNote("已合并");
          setAgain((x) => x + 1);
        } catch (e) {
          setNote("合并失败：" + String((e && e.message) || e));
        }
      };

      const doCancelAll = async () => {
        if (offloadedList.length === 0) return;
        if (!window.confirm("确定把这 " + offloadedList.length + " 块全部取回吗？")) return;
        setBusy(true);
        setErr(null);
        try {
          let done = 0;
          for (const o of offloadedList) {
            const r = await fetch("/context-offload/api/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: picked, tombSeq: o.tombSeq }),
            });
            const j = await r.json();
            if (j && j.ok) done += 1;
          }
          setNote("已取回 " + done + " 块");
          setAgain((x) => x + 1);
        } catch (e) {
          setNote("取回失败：" + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const setAutoMode = async (mode) => {
        const patch =
          mode === "auto"
            ? { auto: true, prompt: false }
            : mode === "prompt"
              ? { auto: false, prompt: true }
              : { auto: false, prompt: false };
        setAuto((a) => Object.assign({}, a || { cooldownTurns: 10 }, patch));
        try {
          const r = await fetch("/context-offload/api/auto", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const j = await r.json();
          if (j && j.ok) setAuto(j.cfg);
          setNote(mode === "auto" ? "已切到自动：到点自己剪" : mode === "prompt" ? "已切到提示：到点会先问您" : "已切到手动：只有点按钮才剪");
        } catch (e) {
          setNote("设置失败：" + String((e && e.message) || e));
        }
      };

      const setAutoCfg = async (patch) => {
        setAuto((a) => Object.assign({}, a || {}, patch));
        try {
          const r = await fetch("/context-offload/api/auto", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const j = await r.json();
          if (j && j.ok) setAuto(j.cfg);
        } catch (e) {
          setNote("保存失败：" + String((e && e.message) || e));
        }
      };

      const applyPending = async () => {
        setBusy(true);
        try {
          const r = await fetch("/context-offload/api/apply-pending", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "失败");
          setNote("已按建议剪了 " + j.count + " 段，省 " + Math.round((j.saved || 0) / 1000) + "K");
          setAgain((x) => x + 1);
          fetch("/context-offload/api/auto").then((r2) => r2.json()).then((j2) => { if (j2 && j2.ok) setAuto(j2.cfg); }).catch(() => {});
          fetch("/context-offload/api/history").then((r2) => r2.json()).then((j2) => { if (j2 && j2.ok) setHistory(j2.history || []); }).catch(() => {});
        } catch (e) {
          setNote("失败：" + String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const filtered = offloadedList.filter((o) => !q || o.title.indexOf(q) >= 0 || o.gist.indexOf(q) >= 0);
      const n = sel.size;

      return h(
        "div",
        { style: { padding: "18px 22px 44px", maxWidth: 900, color: C.text, fontSize: 13 } },

        h(
          "div",
          { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 } },
          h(
            "div",
            null,
            h("h2", { style: { margin: "0 0 5px", fontSize: 17, fontWeight: 600 } }, "上下文剪切"),
            h("p", { style: { margin: 0, color: C.dim, fontSize: 12.5, lineHeight: 1.7, maxWidth: 580 } }, "把已经完成的工作剪下来存在本地，不再上传到模型。会话里照样看得见，随时能取回。")
          ),
          h(Btn, null, "在上下文洞察里查看压缩 →")
        ),

        h(
          "div",
          { style: { marginTop: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 12, color: C.dim } }, "会话"),
          h(
            "select",
            {
              value: picked,
              onChange: (e) => setPicked(e.target.value),
              style: {
                height: 28, padding: "0 8px", borderRadius: 6, maxWidth: 380,
                border: "1px solid " + C.line, background: "rgba(0,0,0,.22)",
                color: C.text, fontSize: 12.5, outline: "none",
              },
            },
            h("option", { value: "" }, "（当前活跃会话）"),
            sessions.map((s) =>
              h("option", { key: s.id, value: s.id }, s.title + " · " + fmtK(Math.round(s.size / 1024)) + " KB")
            )
          ),
          picked
            ? h("span", { style: { fontSize: 11.5, color: C.faint } }, "（其他会话的详情还没接，先只看当前会话）")
            : null
        ),

        err
          ? h("div", { style: { marginTop: 12, padding: "9px 12px", borderRadius: 8, border: "1px solid rgba(255,107,107,.4)", background: "rgba(255,107,107,.08)", color: C.red, fontSize: 12 } }, "接口异常：" + err)
          : null,

        auto && auto.pending
          ? h(
              "div",
              {
                style: {
                  marginTop: 12, padding: "10px 12px", borderRadius: 8,
                  border: "1px solid rgba(76,141,255,.42)", background: "rgba(76,141,255,.08)",
                  display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                },
              },
              h(
                "div",
                { style: { flex: 1, fontSize: 12.5, color: C.text } },
                "可以剪了：共 " + (auto.pending.count || 0) + " 块，约 " +
                  Math.round((auto.pending.tokens || 0) / 1000) + "K token"
              ),
              h(Btn, { green: true, disabled: busy, onClick: applyPending }, busy ? "剪切中…" : "现在剪"),
              h(Btn, { disabled: busy, onClick: () => setAutoCfg({ pending: null }) }, "忽略")
            )
          : null,

        !remote && !err
          ? h("div", { style: { marginTop: 12, color: C.faint, fontSize: 12 } }, "正在读取……")
          : null,

        h(
          "div",
          Object.assign({}, cardStyle, { display: "flex", alignItems: "center", gap: 12 }),
          h(
            "div",
            { style: { flex: 1 } },
            h(
              "div",
              { style: { fontSize: 13, fontWeight: 600 } },
              "启用上下文剪切",
              h("span", { style: { marginLeft: 8, padding: "1px 6px", borderRadius: 4, fontSize: 11, background: "rgba(255,255,255,.07)", color: C.dim } }, "本会话")
            ),
            h("div", { style: { marginTop: 4, color: C.faint, fontSize: 11.5 } }, "关掉后已剪的块会自动放回，上下文恢复正常")
          ),
          h(
            "div",
            {
              onClick: () => setEnabled(!enabled),
              style: {
                flex: "none", width: 38, height: 21, borderRadius: 11, cursor: "pointer", position: "relative",
                background: enabled ? C.accent : "rgba(255,255,255,.14)", transition: "background .15s",
              },
            },
            h("div", { style: { position: "absolute", top: 2, left: enabled ? 19 : 2, width: 17, height: 17, borderRadius: "50%", background: "#fff", transition: "left .15s" } })
          )
        ),

        h(
          "div",
          cardStyle,
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 10 } },
            h("div", { style: { flex: 1 } },
              h("div", { style: { fontSize: 13, fontWeight: 600 } }, "自动模式"),
              h("div", { style: { marginTop: 4, color: C.faint, fontSize: 11.5 } },
                auto && auto.auto
                  ? "每隔 " + (auto.cooldownTurns || 10) + " 轮自动剪一次（保留最近 2 轮；有记忆/情感字样的段永不剪）"
                  : auto && auto.prompt
                    ? "到点先问您一句，您点头才剪（保留最近 2 轮；有记忆/情感字样的段永不剪）"
                    : "只有点「执行剪切」才会剪，不会自己动手")
            ),
            h(Btn, { primary: !(auto && (auto.auto || auto.prompt)), onClick: () => setAutoMode("manual") }, "手动"),
            h(Btn, { primary: !!(auto && auto.prompt && !auto.auto), onClick: () => setAutoMode("prompt") }, "提示"),
            h(Btn, { primary: !!(auto && auto.auto), onClick: () => setAutoMode("auto") }, "自动")
          ),
          h("div", { style: { marginTop: 6, color: C.faint, fontSize: 11 } },
            "上次自动剪切：" + (auto && auto.lastOffloadAt ? new Date(auto.lastOffloadAt).toLocaleString("zh-CN") : "还没有过")
          ),
          h(
            "div",
            { style: { marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 11.5, color: C.dim } },
            h("span", null, "冷却"),
            h("input", {
              type: "number", min: 1, max: 200,
              value: (auto && auto.cooldownTurns) || 10,
              onChange: (e) => setAutoCfg({ cooldownTurns: Math.max(1, Number(e.target.value) || 10) }),
              style: { width: 64, height: 26, padding: "0 8px", borderRadius: 6, border: "1px solid " + C.line, background: "rgba(0,0,0,.22)", color: C.text, fontSize: 12, outline: "none" },
            }),
            h("span", null, "轮"),
            h("span", { style: { marginLeft: 10 } }, "门槛"),
            h("input", {
              type: "number", min: 1000, step: 1000,
              value: (auto && auto.minTokens) || 20000,
              onChange: (e) => setAutoCfg({ minTokens: Math.max(1000, Number(e.target.value) || 20000) }),
              style: { width: 88, height: 26, padding: "0 8px", borderRadius: 6, border: "1px solid " + C.line, background: "rgba(0,0,0,.22)", color: C.text, fontSize: 12, outline: "none" },
            }),
            h("span", null, "token")
          ),
          h(
            "div",
            { style: { marginTop: 10, borderTop: "1px solid " + C.line, paddingTop: 8 } },
            h("div", { style: { fontSize: 11.5, color: C.dim, marginBottom: 6 } }, "自动剪切记录"),
            history.length === 0
              ? h("div", { style: { fontSize: 11, color: C.faint } }, "还没有记录（自动剪过一次后这里就会出现）")
              : history.slice(0, 8).map((r, i) => {
                  const d = new Date(r.at);
                  const key = String(r.at) + "-" + i;
                  const open = !!openHist[key];
                  return h(
                    "div",
                    { key, style: { marginTop: 4 } },
                    h(
                      "div",
                      {
                        onClick: () => setOpenHist((m) => Object.assign({}, m, { [key]: !open })),
                        style: { display: "flex", gap: 8, alignItems: "center", cursor: "pointer", fontSize: 11.5, color: C.dim },
                      },
                      h("span", null, d.getMonth() + 1 + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0")),
                      h("span", null, "剪了 " + r.count + " 段"),
                      h("span", { style: { color: C.green } }, "省 " + Math.round((r.saved || 0) / 1000) + "K"),
                      h("span", { style: { color: C.faint } }, open ? "▾" : "▸")
                    ),
                    open && Array.isArray(r.segments)
                      ? h(
                          "div",
                          { style: { marginTop: 4, paddingLeft: 10, borderLeft: "2px solid rgba(76,141,255,.35)", fontSize: 11, color: C.faint, lineHeight: 1.7 } },
                          r.segments.map((s, j) => h("div", { key: j }, "· " + (s.title || "") + (s.gist ? " — " + s.gist : "")))
                        )
                      : null
                  );
                })
          )
        ),

        h(
          "div",
          cardStyle,
          h(StatBar, {
            used: stats.used, total: stats.total, offloaded: stats.offloaded,
            blocks: stats.blocks, compressed: stats.compressed, savedByCompress: stats.savedByCompress,
          })
        ),

        h(
          "div",
          cardStyle,
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            h("div", { style: { flex: 1, fontSize: 13, fontWeight: 600 } }, "可剪的工作"),
            h(Btn, { onClick: toggleAll }, allSel ? "取消全选" : "全选"),
            h(Btn, { disabled: n === 0, onClick: () => mark("drop") }, "去掉 (" + n + ")"),
            h(Btn, { disabled: n === 0, onClick: () => mark("keep") }, "保留 (" + n + ")"),
            h(Btn, { disabled: n === 0, onClick: () => mark("ai") }, "交给 AI (" + n + ")"),
            h(Btn, { green: true, disabled: n === 0 || busy || !enabled || isOther, onClick: doOffload }, busy ? "剪切中…" : isOther ? "只能在当前会话剪" : "执行剪切")
          ),
          h("div", { style: { marginTop: 4, color: C.faint, fontSize: 11.5 } }, enabled ? "先勾选要处理的块，再点上面的按钮；没勾的不动" : "已关闭，不会执行剪切；已剪的块仍可右键取回"),
          candidates.length === 0
            ? h("div", { style: { marginTop: 14, color: C.faint, fontSize: 12, textAlign: "center" } }, "暂时没有可剪的块")
            : candidates.map((c) =>
                h(CandRow, { key: c.id, item: c, selected: sel.has(c.id), onToggle: () => toggle(c.id), act: act[c.id], onOpen: openDrawer })
              )
        ),

        h(
          "div",
          cardStyle,
          h(
            "div",
            { style: { display: "flex", alignItems: "center", gap: 8 } },
            h(
              "div",
              { style: { flex: 1, fontSize: 13, fontWeight: 600 } },
              "已剪的块",
              h("span", { style: { marginLeft: 8, padding: "1px 6px", borderRadius: 4, fontSize: 11, background: "rgba(255,255,255,.07)", color: C.dim } }, offloadedList.length)
            ),
            h(Btn, { disabled: busy || offloadedList.length === 0, onClick: doCancelAll }, "撤销全部")
          ),
          h(
            "div",
            { style: { marginTop: 9 } },
            h("input", {
              value: q,
              onChange: (e) => setQ(e.target.value),
              placeholder: "搜索已剪的块……",
              style: {
                width: "100%", boxSizing: "border-box", height: 30, padding: "0 10px",
                borderRadius: 6, border: "1px solid " + C.line, background: "rgba(0,0,0,.22)",
                color: C.text, fontSize: 12.5, outline: "none",
              },
            })
          ),
          filtered.length === 0
            ? h("div", { style: { marginTop: 14, color: C.faint, fontSize: 12, textAlign: "center" } }, "还没有剪过")
            : filtered.map((o) =>
                h(OffRow, {
                  key: o.id,
                  item: o,
                  onOpen: openDrawer,
                  onMenu: (e, item) => {
                    setMenu({ x: e.clientX, y: e.clientY, item });
                  },
                })
              )
        ),

        note
          ? h("div", { style: { marginTop: 10, color: C.dim, fontSize: 12 } }, note)
          : null,

        menu
          ? (() => {
              const menuEl = h(
                "div",
                {
                  style: {
                    position: "fixed",
                    left: Math.max(8, Math.min(menu.x, (window.innerWidth || 1200) - 216)),
                    top: Math.max(8, Math.min(menu.y, (window.innerHeight || 800) - 268)),
                    zIndex: 9999,
                    minWidth: 168, padding: 5, borderRadius: 9,
                    background: "#1a1e26", border: "1px solid #2c333e",
                    boxShadow: "0 14px 40px rgba(0,0,0,.55)",
                  },
                  onContextMenu: (e) => e.preventDefault(),
                  onMouseLeave: () => setMenu(null),
                },
                [
                  { label: "命名\u2026", onClick: () => doRename(menu.item) },
                  { label: "复制全文", onClick: () => doCopy(menu.item) },
                  { label: "导出为 .md", onClick: () => doExport(menu.item) },
                  { label: "合并到上一块", onClick: () => doMerge(menu.item) },
                  { label: "取消剪切", red: true, onClick: () => doCancel(menu.item) },
                ].map((it) =>
                  h(
                    "div",
                    {
                      key: it.label,
                      onClick: it.onClick,
                      style: {
                        padding: "7px 10px", borderRadius: 6, fontSize: 12.5, cursor: "pointer",
                        color: it.red ? C.red : it.dim ? C.faint : C.text,
                      },
                      onMouseEnter: (e) => { e.currentTarget.style.background = "rgba(255,255,255,.06)"; },
                      onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
                    },
                    it.label
                  )
                )
              );
              return __createPortal ? __createPortal(menuEl, document.body) : menuEl;
            })()
          : null,

        drawer
          ? h(
              "div",
              {
                style: {
                  position: "fixed", top: 0, right: 0, bottom: 0, width: "min(560px, 46vw)", zIndex: 10000,
                  background: "#141821", borderLeft: "1px solid #2c333e",
                  boxShadow: "-12px 0 40px rgba(0,0,0,.5)",
                  display: "flex", flexDirection: "column",
                },
              },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid #2c333e", flex: "none" } },
                h("div", { style: { flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, drawer.title),
                drawer.loading ? h("span", { style: { color: C.faint, fontSize: 11.5 } }, "读取中…") : null,
                h(
                  "span",
                  { onClick: () => setDrawer(null), style: { cursor: "pointer", color: C.dim, fontSize: 15, lineHeight: 1, padding: "2px 4px" } },
                  "✕"
                )
              ),
              h(
                "div",
                { style: { flex: 1, overflow: "auto", padding: "12px 16px", fontSize: 12, lineHeight: 1.75, color: C.dim, whiteSpace: "pre-wrap", wordBreak: "break-word" } },
                drawer.text || (drawer.loading ? "" : "（空）")
              )
            )
          : null,

        h(
          "div",
          { style: { marginTop: 16, color: C.faint, fontSize: 11.5, lineHeight: 1.8 } },
          remote
            ? "接口已连通（sessionId: " + (remote.sessionId || "?") + "，表面节点 " + (remote.nodeCount || 0) + " 个）。数据仍为演示值，下一步接真实候选。"
            : "正在连接后端接口……"
        )
      );
    }

    module.exports = {
      name: "context-offload-ui",
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "context-offload", order: 110, label: () => "上下文剪切" },
            Page
          )
        );
      },
    };

    return module.exports;
  },
});
