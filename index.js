/**
 * Host half of the Kindle 编书 bundle.
 *
 * Three HTTP routes on the composition's `webServer` run the bundled
 * `news2kindle.py` (fetch article text → EPUB → optional AZW3 through calibre)
 * and stream the produced files back to the browser. The same `buildBook()`
 * operation is exposed to the agent as the `kindle_book` tool, so the page and
 * the model never hold two copies of the logic.
 *
 * Security has one home, here: every route first asks the composition's
 * `connection` service for a rejection (its Host/Origin fence plus browser
 * authentication), then validates the body. Downloads never accept a path from
 * the caller — only a build id and a file name that build itself registered.
 */
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis Loader identity. */
export const name = "kindle-book";

/** The HTTP carrier; the tool registry is picked up optionally below. */
export const inject = ["webServer"];

/** Bundle-relative asset locations. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(PLUGIN_DIR, "news2kindle.py");
const DSH_PYTHON = join(
  homedir(),
  ".dsh",
  "dsh-runtimes",
  "dsh-primary-runtime",
  "dependencies",
  "python",
  "bin",
  "python3",
);

/** Routes owned by this plugin. */
const ENV_PATH = "/kindle-book/env";
const BUILD_PATH = "/kindle-book/build";
const DOWNLOAD_PATH = "/kindle-book/download";

/** Bounds: a book build is local, but it is still a bounded operation. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOG_CHARS = 120 * 1024;
const MAX_URLS = 50;
const MAX_TITLE_CHARS = 120;
const MAX_BUILDS = 24;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MIN_CHARS = 120;

/** Completed builds reachable through the download route. */
const builds = new Map();
/** One build at a time: the script is network- and CPU-bound, not reentrant. */
let running = null;
/** Successful interpreter probes, keyed by executable path. */
const pythonProbes = new Map();

/** Row settings the tool body reads; set once by `apply`. */
let activeSettings = null;

/** Merge the row's config over the defaults, ignoring wrong shapes. */
function settingsOf(config) {
  const raw = config !== null && typeof config === "object" ? config : {};
  const number = (value, fallback) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  return {
    pythonPath: text(raw.pythonPath),
    calibrePath: text(raw.calibrePath),
    outDir: text(raw.outDir),
    timeoutMs: number(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    minChars: number(raw.minChars, DEFAULT_MIN_CHARS),
  };
}

/** Expand a leading `~`, then resolve to an absolute path ("" when relative). */
function expandPath(value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return "";
  const expanded = text === "~" ? homedir() : text.startsWith("~/") ? join(homedir(), text.slice(2)) : text;
  return isAbsolute(expanded) ? resolve(expanded) : "";
}

/** Where a book goes when neither config nor request names a directory. */
function defaultOutDir(settings) {
  return settings.outDir !== "" ? settings.outDir : join(homedir(), "Documents", "Kindle");
}

/** JSON response, never cached: build state and environment are live facts. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader("allow", allow);
  res.end();
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Ask the composition's connection fence whether to refuse this request.
 * @returns true when the request was already answered.
 */
function rejectedByFence(ctx, req, res) {
  const connection = Reflect.get(ctx, "connection");
  if (connection === null || connection === void 0) return false;
  const check = connection.requestRejection;
  if (typeof check !== "function") return false;
  const status = check.call(connection, req);
  if (status === void 0 || status === null || status === false) return false;
  res.statusCode = Number(status);
  res.end();
  return true;
}

/** Whether a path exists and carries the requested mode bits. */
async function can(mode, path) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Resolve one command name against PATH, for hosts without `which`. */
function whichCommand(command) {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (directory === "") continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * Locate calibre's `ebook-convert`: explicit config, then the environment
 * variable the bundled script also honours, then per-platform install paths.
 * @param settings - row settings.
 * @returns the first existing candidate, or "" when calibre is not installed.
 */
async function resolveCalibre(settings) {
  const candidates = [];
  if (settings.calibrePath !== "") candidates.push(expandPath(settings.calibrePath) || settings.calibrePath);
  const fromEnv = (process.env.NEWS2KINDLE_EBOOK_CONVERT ?? "").trim();
  if (fromEnv !== "") candidates.push(expandPath(fromEnv) || fromEnv);
  candidates.push(
    "/Applications/calibre.app/Contents/MacOS/ebook-convert",
    join(homedir(), "Applications", "calibre.app", "Contents", "MacOS", "ebook-convert"),
    "C:\\Program Files\\Calibre2\\ebook-convert.exe",
    "C:\\Program Files (x86)\\Calibre2\\ebook-convert.exe",
    "/usr/bin/ebook-convert",
    "/usr/local/bin/ebook-convert",
    "/snap/bin/ebook-convert",
    "/opt/calibre/ebook-convert",
  );
  const onPath = whichCommand("ebook-convert");
  if (onPath !== "") candidates.push(onPath);
  for (const candidate of candidates) {
    if (await can(fsConstants.X_OK, candidate)) return candidate;
  }
  return "";
}

/** Probe one interpreter for the `lxml` the extractor needs (successes cached). */
async function probePython(executable, timeoutMs) {
  const cached = pythonProbes.get(executable);
  if (cached !== void 0) return cached;
  const probe = await runProcess({
    command: executable,
    args: ["-c", "import lxml"],
    timeoutMs: Math.min(timeoutMs, 20_000),
  });
  const ok = probe.code === 0 && !probe.timedOut;
  if (ok) pythonProbes.set(executable, true);
  return ok;
}

/** Candidate interpreters, most specific first. */
async function resolvePython(settings) {
  const candidates = [];
  const configured = settings.pythonPath === "" ? "" : expandPath(settings.pythonPath) || settings.pythonPath;
  if (configured !== "") candidates.push(configured);
  candidates.push(DSH_PYTHON, "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3", "python3");
  const problems = [];
  for (const executable of candidates) {
    if (executable.includes("/") && !(await can(fsConstants.X_OK, executable))) {
      problems.push(`${executable}: 不存在或不可执行`);
      continue;
    }
    if (await probePython(executable, settings.timeoutMs)) return { executable, problems };
    problems.push(`${executable}: 缺少 lxml`);
  }
  return { executable: "", problems };
}

/**
 * Spawn one process under a deadline, keeping its combined output.
 * @returns exit code (−1 when none), the bounded log, and whether the deadline fired.
 */
function runProcess({ command, args, timeoutMs, env, signal }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk) => {
      if (log.length >= MAX_LOG_CHARS) return;
      log += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const abort = () => child.kill("SIGKILL");
    if (signal !== void 0) {
      if (signal.aborted) child.kill("SIGKILL");
      else signal.addEventListener("abort", abort, { once: true });
    }
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      if (log.length > MAX_LOG_CHARS) log = `${log.slice(0, MAX_LOG_CHARS)}\n…（日志已截断）`;
      resolvePromise({ code, log, timedOut });
    };
    child.on("error", (error) => {
      append(`\n启动失败: ${error.message}\n`);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Today's date in the host's zone, for the default book title. */
function todayISO() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Normalise the caller's lines into the script's `url | 标题` items. */
function normalizeUrls(input) {
  const items = [];
  const problems = [];
  for (const raw of input) {
    const line = String(raw ?? "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const url = line.split("|", 1)[0].trim();
    if (!/^https?:\/\//i.test(url)) {
      problems.push(`不是 http(s) 链接：${line.slice(0, 120)}`);
      continue;
    }
    if (items.length >= MAX_URLS) {
      problems.push(`一次最多 ${MAX_URLS} 条链接，多余的已忽略`);
      break;
    }
    items.push(line);
  }
  return { items, problems };
}

/** Parse the script's `EPUB  <path>  (12 KB)` publication lines. */
function parsePublished(log) {
  const found = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /^(EPUB|AZW3)\s+(.+?)\s+\((\d+) KB\)$/.exec(line.trim());
    if (match !== null) found.push({ format: match[1], path: match[2] });
  }
  return found;
}

/** Parse `[i/n] url` + `FAIL reason` pairs out of the log. */
function parseFailures(log) {
  const failures = [];
  let current = "";
  for (const line of log.split(/\r?\n/)) {
    const head = /^\[\d+\/\d+\]\s+(\S+)$/.exec(line.trim());
    if (head !== null) {
      current = head[1];
      continue;
    }
    const fail = /^FAIL\s+(.*)$/.exec(line.trim());
    if (fail !== null) failures.push({ url: current, reason: fail[1] });
  }
  return failures;
}

/** Register one completed build for the download route, evicting the oldest. */
function rememberBuild(record) {
  builds.set(record.id, record);
  while (builds.size > MAX_BUILDS) {
    const oldest = builds.keys().next();
    if (oldest.done === true) break;
    builds.delete(oldest.value);
  }
}

/** Content type served for one produced file. */
function contentTypeFor(path) {
  switch (extname(path).toLowerCase()) {
    case ".epub":
      return "application/epub+zip";
    case ".azw3":
      return "application/vnd.amazon.ebook";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

/**
 * Validate a build request from either caller.
 * @param payload - untrusted request fields.
 * @param settings - row settings.
 * @returns resolved fields, or a reason when unusable.
 */
function validateBuildRequest(payload, settings) {
  const rawUrls = Array.isArray(payload.urls)
    ? payload.urls
    : typeof payload.urls === "string"
      ? payload.urls.split(/\r?\n/)
      : null;
  if (rawUrls === null) return { error: "urls 需要是字符串数组，或一行一条链接的文本。" };
  const { items, problems } = normalizeUrls(rawUrls);
  if (items.length === 0) {
    return { error: problems.length > 0 ? problems.join("；") : "至少给一条 http(s) 链接。" };
  }
  const titleRaw = typeof payload.title === "string" ? payload.title.trim() : "";
  if (titleRaw.length > MAX_TITLE_CHARS) return { error: `书名最多 ${MAX_TITLE_CHARS} 个字。` };
  const dirRaw = typeof payload.outDir === "string" ? payload.outDir.trim() : "";
  const minChars =
    typeof payload.minChars === "number" && Number.isFinite(payload.minChars) && payload.minChars >= 0
      ? Math.floor(payload.minChars)
      : settings.minChars;
  return {
    urls: items,
    title: titleRaw === "" ? `新闻摘编 ${todayISO()}` : titleRaw,
    azw3: payload.azw3 !== false,
    cover: payload.cover !== false,
    outDir: expandPath(dirRaw) || defaultOutDir(settings),
    minChars,
    problems,
  };
}

/**
 * Build one book: run the bundled script and describe what it produced.
 * Shared by the UI route and the `kindle_book` tool.
 * @returns the build record, or `{ ok: false, status, error }`.
 */
async function buildBook(settings, request, signal) {
  if (running !== null) return { ok: false, status: 409, error: "已有一次生成在进行中，请等它结束。" };
  const python = await resolvePython(settings);
  if (python.executable === "") {
    return {
      ok: false,
      status: 503,
      error: `找不到带 lxml 的 Python 解释器：${python.problems.join("；")}`,
    };
  }
  if (!(await can(fsConstants.F_OK, SCRIPT_PATH))) {
    return { ok: false, status: 500, error: `插件内缺少 news2kindle.py：${SCRIPT_PATH}` };
  }
  try {
    await mkdir(request.outDir, { recursive: true });
  } catch (error) {
    return { ok: false, status: 400, error: `无法创建输出目录 ${request.outDir}：${error.message}` };
  }

  const calibre = await resolveCalibre(settings);
  const args = [SCRIPT_PATH, ...request.urls, "--title", request.title, "--outdir", request.outDir];
  args.push("--min-chars", String(request.minChars));
  if (request.azw3 === true) args.push("--azw3");
  if (request.cover !== true) args.push("--no-cover");

  const started = Date.now();
  const id = `b${started.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  running = id;
  let run;
  try {
    run = await runProcess({
      command: python.executable,
      args,
      timeoutMs: settings.timeoutMs,
      signal,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        ...(calibre === "" ? {} : { NEWS2KINDLE_EBOOK_CONVERT: calibre }),
      },
    });
  } finally {
    running = null;
  }
  const ms = Date.now() - started;
  const published = parsePublished(run.log);
  const failed = parseFailures(run.log);
  const warnings = [...(request.problems ?? [])];
  if (run.timedOut) warnings.push(`超过 ${Math.round(settings.timeoutMs / 1000)} 秒仍未完成，已终止。`);
  if (published.length === 0) {
    const tail = run.log.trim().split(/\r?\n/).slice(-8).join("\n");
    return {
      ok: false,
      status: run.timedOut ? 504 : 422,
      error: run.timedOut ? "生成超时。" : `没有生成任何文件。\n${tail}`,
      log: run.log,
      failed,
      ms,
    };
  }

  const bookDir = dirname(published[0].path);
  const files = [];
  for (const item of published) {
    try {
      const info = await stat(item.path);
      files.push({ name: basename(item.path), kind: item.format === "AZW3" ? "azw3" : "epub", size: info.size });
    } catch {
      warnings.push(`生成的文件已不存在：${item.path}`);
    }
  }
  const coverPath = join(bookDir, "_cover.png");
  try {
    const info = await stat(coverPath);
    files.push({ name: basename(coverPath), kind: "cover", size: info.size });
  } catch {
    // No cover is a normal outcome (`--no-cover`, or a failed render).
  }
  if (request.azw3 === true && !files.some((file) => file.kind === "azw3")) {
    warnings.push(
      calibre === ""
        ? "本机没找到 calibre 的 ebook-convert，只生成了 EPUB（安装 calibre 或用 config.calibrePath 指定路径）。"
        : "AZW3 没有生成，详见日志。",
    );
  }

  const record = { id, title: request.title, dir: bookDir, files, failed, warnings, log: run.log, ms };
  rememberBuild({
    id,
    dir: bookDir,
    title: request.title,
    createdAt: started,
    files: new Map(files.map((file) => [file.name, join(bookDir, file.name)])),
  });
  return { ok: true, status: 200, ...record };
}

/** Read one JSON body off the build route; null when unusable. */
async function readJsonBody(req) {
  const text = await readBoundedBody(req);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** One-line description of a build record, for the tool's rendered content. */
function summarize(record) {
  const books = record.files.filter((file) => file.kind !== "cover");
  const formats = books.map((file) => file.kind.toUpperCase()).join(" + ");
  const names = books.map((file) => file.name).join("、");
  const failed = record.failed.length > 0 ? `，${record.failed.length} 条链接失败（见日志）` : "";
  return `已生成 ${formats}：${names}${failed}\n目录：${record.dir}`;
}

/** The agent-facing tool: the same operation the page's button performs. */
const kindleTool = {
  name: "kindle_book",
  description:
    "Fetch web article pages as clean text and package them into an EPUB (and AZW3 through calibre when installed) for Kindle. Use it when the user wants news or articles collected into one e-book file. Returns the output directory, the produced files, skipped pages, and the raw log.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Article URLs, one per entry. Append ` | 章节标题` to override that chapter's title.",
      },
      title: {
        type: "string",
        description: "Book title, also the output folder name. Defaults to 新闻摘编 <date>.",
      },
      azw3: { type: "boolean", description: "Also convert to AZW3 with calibre. Defaults to true." },
      cover: { type: "boolean", description: "Draw a generated cover page. Defaults to true." },
      outDir: {
        type: "string",
        description: "Absolute output directory. Defaults to the configured directory (~/Documents/Kindle).",
      },
    },
    required: ["urls"],
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        dir: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              kind: { type: "string" },
              size: { type: "integer" },
            },
          },
        },
        failed: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { url: { type: "string" }, reason: { type: "string" } },
          },
        },
        log: { type: "string" },
        error: { type: "string" },
      },
    },
    render: (_args, value) => {
      if (value.ok !== true) return [{ type: "text", text: `生成失败：${value.error ?? "未知原因"}` }];
      const tail = (value.log ?? "").trim().split(/\r?\n/).slice(-8).join("\n");
      return [{ type: "text", text: `${summarize(value)}\n${tail}` }];
    },
  },
  async execute(args, exec) {
    const request = validateBuildRequest(args, activeSettings);
    if (request.error !== void 0) return { ok: false, error: request.error };
    const result = await buildBook(activeSettings, request, exec?.signal);
    if (result.ok !== true) {
      return { ok: false, error: result.error ?? "生成失败", log: result.log, failed: result.failed };
    }
    return { ok: true, dir: result.dir, files: result.files, failed: result.failed, log: result.log };
  },
};

/**
 * Host plugin body: register the three routes and, when the profile has a tool
 * registry, the agent tool that shares `buildBook()`.
 * @param ctx - plugin context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  const settings = settingsOf(config);
  activeSettings = settings;

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: ENV_PATH,
        handler: async (req, res) => {
          if (rejectedByFence(ctx, req, res)) return;
          if (req.method !== "GET") {
            sendMethodNotAllowed(res, "GET");
            return;
          }
          const python = await resolvePython(settings);
          const calibre = await resolveCalibre(settings);
          const calibreOk = calibre !== "";
          const scriptOk = await can(fsConstants.F_OK, SCRIPT_PATH);
          const problems = [...python.problems];
          if (!scriptOk) problems.push(`插件缺少 ${SCRIPT_PATH}`);
          if (!calibreOk) problems.push("找不到 calibre 的 ebook-convert，无法生成 AZW3（EPUB 不受影响）");
          sendJson(res, 200, {
            ok: python.executable !== "" && scriptOk,
            python: { path: python.executable, ok: python.executable !== "" },
            calibre: { path: calibre, ok: calibreOk },
            script: { path: SCRIPT_PATH, ok: scriptOk },
            outDir: defaultOutDir(settings),
            limits: { maxUrls: MAX_URLS, timeoutMs: settings.timeoutMs, minChars: settings.minChars },
            problems,
          });
        },
      }),
    `kindle-book: GET ${ENV_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: BUILD_PATH,
        handler: async (req, res) => {
          if (rejectedByFence(ctx, req, res)) return;
          if (req.method !== "POST") {
            sendMethodNotAllowed(res, "POST");
            return;
          }
          const payload = await readJsonBody(req);
          if (payload === null) {
            sendJson(res, 400, { ok: false, error: "请求体需要是 JSON 对象。" });
            return;
          }
          const request = validateBuildRequest(payload, settings);
          if (request.error !== void 0) {
            sendJson(res, 400, { ok: false, error: request.error });
            return;
          }
          const result = await buildBook(settings, request, undefined);
          sendJson(res, typeof result.status === "number" ? result.status : 200, result);
        },
      }),
    `kindle-book: POST ${BUILD_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: DOWNLOAD_PATH,
        handler: async (req, res) => {
          if (rejectedByFence(ctx, req, res)) return;
          if (req.method !== "GET") {
            sendMethodNotAllowed(res, "GET");
            return;
          }
          const url = new URL(String(req.url ?? ""), "http://localhost");
          const build = builds.get(url.searchParams.get("id") ?? "");
          const absolute = build?.files.get(url.searchParams.get("name") ?? "");
          if (absolute === void 0) {
            sendJson(res, 404, { ok: false, error: "文件不存在或已过期，请重新生成。" });
            return;
          }
          let info;
          try {
            info = await stat(absolute);
          } catch {
            sendJson(res, 404, { ok: false, error: "文件已被移动或删除。" });
            return;
          }
          const name = basename(absolute);
          const asciiFallback = name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
          res.statusCode = 200;
          res.setHeader("content-type", contentTypeFor(absolute));
          res.setHeader("content-length", String(info.size));
          res.setHeader("cache-control", "no-store");
          res.setHeader(
            "content-disposition",
            `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          );
          createReadStream(absolute).pipe(res);
        },
      }),
    `kindle-book: GET ${DOWNLOAD_PATH}`,
  );

  // The tool registry is optional: a profile without agents still gets the page.
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["tools"], (inner) => {
        const holder = inner !== null && inner !== void 0 && inner.tools !== void 0 ? inner : ctx;
        holder.effect(() => holder.tools.register(kindleTool), "kindle-book: kindle_book tool");
      });
    } catch (error) {
      console.warn(`kindle-book: 未注册 kindle_book 工具：${error?.message ?? error}`);
    }
  } else if (ctx.tools !== void 0) {
    ctx.effect(() => ctx.tools.register(kindleTool), "kindle-book: kindle_book tool");
  }
}
