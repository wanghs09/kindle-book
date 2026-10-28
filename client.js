/**
 * Browser half of the Kindle 编书 bundle.
 *
 * Registers one sidebar entry plus the page it selects, then runs the bundled
 * book builder through the host's three `/kindle-book/*` routes. The page owns
 * only form state and rendering: every article fetch, EPUB write, and download
 * happens on the host.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-kindle-book",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Dictionary namespace; the meta entry lives in this package's locale/*.json. */
    const NS = "kindle-book";
    /** Sidebar entry id, also the `main` keyed-slot key of the page. */
    const PANEL_ID = "kindle-book";
    /** Route base served by the host half. */
    const BASE = "/kindle-book";
    /** Draft fields survive reloads in the browser only. */
    const DRAFT_KEY = "kindle-book:draft";

    const zh = {
      panel: "Kindle 编书",
      title: "Kindle 编书",
      intro: "把网页抓成纯净正文，打包成 EPUB / AZW3。每条链接一行，用 `|` 可以单独指定该章标题。",
      urlsLabel: "文章链接",
      urlsPlaceholder:
        "https://mp.weixin.qq.com/s/xxxxx\nhttps://www.chinanews.com.cn/cj/2026/10-27/10721502.shtml | 统计局：工业利润\n# 井号开头是注释",
      urlsHint: "一次最多 {max} 条",
      titleLabel: "书名",
      titlePlaceholder: "新闻摘编 {date}",
      outDirLabel: "输出目录",
      outDirHint: "生成后按书名建子文件夹",
      azw3Label: "同时生成 AZW3（需要 calibre）",
      coverLabel: "生成封面",
      submit: "生成",
      submitting: "生成中…",
      elapsed: "已用 {s} 秒",
      envMissing: "环境检查未通过：",
      resultTitle: "生成结果",
      resultMeta: "{formats} · {ms} 秒 · {dir}",
      download: "下载",
      coverName: "封面",
      failedTitle: "没抓到的链接",
      warningsTitle: "提示",
      logTitle: "详细日志",
      logShow: "展开",
      logHide: "收起",
      retry: "重新生成",
      needUrls: "先贴至少一条 http(s) 链接。",
      networkError: "请求失败：{message}",
      loadingEnv: "正在检查本机环境…",
      draftRestored: "已恢复上次填写的内容。",
    };

    const en = {
      panel: "Kindle Book",
      title: "Kindle Book Builder",
      intro:
        "Fetch article text and pack it into EPUB / AZW3. One link per line; append `| chapter title` to rename a chapter.",
      urlsLabel: "Article links",
      urlsPlaceholder:
        "https://example.com/news/a\nhttps://example.com/news/b | Custom chapter title\n# lines starting with # are ignored",
      urlsHint: "Up to {max} links per book",
      titleLabel: "Book title",
      titlePlaceholder: "News digest {date}",
      outDirLabel: "Output directory",
      outDirHint: "A folder named after the book is created inside it",
      azw3Label: "Also build AZW3 (needs calibre)",
      coverLabel: "Generate a cover",
      submit: "Build book",
      submitting: "Building…",
      elapsed: "{s}s elapsed",
      envMissing: "Environment check failed:",
      resultTitle: "Result",
      resultMeta: "{formats} · {ms}s · {dir}",
      download: "Download",
      coverName: "Cover",
      failedTitle: "Links that failed",
      warningsTitle: "Notes",
      logTitle: "Full log",
      logShow: "Show",
      logHide: "Hide",
      retry: "Build again",
      needUrls: "Add at least one http(s) link first.",
      networkError: "Request failed: {message}",
      loadingEnv: "Checking the local environment…",
      draftRestored: "Restored what you typed last time.",
    };

    /** Today's date, only for the title placeholder. */
    function todayISO() {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }

    /** Read the saved draft; a broken value must never block the page. */
    function readDraft() {
      try {
        const raw = window.localStorage.getItem(DRAFT_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    }

    /** Persist the draft, ignoring quota or privacy-mode failures. */
    function writeDraft(draft) {
      try {
        window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // A full or unavailable storage keeps the page working in memory only.
      }
    }

    /** Human-readable byte size. */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return "";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    /** Sidebar glyph: an open book, sized by the sidebar's own row. */
    function KindlePanelIcon({ size }) {
      const dimension = typeof size === "number" ? size : 18;
      return h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: dimension,
          height: dimension,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
          style: { display: "block" },
        },
        h("path", { d: "M4 4.6h6.2a1.8 1.8 0 0 1 1.8 1.8v13a1.4 1.4 0 0 0-1.4-1.4H4z" }),
        h("path", { d: "M20 4.6h-6.2A1.8 1.8 0 0 0 12 6.4v13a1.4 1.4 0 0 1 1.4-1.4H20z" }),
      );
    }

    /** Page styles: theme alias tokens only, so light and dark both follow the host. */
    const STYLE = `
.kb-page{box-sizing:border-box;height:100%;overflow:auto;padding:calc(var(--dsh-frame-top-clearance,0px) + 20px) 24px 48px;color:var(--dsw-alias-label-primary,#1f2329);font-size:var(--dsh-content-font-size,14px);}
.kb-inner{max-width:880px;margin:0 auto;display:flex;flex-direction:column;gap:16px;}
.kb-head{display:flex;flex-direction:column;gap:6px;}
.kb-title{margin:0;font-size:20px;font-weight:600;letter-spacing:.01em;}
.kb-intro{margin:0;color:var(--dsw-alias-label-secondary,#61666d);line-height:1.6;}
.kb-card{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f7f8);padding:16px;display:flex;flex-direction:column;gap:12px;}
.kb-row{display:flex;flex-direction:column;gap:6px;}
.kb-row-split{display:flex;gap:12px;flex-wrap:wrap;}
.kb-row-split>.kb-row{flex:1 1 260px;}
.kb-label{font-weight:500;color:var(--dsw-alias-label-primary,#1f2329);}
.kb-hint{color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;line-height:1.5;}
.kb-input,.kb-area{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;padding:8px 10px;}
.kb-area{min-height:132px;resize:vertical;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;}
.kb-input:focus,.kb-area:focus{outline:2px solid var(--dsw-alias-state-business-primary,#247bbf);outline-offset:1px;}
.kb-checks{display:flex;gap:18px;flex-wrap:wrap;align-items:center;}
.kb-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;}
.kb-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.kb-button{border:1px solid transparent;border-radius:8px;padding:8px 16px;font:inherit;font-weight:500;cursor:pointer;}
.kb-button[disabled]{opacity:.55;cursor:not-allowed;}
.kb-primary{background:var(--dsw-alias-button-primary-fill,#247bbf);color:var(--dsw-alias-label-primary-foreground,#fff);}
.kb-primary:hover:not([disabled]){background:var(--dsw-alias-button-primary-hover,#1f6aa8);}
.kb-ghost{background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));}
.kb-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));}
.kb-status{color:var(--dsw-alias-label-secondary,#61666d);font-size:13px;}
.kb-error{color:var(--dsw-alias-state-error-primary,#c03030);white-space:pre-wrap;line-height:1.6;}
.kb-warn{color:var(--dsw-alias-state-warn-primary,#9a6b00);line-height:1.6;font-size:13px;}
.kb-files{display:flex;flex-direction:column;gap:8px;}
.kb-file{display:flex;align-items:center;gap:12px;justify-content:space-between;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);padding:8px 10px;}
.kb-file-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;overflow-wrap:anywhere;}
.kb-file-size{color:var(--dsw-alias-label-tertiary,#8a9099);font-size:12px;margin-left:8px;}
.kb-link{color:var(--dsw-alias-state-business-primary,#247bbf);text-decoration:none;font-weight:500;white-space:nowrap;}
.kb-link:hover{text-decoration:underline;}
.kb-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:1.55;}
.kb-log{max-height:280px;overflow:auto;margin:0;padding:10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fff);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;}
.kb-log-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.kb-section-title{margin:0;font-size:14px;font-weight:600;}
`;

    /** The page: one form, one result, one log. */
    function KindlePage(props) {
      const t = props.t;
      const draft = React.useMemo(readDraft, []);
      const [urls, setUrls] = React.useState(() => (typeof draft?.urls === "string" ? draft.urls : ""));
      const [title, setTitle] = React.useState(() => (typeof draft?.title === "string" ? draft.title : ""));
      const [outDir, setOutDir] = React.useState(() => (typeof draft?.outDir === "string" ? draft.outDir : ""));
      const [azw3, setAzw3] = React.useState(() => draft?.azw3 !== false);
      const [cover, setCover] = React.useState(() => draft?.cover !== false);
      const [env, setEnv] = React.useState(null);
      const [envError, setEnvError] = React.useState("");
      const [running, setRunning] = React.useState(false);
      const [elapsed, setElapsed] = React.useState(0);
      const [result, setResult] = React.useState(null);
      const [failure, setFailure] = React.useState("");
      const [showLog, setShowLog] = React.useState(false);
      const startedAt = React.useRef(0);

      React.useEffect(() => {
        writeDraft({ urls, title, outDir, azw3, cover });
      }, [urls, title, outDir, azw3, cover]);

      React.useEffect(() => {
        let cancelled = false;
        fetch(`${BASE}/env`, { headers: { accept: "application/json" } })
          .then((response) => response.json())
          .then((payload) => {
            if (cancelled) return;
            setEnv(payload);
            setOutDir((current) => (current === "" ? String(payload?.outDir ?? "") : current));
          })
          .catch((error) => {
            if (!cancelled) setEnvError(error?.message ?? String(error));
          });
        return () => {
          cancelled = true;
        };
      }, []);

      React.useEffect(() => {
        if (!running) return undefined;
        const timer = window.setInterval(() => {
          setElapsed(Math.max(0, Math.round((Date.now() - startedAt.current) / 1000)));
        }, 500);
        return () => window.clearInterval(timer);
      }, [running]);

      const submit = async (event) => {
        event.preventDefault();
        if (running) return;
        if (urls.trim() === "") {
          setFailure(t("needUrls"));
          return;
        }
        setFailure("");
        setResult(null);
        setShowLog(false);
        setRunning(true);
        setElapsed(0);
        startedAt.current = Date.now();
        try {
          const response = await fetch(`${BASE}/build`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ urls, title, outDir, azw3, cover }),
          });
          const payload = await response.json();
          setResult(payload);
          if (payload?.ok !== true) setFailure(String(payload?.error ?? `HTTP ${response.status}`));
        } catch (error) {
          setFailure(t("networkError", { message: error?.message ?? String(error) }));
        } finally {
          setRunning(false);
        }
      };

      const problems = Array.isArray(env?.problems) ? env.problems : [];
      const files = Array.isArray(result?.files) ? result.files : [];
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      const formats = files
        .filter((file) => file.kind !== "cover")
        .map((file) => String(file.kind).toUpperCase())
        .join(" + ");
      const downloadUrl = (name) => `${BASE}/download?id=${encodeURIComponent(result?.id ?? "")}&name=${encodeURIComponent(name)}`;

      return h(
        "div",
        { className: "kb-page" },
        h("style", null, STYLE),
        h(
          "div",
          { className: "kb-inner" },
          h(
            "div",
            { className: "kb-head" },
            h("h1", { className: "kb-title" }, t("title")),
            h("p", { className: "kb-intro" }, t("intro")),
          ),
          env === null && envError === ""
            ? h("p", { className: "kb-hint" }, t("loadingEnv"))
            : null,
          envError !== ""
            ? h("p", { className: "kb-error" }, t("envMissing") + " " + envError)
            : null,
          problems.length > 0
            ? h(
                "div",
                { className: "kb-card" },
                h("p", { className: "kb-warn" }, t("envMissing")),
                h(
                  "ul",
                  { className: "kb-list" },
                  problems.map((problem, index) => h("li", { key: `p${index}` }, String(problem))),
                ),
              )
            : null,
          h(
            "form",
            { className: "kb-card", onSubmit: submit },
            h(
              "div",
              { className: "kb-row" },
              h("label", { className: "kb-label", htmlFor: "kb-urls" }, t("urlsLabel")),
              h("textarea", {
                id: "kb-urls",
                className: "kb-area",
                value: urls,
                spellCheck: false,
                placeholder: t("urlsPlaceholder"),
                onChange: (event) => setUrls(event.target.value),
              }),
              h("span", { className: "kb-hint" }, t("urlsHint", { max: String(env?.limits?.maxUrls ?? 50) })),
            ),
            h(
              "div",
              { className: "kb-row-split" },
              h(
                "div",
                { className: "kb-row" },
                h("label", { className: "kb-label", htmlFor: "kb-title" }, t("titleLabel")),
                h("input", {
                  id: "kb-title",
                  className: "kb-input",
                  type: "text",
                  value: title,
                  placeholder: t("titlePlaceholder", { date: todayISO() }),
                  onChange: (event) => setTitle(event.target.value),
                }),
              ),
              h(
                "div",
                { className: "kb-row" },
                h("label", { className: "kb-label", htmlFor: "kb-outdir" }, t("outDirLabel")),
                h("input", {
                  id: "kb-outdir",
                  className: "kb-input",
                  type: "text",
                  value: outDir,
                  spellCheck: false,
                  placeholder: String(env?.outDir ?? "~/Documents/Kindle"),
                  onChange: (event) => setOutDir(event.target.value),
                }),
                h("span", { className: "kb-hint" }, t("outDirHint")),
              ),
            ),
            h(
              "div",
              { className: "kb-checks" },
              h(
                "label",
                { className: "kb-check" },
                h("input", { type: "checkbox", checked: azw3, onChange: (event) => setAzw3(event.target.checked) }),
                h("span", null, t("azw3Label")),
              ),
              h(
                "label",
                { className: "kb-check" },
                h("input", { type: "checkbox", checked: cover, onChange: (event) => setCover(event.target.checked) }),
                h("span", null, t("coverLabel")),
              ),
            ),
            h(
              "div",
              { className: "kb-actions" },
              h(
                "button",
                { type: "submit", className: "kb-button kb-primary", disabled: running },
                running ? t("submitting") : t("submit"),
              ),
              running ? h("span", { className: "kb-status" }, t("elapsed", { s: String(elapsed) })) : null,
            ),
            failure !== "" ? h("p", { className: "kb-error" }, failure) : null,
          ),
          result?.ok === true
            ? h(
                "div",
                { className: "kb-card" },
                h("h2", { className: "kb-section-title" }, t("resultTitle")),
                h(
                  "p",
                  { className: "kb-hint" },
                  t("resultMeta", { formats: formats || "EPUB", ms: String(result.ms ?? 0), dir: String(result.dir ?? "") }),
                ),
                h(
                  "div",
                  { className: "kb-files" },
                  files.map((file, index) =>
                    h(
                      "div",
                      { className: "kb-file", key: `f${index}` },
                      h(
                        "span",
                        { className: "kb-file-name" },
                        file.kind === "cover" ? t("coverName") : String(file.name),
                        h("span", { className: "kb-file-size" }, formatSize(file.size)),
                      ),
                      h("a", { className: "kb-link", href: downloadUrl(file.name), download: file.name }, t("download")),
                    ),
                  ),
                ),
                warnings.length > 0
                  ? h(
                      "div",
                      null,
                      h("p", { className: "kb-warn" }, t("warningsTitle")),
                      h(
                        "ul",
                        { className: "kb-list" },
                        warnings.map((warning, index) => h("li", { key: `w${index}` }, String(warning))),
                      ),
                    )
                  : null,
                failed.length > 0
                  ? h(
                      "div",
                      null,
                      h("p", { className: "kb-warn" }, t("failedTitle")),
                      h(
                        "ul",
                        { className: "kb-list" },
                        failed.map((item, index) =>
                          h("li", { key: `x${index}` }, `${item.url} — ${item.reason}`),
                        ),
                      ),
                    )
                  : null,
                h(
                  "div",
                  null,
                  h(
                    "div",
                    { className: "kb-log-head" },
                    h("span", { className: "kb-hint" }, t("logTitle")),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "kb-button kb-ghost",
                        onClick: () => setShowLog((current) => !current),
                      },
                      showLog ? t("logHide") : t("logShow"),
                    ),
                  ),
                  showLog ? h("pre", { className: "kb-log" }, String(result.log ?? "")) : null,
                ),
              )
            : null,
        ),
      );
    }

    return {
      inject: ["slots", "locale", "layout"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "kindle-book: dictionaries");
        const t = ctx.locale.bind(NS);
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            { name: "main", key: PANEL_ID, locale: NS, inject: () => ({ t }) },
            KindlePage,
          ),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: PANEL_ID, order: 30, label: () => t("panel"), locale: NS },
            KindlePanelIcon,
          ),
        );
      },
    };
  },
});
