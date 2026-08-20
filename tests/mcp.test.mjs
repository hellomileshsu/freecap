import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateInputPath, normalizeCues, toSrt, toVtt, createTranscription, getJob } from "../mcp/server.mjs";

test("MCP path validation requires absolute supported files", async () => {
  await assert.rejects(() => validateInputPath("relative.mp4"), /絕對本機路徑/);
  await assert.rejects(() => validateInputPath("/tmp/not-a-video.txt"), /影音格式/);
});

test("MCP subtitle serializers are UTF-8 and ordered", () => {
  const cues = normalizeCues([
    { id: "2", startMs: 1_000, endMs: 3_000, text: "第二句" },
    { id: "1", startMs: 0, endMs: 2_000, text: "第一句" },
  ]);
  assert.equal(cues[0].endMs, 1_000);
  assert.match(toSrt(cues), /第一句/);
  assert.match(toVtt(cues), /^WEBVTT/);
});

test("MCP reports invalid media as a failed asynchronous job", async () => {
  const root = await mkdtemp(join(tmpdir(), "freecap-test-"));
  const input = join(root, "not-a-video.mp4");
  await writeFile(input, "not media");
  const job = await createTranscription({ inputPath: input, model: "tiny" });
  let snapshot = getJob(job.id);
  for (let index = 0; index < 80 && !["failed", "cancelled", "completed"].includes(snapshot.status); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    snapshot = getJob(job.id);
  }
  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.error, /FFmpeg|Invalid|not media/i);
  await rm(root, { recursive: true, force: true });
});
