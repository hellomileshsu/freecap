import type { CaptionCue, CaptionStyle } from "./types";

export const DEFAULT_STYLE: CaptionStyle = {
  fontFamily: "Noto Sans TC",
  fontSizePercent: 4.6,
  color: "#fffaf0",
  outlineColor: "#10131a",
  outlineWidth: 3,
  backgroundColor: "#10131a",
  backgroundOpacity: 0.72,
  position: "bottom",
  marginPercent: 8,
};

export const DEMO_CUES: CaptionCue[] = [
  { id: "demo-1", startMs: 0, endMs: 3650, text: "字幕留在你的電腦裡。", confidence: 0.98 },
  { id: "demo-2", startMs: 4100, endMs: 8320, text: "拖入影片，FreeCap 會在本機完成辨識。", confidence: 0.97 },
  { id: "demo-3", startMs: 8780, endMs: 12200, text: "沒有 API key，沒有雲端上傳。", confidence: 0.99 },
];

export function uid(prefix = "cue") {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function clampCue(cue: CaptionCue, durationMs = Number.POSITIVE_INFINITY): CaptionCue {
  const startMs = Math.max(0, Math.min(cue.startMs, durationMs));
  const endMs = Math.max(startMs + 120, Math.min(cue.endMs, durationMs));
  return { ...cue, startMs, endMs, text: cue.text.trim() };
}

export function normalizeCues(cues: CaptionCue[], durationMs = Number.POSITIVE_INFINITY) {
  return cues
    .map((cue) => clampCue(cue, durationMs))
    .filter((cue) => cue.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs)
    .map((cue, index, all) => ({
      ...cue,
      id: cue.id || uid(),
      endMs: Math.min(cue.endMs, all[index + 1]?.startMs ?? cue.endMs),
    }));
}

export function formatTimestamp(ms: number, decimal = ",") {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${decimal}${String(millis).padStart(3, "0")}`;
}

export function parseTimestamp(value: string) {
  const match = value.trim().match(/^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4].padEnd(3, "0"));
}

export function toSrt(cues: CaptionCue[]) {
  return normalizeCues(cues)
    .map((cue, index) => `${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}\n`)
    .join("\n");
}

export function toVtt(cues: CaptionCue[]) {
  return `WEBVTT\n\n${normalizeCues(cues)
    .map((cue) => `${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n${cue.text}\n`)
    .join("\n")}`;
}

export function fromSrt(input: string): CaptionCue[] {
  const blocks = input.replaceAll("\r\n", "\n").split(/\n{2,}/);
  return normalizeCues(
    blocks.flatMap((block) => {
      const lines = block.split("\n");
      const timingIndex = lines.findIndex((line) => line.includes(" --> "));
      if (timingIndex < 0) return [];
      const [start, end] = lines[timingIndex].split(" --> ").map(parseTimestamp);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
      return [{ id: uid(), startMs: start, endMs: end, text: lines.slice(timingIndex + 1).join("\n") }];
    }),
  );
}

export function fromWhisperChunks(chunks: Array<{ text?: string; timestamp?: [number | null, number | null] }>) {
  return normalizeCues(
    chunks.flatMap((chunk) => {
      const [start, end] = chunk.timestamp ?? [null, null];
      if (start == null || end == null || !chunk.text?.trim()) return [];
      return [{ id: uid(), startMs: Math.round(start * 1000), endMs: Math.max(Math.round(end * 1000), Math.round(start * 1000) + 500), text: chunk.text.trim() }];
    }),
  );
}

export function splitCue(cue: CaptionCue, atMs: number) {
  const pivot = Math.max(cue.startMs + 120, Math.min(cue.endMs - 120, atMs));
  const words = cue.text.trim().split(/\s+/);
  const midpoint = Math.max(1, Math.floor(words.length / 2));
  const leftText = words.length > 1 ? words.slice(0, midpoint).join(" ") : cue.text.slice(0, Math.ceil(cue.text.length / 2));
  const rightText = words.length > 1 ? words.slice(midpoint).join(" ") : cue.text.slice(Math.ceil(cue.text.length / 2));
  return [
    { ...cue, endMs: pivot, text: leftText },
    { ...cue, id: uid(), startMs: pivot, text: rightText },
  ];
}

export function mergeCues(first: CaptionCue, second: CaptionCue): CaptionCue {
  return { ...first, endMs: Math.max(first.endMs, second.endMs), text: `${first.text.trim()} ${second.text.trim()}`.trim() };
}

export function assColor(hex: string, opacity = 1) {
  const clean = hex.replace("#", "");
  const r = clean.slice(0, 2).padEnd(2, "0");
  const g = clean.slice(2, 4).padEnd(2, "0");
  const b = clean.slice(4, 6).padEnd(2, "0");
  const alpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${alpha}${b}${g}${r}`;
}

export function toAss(cues: CaptionCue[], style: CaptionStyle = DEFAULT_STYLE, width = 1920, height = 1080) {
  const alignment = style.position === "top" ? 8 : style.position === "middle" ? 5 : 2;
  const marginV = Math.round(height * (style.marginPercent / 100));
  const fontSize = Math.max(16, Math.round(height * (style.fontSizePercent / 100)));
  const primary = assColor(style.color);
  const outline = assColor(style.outlineColor);
  const back = assColor(style.backgroundColor, style.backgroundOpacity);
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: FreeCap,${style.fontFamily},${fontSize},${primary},${primary},${outline},${back},0,0,0,0,100,100,0,0,1,${style.outlineWidth},0,${alignment},${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = normalizeCues(cues)
    .map((cue) => `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},FreeCap,,0,0,0,,${cue.text.replaceAll("\n", "\\N")}`)
    .join("\n");
  return `${header}${events}\n`;
}

function assTime(ms: number) {
  const safe = Math.max(0, Math.round(ms / 10) * 10);
  const h = Math.floor(safe / 3_600_000);
  const m = Math.floor((safe % 3_600_000) / 60_000);
  const s = ((safe % 60_000) / 1000).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}
