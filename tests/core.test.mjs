import test from "node:test";
import assert from "node:assert/strict";
import { CAPTION_LIMITS, DEMO_CUES, formatTimestamp, fromSrt, fromWhisperChunks, mergeCues, normalizeCues, parseTimestamp, splitCue, toAss, toSrt, toVtt, wrapCaptionText } from "../src/core/subtitles.ts";

test("formats and parses subtitle timestamps", () => {
  assert.equal(formatTimestamp(3_721_045), "01:02:01,045");
  assert.equal(parseTimestamp("01:02:01,045"), 3_721_045);
  assert.equal(Number.isNaN(parseTimestamp("bad")), true);
});

test("SRT and VTT round trip cue text", () => {
  const srt = toSrt(DEMO_CUES);
  assert.match(srt, /00:00:00,000 --> 00:00:03,650/);
  assert.match(toVtt(DEMO_CUES), /^WEBVTT/);
  assert.deepEqual(fromSrt(srt).map((cue) => cue.text), DEMO_CUES.map((cue) => cue.text));
});

test("normalization removes empty cues and prevents overlaps", () => {
  const result = normalizeCues([
    { id: "b", startMs: 900, endMs: 2_000, text: "第二句" },
    { id: "a", startMs: 0, endMs: 1_200, text: "第一句" },
    { id: "empty", startMs: 0, endMs: 1_000, text: "  " },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].endMs, 900);
});

test("split and merge preserve readable caption content", () => {
  const first = DEMO_CUES[1];
  const [left, right] = splitCue(first, 6_000);
  assert.equal(left.endMs, right.startMs);
  assert.equal(mergeCues(left, right).text, first.text);
});

test("caption segmentation wraps Chinese and English without overlap", () => {
  const chinese = wrapCaptionText("這是一段很長的繁體中文字幕文字用來測試換行限制。", "zh");
  assert.ok(chinese.split("\n").every((line) => Array.from(line).length <= CAPTION_LIMITS.zh.maxCharsPerLine));
  const english = wrapCaptionText("This is a deliberately long English caption line that should wrap at a readable width.", "en");
  assert.ok(english.split("\n").every((line) => line.length <= CAPTION_LIMITS.en.maxCharsPerLine));
  const cues = fromWhisperChunks([{ text: "第一句。第二句！", timestamp: [0, 5] }], "zh");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].endMs, cues[1].startMs);
  assert.match(cues[1].text, /第二句/);
  const longCue = fromWhisperChunks([{ text: "one two three four five six seven eight nine ten eleven twelve", timestamp: [0, 13] }], "en");
  assert.ok(longCue.every((cue) => cue.endMs - cue.startMs <= CAPTION_LIMITS.en.maxDurationMs));
});

test("ASS output carries style and events", () => {
  const ass = toAss(DEMO_CUES);
  assert.match(ass, /Style: FreeCap/);
  assert.match(ass, /Dialogue: 0,0:00:00.00/);
  assert.match(ass, /PlayResX: 1920/);
});
