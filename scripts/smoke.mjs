#!/usr/bin/env node
/**
 * Self-check for the plugin's host half.
 *
 * Without arguments it stays offline: it loads the plugin into a fake context,
 * serves the registered routes on a loopback port, and checks the request
 * validation and download guard. With `--network` it also runs one real build
 * (fetching the given article) so the bundled script and calibre are exercised
 * end to end.
 *
 *   node scripts/smoke.mjs [--network [url]]
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../index.js";

const args = process.argv.slice(2);
const network = args.includes("--network");
const networkUrl = args.find((value) => value.startsWith("http")) ?? "https://mp.weixin.qq.com/s/LkmMlftT1vNrVDoUMd46Ag";
const outDir = mkdtempSync(join(tmpdir(), "kindle-smoke-"));
const routes = [];
let failures = 0;

/** Report one assertion. */
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === "" ? "" : ` — ${detail}`}`);
}

/** Load the plugin into a context that simply collects route registrations. */
apply(
  {
    effect: (fn) => fn(),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  },
  { outDir },
);

const server = http.createServer((req, res) => {
  const path = new URL(String(req.url), "http://localhost").pathname;
  const route = routes.find((item) => (item.kind === "exact" ? item.path === path : path.startsWith(item.path)));
  if (route === undefined) {
    res.statusCode = 404;
    res.end("no route");
    return;
  }
  route.handler(req, res);
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  console.log(`routes: ${routes.map((route) => route.path).join(" ")}`);
  check("three routes registered", routes.length === 3, String(routes.length));

  console.log("\noffline checks");
  const env = await fetch(`${base}/kindle-book/env`);
  const envBody = await env.json();
  check("GET /env is 200 json", env.status === 200 && typeof envBody.ok === "boolean");
  check("GET /env reports outDir", envBody.outDir === outDir, String(envBody.outDir));

  const noBody = await fetch(`${base}/kindle-book/build`, { method: "POST", body: "" });
  check("POST /build without JSON is 400", noBody.status === 400, String(noBody.status));

  const badUrl = await fetch(`${base}/kindle-book/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: ["ftp://example.com/a"] }),
  });
  check("POST /build with a non-http url is 400", badUrl.status === 400, String(badUrl.status));

  const emptyUrls = await fetch(`${base}/kindle-book/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls: [] }),
  });
  check("POST /build with no urls is 400", emptyUrls.status === 400, String(emptyUrls.status));

  const wrongMethod = await fetch(`${base}/kindle-book/build`);
  check("GET /build is 405", wrongMethod.status === 405, String(wrongMethod.status));

  const unknownDownload = await fetch(`${base}/kindle-book/download?id=nope&name=x.epub`);
  check("download of an unknown build is 404", unknownDownload.status === 404, String(unknownDownload.status));

  if (network) {
    console.log("\nnetwork check");
    const started = Date.now();
    const response = await fetch(`${base}/kindle-book/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: [networkUrl], title: "插件自检", azw3: true, cover: true }),
    });
    const build = await response.json();
    check("build succeeded", build.ok === true, String(build.error ?? ""));
    if (build.ok === true) {
      console.log(`       ${Date.now() - started} ms, files: ${build.files.map((file) => file.name).join(", ")}`);
      const epub = build.files.find((file) => file.kind === "epub");
      check("an EPUB was produced", epub !== undefined);
      if (epub !== undefined) {
        const download = await fetch(
          `${base}/kindle-book/download?id=${encodeURIComponent(build.id)}&name=${encodeURIComponent(epub.name)}`,
        );
        const bytes = await download.arrayBuffer();
        check("download matches the file size", download.status === 200 && bytes.byteLength === epub.size,
          `${download.status} / ${bytes.byteLength} vs ${epub.size}`);
      }
    }
  }
} finally {
  server.close();
  rmSync(outDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
