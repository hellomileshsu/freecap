import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv", ".avi", ".wav", ".mp3", ".m4a"]);
const MODEL_IDS = { tiny: "onnx-community/whisper-tiny", base: "onnx-community/whisper-base", small: "onnx-community/whisper-small" };
const jobs = new Map();
const processes = new Map();

export const DEFAULT_STYLE = {
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

async function resolveBinary() {
  try {
    const imported = await import("ffmpeg-static");
    if (imported.default && existsSync(imported.default)) return imported.default;
  } catch {
    // Fall through to a system FFmpeg.
  }
  return process.env.FFMPEG_PATH || "ffmpeg";
}

function allowedRoots() {
  const configured = (process.env.FREECAP_ALLOWED_DIRS || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean).map(resolve);
  return configured.length ? configured : null;
}

export async function validateInputPath(inputPath) {
  if (!inputPath || !isAbsolute(inputPath)) throw new Error("inputPath 必須是絕對本機路徑");
  const resolved = resolve(inputPath);
  if (!VIDEO_EXTENSIONS.has(extname(resolved).toLowerCase())) throw new Error("只支援常見影音格式（MP4、MOV、WebM、MKV、WAV、MP3、M4A）");
  const roots = allowedRoots();
  if (roots && !roots.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`))) throw new Error("這個路徑不在 FreeCap 允許的資料夾內");
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error("找不到本機影片，或路徑不是檔案");
  return resolved;
}

export async function outputDirectoryFor(inputPath, requested) {
  const directory = requested ? resolve(requested) : join(dirname(inputPath), "FreeCap Output");
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function uniqueOutput(directory, stem, extension) {
  const base = join(directory, `${stem}${extension}`);
  if (!existsSync(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const next = join(directory, `${stem}-${index}${extension}`);
    if (!existsSync(next)) return next;
  }
  throw new Error("無法建立不重複的輸出檔名");
}

function formatTimestamp(ms, decimal = ",") {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${decimal}${String(safe % 1_000).padStart(3, "0")}`;
}

export function normalizeCues(cues = [], durationMs = Number.POSITIVE_INFINITY) {
  return cues.map((cue, index) => {
    const startMs = Math.max(0, Math.min(Number(cue.startMs) || 0, durationMs));
    const endMs = Math.max(startMs + 120, Math.min(Number(cue.endMs) || startMs + 120, durationMs));
    return { id: cue.id || `cue-${index + 1}`, startMs, endMs, text: String(cue.text || "").trim(), confidence: cue.confidence };
  }).filter((cue) => cue.text).sort((a, b) => a.startMs - b.startMs).map((cue, index, all) => ({ ...cue, endMs: Math.min(cue.endMs, all[index + 1]?.startMs ?? cue.endMs) }));
}

const CAPTION_LIMITS = {
  zh: { maxCharsPerLine: 16 },
  en: { maxCharsPerLine: 42 },
};

function dominantLanguage(text, language = "auto") {
  if (language !== "auto") return language;
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return han >= latin ? "zh" : "en";
}

function cleanCaptionText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function wrapCaptionText(text, language = "auto") {
  const clean = cleanCaptionText(text);
  const lang = dominantLanguage(clean, language);
  const limit = CAPTION_LIMITS[lang].maxCharsPerLine;
  if (lang === "zh") {
    const chars = Array.from(clean.replaceAll(" ", ""));
    const lines = [];
    for (let index = 0; index < chars.length; index += limit) lines.push(chars.slice(index, index + limit).join(""));
    return lines.join("\n");
  }
  const lines = [];
  let line = "";
  for (const word of clean.split(" ")) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= limit) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function splitByReadingUnits(text, language = "auto") {
  const clean = cleanCaptionText(text);
  const lang = dominantLanguage(clean, language);
  const maxCueChars = CAPTION_LIMITS[lang].maxCharsPerLine * 2;
  const sentences = clean.match(/[^。！？!?；;.!?]+[。！？!?；;.!?]?/gu) || [clean];
  const pieces = [];
  for (const sentence of sentences.map(cleanCaptionText).filter(Boolean)) {
    if (lang === "zh") {
      const chars = Array.from(sentence);
      for (let index = 0; index < chars.length; index += maxCueChars) pieces.push(chars.slice(index, index + maxCueChars).join(""));
      continue;
    }
    let piece = "";
    for (const word of sentence.split(" ")) {
      if (!piece) piece = word;
      else if (piece.length + 1 + word.length <= maxCueChars) piece += ` ${word}`;
      else {
        pieces.push(piece);
        piece = word;
      }
    }
    if (piece) pieces.push(piece);
  }
  return pieces.length ? pieces : [clean];
}

function splitPiecesToCount(pieces, count, language = "auto") {
  const lang = dominantLanguage(pieces.join(" "), language);
  const next = [...pieces];
  while (next.length < count) {
    let longestIndex = -1;
    let longestLength = 1;
    next.forEach((piece, index) => {
      const length = lang === "zh" ? Array.from(piece).length : piece.split(" ").length;
      if (length > longestLength) {
        longestLength = length;
        longestIndex = index;
      }
    });
    if (longestIndex < 0) break;
    const units = lang === "zh" ? Array.from(next[longestIndex]) : next[longestIndex].split(" ");
    const midpoint = Math.ceil(units.length / 2);
    const separator = lang === "zh" ? "" : " ";
    next.splice(longestIndex, 1, units.slice(0, midpoint).join(separator), units.slice(midpoint).join(separator));
  }
  return next;
}

export function segmentCaptionText(text, startMs, endMs, language = "auto") {
  const safeStart = Math.max(0, Math.round(startMs));
  const safeEnd = Math.max(safeStart + 120, Math.round(endMs));
  const duration = safeEnd - safeStart;
  const basePieces = splitByReadingUnits(text, language);
  const pieces = splitPiecesToCount(basePieces, Math.ceil(duration / 6_000), language);
  const minimumDuration = duration >= pieces.length * 1_000 ? 1_000 : 120;
  const nominalDuration = Math.floor(duration / pieces.length);
  let cursor = safeStart;
  return pieces.map((piece, index) => {
    const pieceDuration = index === pieces.length - 1 ? safeEnd - cursor : Math.max(minimumDuration, Math.min(6_000, nominalDuration));
    const next = Math.min(safeEnd, cursor + pieceDuration);
    const cue = { id: `cue-${randomUUID()}`, startMs: cursor, endMs: next, text: wrapCaptionText(piece, language) };
    cursor = next;
    return cue;
  });
}

export function toSrt(cues) {
  return normalizeCues(cues).map((cue, index) => `${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}\n`).join("\n");
}

export function toVtt(cues) {
  return `WEBVTT\n\n${normalizeCues(cues).map((cue) => `${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n${cue.text}\n`).join("\n")}`;
}

function assColor(hex, opacity = 1) {
  const clean = String(hex || "#ffffff").replace("#", "").padEnd(6, "0");
  const alpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${alpha}${clean.slice(4, 6)}${clean.slice(2, 4)}${clean.slice(0, 2)}`;
}

function assTimestamp(ms) {
  const safe = Math.max(0, Math.round(ms / 10) * 10);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  return `${hours}:${String(minutes).padStart(2, "0")}:${((safe % 60_000) / 1000).toFixed(2).padStart(5, "0")}`;
}

function toAss(cues, style = DEFAULT_STYLE, width = 1920, height = 1080) {
  const safeStyle = { ...DEFAULT_STYLE, ...(style || {}) };
  const alignment = safeStyle.position === "top" ? 8 : safeStyle.position === "middle" ? 5 : 2;
  const fontSize = Math.max(16, Math.round(height * Number(safeStyle.fontSizePercent) / 100));
  const margin = Math.round(height * Number(safeStyle.marginPercent) / 100);
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: FreeCap,${safeStyle.fontFamily},${fontSize},${assColor(safeStyle.color)},${assColor(safeStyle.color)},${assColor(safeStyle.outlineColor)},${assColor(safeStyle.backgroundColor, Number(safeStyle.backgroundOpacity))},0,0,0,0,100,100,0,0,1,${safeStyle.outlineWidth},0,${alignment},${Math.round(width * .06)},${Math.round(width * .06)},${margin},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const events = normalizeCues(cues).map((cue) => `Dialogue: 0,${assTimestamp(cue.startMs)},${assTimestamp(cue.endMs)},FreeCap,,0,0,0,,${cue.text.replaceAll("\n", "\\N")}`).join("\n");
  return `${header}${events}\n`;
}

function jobSnapshot(job) {
  return { id: job.id, status: job.status, progress: job.progress, inputPath: job.inputPath, outputDirectory: job.outputDirectory, project: job.project, outputPaths: job.outputPaths, error: job.error };
}

function setJob(job, patch) {
  Object.assign(job, patch);
  return job;
}

async function runCommand(binary, args, job, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    processes.set(job.id, child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      processes.delete(job.id);
      if (job.cancelled || signal === "SIGTERM") return reject(new Error("任務已取消"));
      if (code !== 0) return reject(new Error(stderr.trim() || `FFmpeg 結束碼 ${code}`));
      resolvePromise();
    });
    if (options.onStart) options.onStart(child);
  });
}

function pcm16ToFloat32(buffer) {
  const dataOffset = buffer.indexOf(Buffer.from("data"));
  const start = dataOffset >= 0 ? dataOffset + 8 : 44;
  const channels = buffer.readUInt16LE(22);
  const sampleCount = Math.floor((buffer.length - start) / 2 / channels);
  const output = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += buffer.readInt16LE(start + (index * channels + channel) * 2) / 32768;
    output[index] = sum / channels;
  }
  return output;
}

async function probeDuration(binary, inputPath) {
  return new Promise((resolvePromise) => {
    const child = spawn(binary === "ffmpeg" ? "ffprobe" : binary.replace(/ffmpeg(?:\.exe)?$/, "ffprobe"), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", inputPath], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("close", () => resolvePromise(Number(output.trim()) || 0));
    child.on("error", () => resolvePromise(0));
  });
}

async function transcribeJob(job, language, model) {
  const binary = await resolveBinary();
  const tempAudio = join(tmpdir(), `freecap-${job.id}.wav`);
  try {
    setJob(job, { status: "extracting", progress: 10 });
    await runCommand(binary, ["-hide_banner", "-loglevel", "error", "-i", job.inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tempAudio], job);
    if (job.cancelled) throw new Error("任務已取消");
    setJob(job, { status: "transcribing", progress: 28 });
    const audio = pcm16ToFloat32(await fs.readFile(tempAudio));
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowLocalModels = false;
    env.useFSCache = true;
    const transcriber = await pipeline("automatic-speech-recognition", MODEL_IDS[model] || MODEL_IDS.small, { dtype: "q8", progress_callback: (event) => { if (typeof event?.progress === "number") setJob(job, { progress: 28 + Math.round(event.progress * 0.35) }); } });
    const result = await transcriber(audio, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: "segment", ...(language !== "auto" ? { language } : {}) });
    if (job.cancelled) throw new Error("任務已取消");
    const duration = await probeDuration(binary, job.inputPath);
    const chunks = result.chunks || [];
    const cues = normalizeCues(chunks.flatMap((chunk) => {
      const [start, end] = chunk.timestamp || [null, null];
      if (start == null || end == null || !chunk.text?.trim()) return [];
      return segmentCaptionText(chunk.text, start * 1000, Math.max(end * 1000, start * 1000 + 500), language);
    }), duration * 1000);
    const project = { id: job.id, name: basename(job.inputPath, extname(job.inputPath)), fileName: basename(job.inputPath), fileSize: (await fs.stat(job.inputPath)).size, durationMs: duration * 1000, language, model, cues, style: DEFAULT_STYLE, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    setJob(job, { status: "ready", progress: 100, project });
  } catch (error) {
    if (job.cancelled || error?.message === "任務已取消") setJob(job, { status: "cancelled", progress: 0, error: "任務已取消" });
    else setJob(job, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    await fs.rm(tempAudio, { force: true }).catch(() => undefined);
  }
}

export async function createTranscription(args) {
  const inputPath = await validateInputPath(args.inputPath);
  const outputDirectory = await outputDirectoryFor(inputPath, args.outputDirectory);
  const job = { id: randomUUID(), status: "queued", progress: 0, inputPath, outputDirectory, cancelled: false };
  jobs.set(job.id, job);
  void transcribeJob(job, args.language || "auto", args.model || "small");
  return jobSnapshot(job);
}

export async function updateCues(jobId, cues) {
  const job = jobs.get(jobId);
  if (!job?.project) throw new Error("找不到可編輯的字幕任務");
  const next = normalizeCues(cues, job.project.durationMs);
  if (next.some((cue) => cue.endMs <= cue.startMs)) throw new Error("字幕時間必須是正向區間");
  job.project = { ...job.project, cues: next, updatedAt: new Date().toISOString() };
  return jobSnapshot(job);
}

export async function exportSubtitles(jobId, formats = ["srt", "vtt"]) {
  const job = jobs.get(jobId);
  if (!job?.project) throw new Error("找不到可匯出的字幕任務");
  const written = [];
  const stem = job.project.name;
  for (const format of formats) {
    if (!["srt", "vtt", "json"].includes(format)) throw new Error(`不支援的字幕格式：${format}`);
    const path = await uniqueOutput(job.outputDirectory, stem, `.${format}`);
    const content = format === "srt" ? toSrt(job.project.cues) : format === "vtt" ? toVtt(job.project.cues) : JSON.stringify(job.project, null, 2);
    await fs.writeFile(path, content, "utf8");
    written.push(path);
  }
  setJob(job, { status: "completed", outputPaths: written });
  return jobSnapshot(job);
}

export async function renderSubtitles(jobId, style = DEFAULT_STYLE) {
  const job = jobs.get(jobId);
  if (!job?.project) throw new Error("找不到可渲染的字幕任務");
  const binary = await resolveBinary();
  const assPath = join(job.outputDirectory, `.${job.project.name}-${job.id}.ass`);
  const outputPath = await uniqueOutput(job.outputDirectory, `${job.project.name}-captioned`, ".mp4");
  await fs.writeFile(assPath, toAss(job.project.cues, style), "utf8");
  setJob(job, { status: "rendering", progress: 5 });
  try {
    await runCommand(binary, ["-hide_banner", "-loglevel", "error", "-i", job.inputPath, "-vf", `ass=${assPath.replaceAll("\\", "/").replaceAll(":", "\\:")}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath], job);
    setJob(job, { status: "completed", progress: 100, outputPaths: [outputPath] });
    return jobSnapshot(job);
  } catch (error) {
    if (job.cancelled) setJob(job, { status: "cancelled", error: "任務已取消" });
    else setJob(job, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await fs.rm(assPath, { force: true }).catch(() => undefined);
  }
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("找不到這個 FreeCap 任務");
  return jobSnapshot(job);
}

export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error("找不到這個 FreeCap 任務");
  job.cancelled = true;
  processes.get(job.id)?.kill("SIGTERM");
  if (["queued", "ready"].includes(job.status)) setJob(job, { status: "cancelled", error: "任務已取消" });
  return jobSnapshot(job);
}

export async function startMcpServer() {
  const server = new McpServer({ name: "freecap", version: "0.1.1" });
  server.registerTool("start_transcription", { description: "在本機以 Whisper 辨識影音檔並建立可編輯字幕任務。影片不會上傳。", inputSchema: { inputPath: z.string(), language: z.enum(["auto", "zh", "en"]).optional(), model: z.enum(["tiny", "base", "small"]).optional(), outputDirectory: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: false } }, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await createTranscription(args), null, 2) }] }));
  server.registerTool("get_job", { description: "查詢 FreeCap 本機字幕任務進度、狀態與輸出檔案。", inputSchema: { jobId: z.string() }, annotations: { readOnlyHint: true } }, async ({ jobId }) => ({ content: [{ type: "text", text: JSON.stringify(getJob(jobId), null, 2) }] }));
  server.registerTool("update_cues", { description: "更新字幕文字與起訖時間；會重新排序並拒絕空白或重疊字幕。", inputSchema: { jobId: z.string(), cues: z.array(z.object({ id: z.string().optional(), startMs: z.number(), endMs: z.number(), text: z.string(), confidence: z.number().optional() })) }, annotations: { readOnlyHint: false, destructiveHint: false } }, async ({ jobId, cues }) => ({ content: [{ type: "text", text: JSON.stringify(await updateCues(jobId, cues), null, 2) }] }));
  server.registerTool("export_subtitles", { description: "將 FreeCap 任務字幕輸出成 UTF-8 SRT、VTT 或 JSON。", inputSchema: { jobId: z.string(), formats: z.array(z.enum(["srt", "vtt", "json"])).optional() }, annotations: { readOnlyHint: false, destructiveHint: false } }, async ({ jobId, formats }) => ({ content: [{ type: "text", text: JSON.stringify(await exportSubtitles(jobId, formats || ["srt", "vtt"]), null, 2) }] }));
  server.registerTool("start_render", { description: "用 FFmpeg 在本機將字幕燒錄進 MP4，輸出到 FreeCap Output，絕不覆寫來源影片。", inputSchema: { jobId: z.string(), style: z.object({ fontFamily: z.string().optional(), fontSizePercent: z.number().optional(), color: z.string().optional(), outlineColor: z.string().optional(), outlineWidth: z.number().optional(), backgroundColor: z.string().optional(), backgroundOpacity: z.number().optional(), position: z.enum(["bottom", "middle", "top"]).optional(), marginPercent: z.number().optional() }).optional() }, annotations: { readOnlyHint: false, destructiveHint: false } }, async ({ jobId, style }) => ({ content: [{ type: "text", text: JSON.stringify(await renderSubtitles(jobId, style), null, 2) }] }));
  server.registerTool("cancel_job", { description: "取消本機辨識或轉檔任務並清理暫存檔。", inputSchema: { jobId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } }, async ({ jobId }) => ({ content: [{ type: "text", text: JSON.stringify(cancelJob(jobId), null, 2) }] }));
  await server.connect(new StdioServerTransport());
}

function readJson(request) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 1_000_000) reject(new Error("request too large")); });
    request.on("end", () => { try { resolvePromise(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    request.on("error", reject);
  });
}

function bridgeResponse(response, status, payload, origin) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": origin || "http://localhost:3000", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PATCH, OPTIONS", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
}

export function startBridge(port = Number(process.env.FREECAP_BRIDGE_PORT || 47831)) {
  const token = process.env.FREECAP_BRIDGE_TOKEN || randomBytes(24).toString("hex");
  const originAllowlist = new Set(["http://localhost:3000", "http://127.0.0.1:3000", process.env.FREECAP_WEB_ORIGIN].filter(Boolean));
  const httpServer = createServer(async (request, response) => {
    const origin = originAllowlist.has(request.headers.origin) ? request.headers.origin : "http://localhost:3000";
    if (request.method === "OPTIONS") return bridgeResponse(response, 204, {}, origin);
    if (request.url === "/health" && request.method === "GET") return bridgeResponse(response, 200, { ok: true, name: "freecap", version: "0.1.1" }, origin);
    if (request.headers.authorization !== `Bearer ${token}`) return bridgeResponse(response, 401, { error: "配對權杖無效" }, origin);
    try {
      const parsed = new URL(request.url, `http://127.0.0.1:${port}`);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (request.method === "POST" && parts.length === 1 && parts[0] === "jobs") return bridgeResponse(response, 202, await createTranscription(await readJson(request)), origin);
      if (parts[0] !== "jobs" || !parts[1]) return bridgeResponse(response, 404, { error: "not found" }, origin);
      const jobId = parts[1];
      if (request.method === "GET" && parts.length === 2) return bridgeResponse(response, 200, getJob(jobId), origin);
      if (request.method === "PATCH" && parts[2] === "cues") return bridgeResponse(response, 200, await updateCues(jobId, (await readJson(request)).cues || []), origin);
      if (request.method === "POST" && parts[2] === "export") return bridgeResponse(response, 200, await exportSubtitles(jobId, (await readJson(request)).formats || ["srt", "vtt"]), origin);
      if (request.method === "POST" && parts[2] === "render") return bridgeResponse(response, 200, await renderSubtitles(jobId, (await readJson(request)).style), origin);
      if (request.method === "POST" && parts[2] === "cancel") return bridgeResponse(response, 200, cancelJob(jobId), origin);
      return bridgeResponse(response, 404, { error: "not found" }, origin);
    } catch (error) {
      return bridgeResponse(response, 400, { error: error instanceof Error ? error.message : String(error) }, origin);
    }
  });
  httpServer.listen(port, "127.0.0.1", () => { console.error(`FreeCap bridge listening on http://127.0.0.1:${port}`); console.error(`Pairing token: ${token}`); });
  return httpServer;
}
