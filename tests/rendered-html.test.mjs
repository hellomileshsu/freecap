import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("server renders the FreeCap workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>FreeCap 免費字幕/);
  assert.match(html, /字幕，留在/);
  assert.match(html, /拖曳影片到這裡/);
  assert.match(html, /Claude · Cursor · Codex/);
  assert.match(html, /本機優先/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("finished source removes starter preview infrastructure", async () => {
  const [page, layout, packageJson, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /transcribeBrowserFile/);
  assert.match(layout, /FreeCap 免費字幕/);
  assert.doesNotMatch(page, /SkeletonPreview|_sites-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(css, /--coral:/);
});

test("browser FFmpeg uses a worker that is safe outside window scope", async () => {
  const root = new URL("../", import.meta.url);
  const [worker, transcription, page] = await Promise.all([
    readFile(new URL("public/freecap-ffmpeg-worker.js", root), "utf8"),
    readFile(new URL("src/core/browser-transcription.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  assert.doesNotMatch(worker, /\bwindow\s*[.[]/);
  assert.doesNotMatch(worker, /\/@vite\/client/);
  assert.match(transcription, /classWorkerURL: "\/freecap-ffmpeg-worker\.js"/);
  assert.match(page, /classWorkerURL: "\/freecap-ffmpeg-worker\.js"/);
});
