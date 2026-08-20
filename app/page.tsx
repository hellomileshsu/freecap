"use client";
/* The editor overlay is the caption track; the video element is intentionally controlled by the custom player. */
/* eslint-disable jsx-a11y/media-has-caption, jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-element-interactions */

import { useEffect, useRef, useState } from "react";
import { transcribeBrowserFile } from "../src/core/browser-transcription";
import {
  DEFAULT_STYLE,
  DEMO_CUES,
  formatTimestamp,
  mergeCues,
  normalizeCues,
  splitCue,
  toSrt,
  toVtt,
  uid,
} from "../src/core/subtitles";
import type { CaptionCue, CaptionLanguage, CaptionModel, CaptionStyle } from "../src/core/types";

type Stage = "empty" | "ready" | "processing" | "editing" | "exported";
const ACCEPTED_TYPES = ".mp4,.mov,.webm,.m4v,.mkv,.avi,.wav,.mp3,.m4a";

function formatFileSize(bytes: number) {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes > 100_000_000 ? 0 : 1)} MB`;
}

function formatDuration(ms: number) {
  if (!ms) return "—";
  return formatTimestamp(ms, ":").slice(0, 8);
}

function downloadFile(name: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function openLocalStore() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open("freecap", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

async function saveLocalProject(project: object & { id: string }) {
  try {
    const db = await openLocalStore();
    const tx = db.transaction("projects", "readwrite");
    tx.objectStore("projects").put(project);
  } catch {
    // Private browsing may disable IndexedDB; the editor remains usable.
  }
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [outputUrl, setOutputUrl] = useState("");
  const [durationMs, setDurationMs] = useState(0);
  const [cues, setCues] = useState<CaptionCue[]>(DEMO_CUES);
  const [activeCueId, setActiveCueId] = useState(DEMO_CUES[0].id);
  const [language, setLanguage] = useState<CaptionLanguage>("auto");
  const [model, setModel] = useState<CaptionModel>("small");
  const [style, setStyle] = useState<CaptionStyle>(DEFAULT_STYLE);
  const [stage, setStage] = useState<Stage>("empty");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("等待影片");
  const [notice, setNotice] = useState("所有處理都在你的裝置上完成");
  const [isDragging, setIsDragging] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [showStyle, setShowStyle] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [replaceTerm, setReplaceTerm] = useState("");
  const [undoStack, setUndoStack] = useState<CaptionCue[][]>([]);
  const [redoStack, setRedoStack] = useState<CaptionCue[][]>([]);
  const [currentMs, setCurrentMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [copied, setCopied] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const activeCue = cues.find((cue) => cue.id === activeCueId) ?? cues[0];
  const isDemo = !file;
  const fileTooLarge = Boolean(file && (file.size > 500_000_000 || durationMs > 3_600_000));
  const progressWidth = `${Math.max(0, Math.min(100, progress))}%`;

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      if (outputUrl) URL.revokeObjectURL(outputUrl);
    };
  }, [videoUrl, outputUrl]);

  useEffect(() => {
    if (!file) return;
    void saveLocalProject({
      id: "current",
      fileName: file.name,
      fileSize: file.size,
      durationMs,
      language,
      model,
      cues,
      style,
      updatedAt: new Date().toISOString(),
    });
  }, [file, durationMs, language, model, cues, style]);

  function replaceCues(next: CaptionCue[], remember = true) {
    const normalized = normalizeCues(next, durationMs || Number.POSITIVE_INFINITY);
    if (remember) {
      setUndoStack((stack) => [...stack.slice(-29), cues]);
      setRedoStack([]);
    }
    setCues(normalized);
    setActiveCueId((current) => normalized.some((cue) => cue.id === current) ? current : normalized[0]?.id ?? "");
  }

  function selectFile(selected: File | undefined) {
    if (!selected) return;
    if (!selected.type.startsWith("video/") && !selected.type.startsWith("audio/")) {
      setNotice("請選擇 MP4、MOV、WebM、MKV 或音訊檔");
      return;
    }
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    const url = URL.createObjectURL(selected);
    setFile(selected);
    setVideoUrl(url);
    setOutputUrl("");
    setDurationMs(0);
    setCues([]);
    setStage("ready");
    setProgress(0);
    setProgressLabel("已匯入，準備辨識");
    setNotice("影片只會留在這個瀏覽器分頁");
    setUndoStack([]);
    setRedoStack([]);
  }

  async function startTranscription() {
    if (!file) return;
    setStage("processing");
    setProgress(2);
    setProgressLabel("準備本機模型");
    setNotice(fileTooLarge ? "檔案較大，建議使用本機助手；瀏覽器仍會嘗試處理" : "第一次使用會下載模型並快取在本機");
    try {
      const next = await transcribeBrowserFile(file, language, model, (value, label) => {
        setProgress(value);
        setProgressLabel(label);
      });
      replaceCues(next, false);
      setStage("editing");
      setNotice("辨識完成。點選字幕列即可編輯文字與時間");
    } catch (error) {
      setStage("ready");
      setProgress(0);
      setProgressLabel("辨識未完成");
      setNotice(error instanceof Error ? `本機辨識失敗：${error.message}` : "本機辨識失敗，請再試一次");
    }
  }

  function setVideoTime(ms: number) {
    const safe = Math.max(0, Math.min(ms, durationMs || Number.POSITIVE_INFINITY));
    setCurrentMs(safe);
    if (videoRef.current) videoRef.current.currentTime = safe / 1000;
  }

  function togglePlayback() {
    if (!videoRef.current || !file) return;
    if (videoRef.current.paused) void videoRef.current.play();
    else videoRef.current.pause();
  }

  function editCue(id: string, patch: Partial<CaptionCue>) {
    replaceCues(cues.map((cue) => (cue.id === id ? { ...cue, ...patch } : cue)));
  }

  function removeCue(id: string) {
    replaceCues(cues.filter((cue) => cue.id !== id));
  }

  function splitActive() {
    if (!activeCue) return;
    const pivot = activeCue.startMs + Math.round((activeCue.endMs - activeCue.startMs) / 2);
    replaceCues([...cues.filter((cue) => cue.id !== activeCue.id), ...splitCue(activeCue, pivot)]);
  }

  function mergeActive() {
    const index = cues.findIndex((cue) => cue.id === activeCueId);
    if (index < 0 || index >= cues.length - 1) return;
    const next = [...cues];
    next.splice(index, 2, mergeCues(cues[index], cues[index + 1]));
    replaceCues(next);
  }

  function replaceText() {
    if (!searchTerm || !cues.length) return;
    const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(escaped, "gi");
    const next = cues.map((cue) => ({ ...cue, text: cue.text.replace(matcher, replaceTerm) }));
    if (next.some((cue, index) => cue.text !== cues[index]?.text)) {
      replaceCues(next);
      setNotice(`已將「${searchTerm}」全部取代`);
    } else {
      setNotice(`找不到「${searchTerm}」`);
    }
  }

  function undo() {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setRedoStack((stack) => [...stack, cues]);
    setUndoStack((stack) => stack.slice(0, -1));
    setCues(previous);
    setActiveCueId(previous[0]?.id ?? "");
  }

  function redo() {
    const next = redoStack.at(-1);
    if (!next) return;
    setUndoStack((stack) => [...stack, cues]);
    setRedoStack((stack) => stack.slice(0, -1));
    setCues(next);
    setActiveCueId(next[0]?.id ?? "");
  }

  function exportSubtitles(kind: "srt" | "vtt") {
    if (!cues.length) return;
    const stem = (file?.name ?? "freecap-subtitles").replace(/\.[^/.]+$/, "");
    downloadFile(`${stem}.${kind}`, kind === "srt" ? toSrt(cues) : toVtt(cues), kind === "srt" ? "application/x-subrip" : "text/vtt");
    setStage("exported");
    setNotice(`${kind.toUpperCase()} 已下載，字幕仍可繼續編輯`);
  }

  async function renderVideo() {
    if (!file || !cues.length) return;
    setStage("processing");
    setProgress(4);
    setProgressLabel("載入本機影片渲染器");
    setNotice("燒錄字幕會重新編碼影片，時間取決於影片長度與裝置速度");
    try {
      const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([import("@ffmpeg/ffmpeg"), import("@ffmpeg/util")]);
      const ffmpeg = new FFmpeg();
      const coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
      await ffmpeg.load({
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
      });
      setProgress(24);
      await ffmpeg.writeFile("freecap-input", await fetchFile(file));
      const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: FreeCap,${style.fontFamily},${Math.round(1080 * style.fontSizePercent / 100)},&H00F0FAFF,&H00F0FAFF,&H001A1310,&H${Math.round((1 - style.backgroundOpacity) * 255).toString(16).padStart(2, "0")}1A1310,0,0,0,0,100,100,0,0,1,${style.outlineWidth},0,${style.position === "top" ? 8 : style.position === "middle" ? 5 : 2},100,100,${Math.round(1080 * style.marginPercent / 100)},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${cues.map((cue) => `Dialogue: 0,${assTimestamp(cue.startMs)},${assTimestamp(cue.endMs)},FreeCap,,0,0,0,,${cue.text.replaceAll("\n", "\\N")}`).join("\n")}\n`;
      await ffmpeg.writeFile("freecap.ass", ass);
      setProgress(42);
      await ffmpeg.exec(["-i", "freecap-input", "-vf", "ass=freecap.ass", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "freecap-captioned.mp4"]);
      setProgress(92);
      const output = await ffmpeg.readFile("freecap-captioned.mp4");
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      const nextUrl = URL.createObjectURL(new Blob([output as Uint8Array], { type: "video/mp4" }));
      setOutputUrl(nextUrl);
      setVideoUrl(nextUrl);
      setStage("exported");
      setProgress(100);
      setProgressLabel("影片完成");
      setNotice("燒錄字幕影片已準備好，可以播放或下載");
    } catch (error) {
      setStage("editing");
      setProgress(0);
      setProgressLabel("渲染未完成");
      setNotice(error instanceof Error ? `影片渲染失敗：${error.message}` : "影片渲染失敗，建議改用本機助手");
    }
  }

  function copyText(key: string, text: string) {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1_500);
  }

  const stageLabel = stage === "empty" ? "開始一個專案" : stage === "ready" ? "準備辨識" : stage === "processing" ? "本機處理中" : stage === "exported" ? "可以交付" : "字幕編輯中";
  const installCommand = "npx -y github:hellomileshsu/freecap#v1.1 mcp";
  const mcpConfig = `{"mcpServers":{"freecap":{"command":"npx","args":["-y","github:hellomileshsu/freecap#v1.1","mcp"]}}}`;

  return (
    <main className="freecap-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="FreeCap 首頁"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>Free<span className="brand-accent">Cap</span></span></a>
        <div className="topbar-meta"><span className="privacy-pill"><span className="status-dot" />本機優先</span><span className="version-label">v0.1.1 · GPL-3.0</span><button className="icon-button" type="button" onClick={() => setShowMcp(true)} aria-label="開啟 MCP 安裝說明">⌘</button></div>
      </header>

      <section className="hero" id="top"><div className="hero-copy"><p className="eyebrow"><span className="eyebrow-line" />FREE / LOCAL / OPEN</p><h1>字幕，留在<br /><em>你的電腦裡。</em></h1><p className="hero-subtitle">FreeCap 把影片變成可編輯字幕。無 API key、無雲端上傳，讓 Whisper 在你的裝置上安靜工作。</p><div className="hero-proof"><span>●</span> Claude · Cursor · Codex 都能呼叫</div></div><div className="hero-orbit" aria-hidden="true"><div className="orbit-ring orbit-ring-one" /><div className="orbit-ring orbit-ring-two" /><div className="orbit-core"><span>CC</span><small>LOCAL</small></div><span className="orbit-tag orbit-tag-a">WHISPER</span><span className="orbit-tag orbit-tag-b">MCP</span><span className="orbit-tag orbit-tag-c">NO CLOUD</span></div></section>

      <section className="workbench" aria-labelledby="workbench-title"><div className="workbench-heading"><div><p className="section-kicker">01 / WORKSPACE</p><h2 id="workbench-title">把影片放進來。</h2></div><div className="stage-indicator"><span className={`stage-number stage-${stage}`} />{stageLabel}</div></div><div className="notice-bar"><span>◉</span>{notice}</div>
        {!file ? <div className={`dropzone ${isDragging ? "is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setIsDragging(false)} onDrop={(event) => { event.preventDefault(); setIsDragging(false); selectFile(event.dataTransfer.files[0]); }} onClick={() => inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }}><input ref={inputRef} type="file" accept={ACCEPTED_TYPES} onChange={(event) => selectFile(event.target.files?.[0])} hidden /><div className="dropzone-icon" aria-hidden="true"><span>＋</span></div><div className="dropzone-copy"><strong>拖曳影片到這裡</strong><span>或點擊選擇檔案</span></div><div className="dropzone-formats"><span>MP4</span><span>MOV</span><span>WEBM</span><span>MKV</span><i />最大建議 500 MB / 60 分鐘</div></div> : <div className="project-grid"><section className="preview-panel" aria-label="影片預覽"><div className="panel-topline"><span className="panel-label">PREVIEW / {file.type.split("/")[1]?.toUpperCase() ?? "VIDEO"}</span><span className="panel-meta">{formatFileSize(file.size)} · {formatDuration(durationMs)}</span></div><div className="video-stage"><video ref={videoRef} src={videoUrl} onLoadedMetadata={(event) => setDurationMs(Math.round(event.currentTarget.duration * 1000))} onTimeUpdate={(event) => { setCurrentMs(Math.round(event.currentTarget.currentTime * 1000)); setIsPlaying(!event.currentTarget.paused); }} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} controls={false} aria-label={`${file.name} 影片預覽`} />{activeCue && stage !== "processing" && <div className="video-caption-preview">{activeCue.text}</div>}<button className="video-play" type="button" onClick={togglePlayback} aria-label={isPlaying ? "暫停" : "播放"}>{isPlaying ? "Ⅱ" : "▶"}</button><span className="video-timecode">{formatTimestamp(currentMs)} / {formatTimestamp(durationMs)}</span></div><div className="scrub-track"><span style={{ width: `${durationMs ? (currentMs / durationMs) * 100 : 0}%` }} /><input aria-label="影片時間軸" type="range" min={0} max={durationMs || 1} value={currentMs} onChange={(event) => setVideoTime(Number(event.target.value))} /></div><div className="preview-actions"><button type="button" className="ghost-button" onClick={() => { setFile(null); setStage("empty"); setCues(DEMO_CUES); }}>換一部影片</button><span className="privacy-note">◉ 瀏覽器本機處理</span></div></section><section className="controls-panel" aria-label="辨識設定"><div className="panel-topline"><span className="panel-label">ENGINE / LOCAL WHISPER</span><span className="engine-status"><span className="status-dot" />READY</span></div><div className="control-block"><label htmlFor="language">語音語言</label><div className="segmented" id="language">{([["auto", "自動"], ["zh", "中文"], ["en", "English"]] as const).map(([value, label]) => <button key={value} className={language === value ? "selected" : ""} type="button" onClick={() => setLanguage(value)}>{label}</button>)}</div></div><div className="control-block"><label htmlFor="model">辨識模型 <span>越大越準，首次下載較久</span></label><select id="model" value={model} onChange={(event) => setModel(event.target.value as CaptionModel)}><option value="tiny">Tiny · 最快（約 75 MB）</option><option value="base">Base · 平衡（約 150 MB）</option><option value="small">Small · 品質優先（約 500 MB）</option></select></div><div className="engine-note"><span className="note-symbol">✦</span><p>{fileTooLarge ? "這部影片較大，建議啟動 FreeCap 本機助手，避免瀏覽器記憶體壓力。" : "模型會快取到你的瀏覽器。之後相同模型可以離線重用。"}</p></div>{stage === "processing" ? <div className="progress-card"><div className="progress-row"><span>{progressLabel}</span><strong>{progress}%</strong></div><div className="progress-track"><span style={{ width: progressWidth }} /></div><small>請保持此分頁開啟，影片不會離開裝置。</small></div> : <button className="primary-button transcribe-button" type="button" onClick={startTranscription}><span>開始本機辨識</span><b>↗</b></button>}<div className="micro-trust"><span>NO API KEY</span><span>NO UPLOAD</span><span>OPEN SOURCE</span></div></section></div>}
      </section>

      <section className={`editor-section ${isDemo ? "is-demo" : ""}`} aria-labelledby="editor-title"><div className="editor-heading"><div><p className="section-kicker">02 / CAPTION EDITOR</p><h2 id="editor-title">校對每一個字。</h2></div><div className="editor-tools"><button type="button" onClick={undo} disabled={!undoStack.length} aria-label="復原">↺ <span>復原</span></button><button type="button" onClick={redo} disabled={!redoStack.length} aria-label="重做">↻ <span>重做</span></button><span className="cue-count">{cues.length || 0} CUES</span></div></div><div className="editor-card"><div className="editor-toolbar"><div className="toolbar-left"><span className="caption-file">{isDemo ? "demo-caption.fc" : `${file.name.replace(/\.[^/.]+$/, "")}.fc`}</span><span className="dirty-dot" />{isDemo ? "預覽資料" : "已自動儲存"}</div><div className="toolbar-right"><button type="button" className="tool-button" onClick={() => setShowSearch(!showSearch)}>⌕ <span>搜尋取代</span></button><button type="button" className="tool-button" onClick={() => setShowStyle(!showStyle)}>Aa <span>樣式</span></button><button type="button" className="tool-button" onClick={splitActive} disabled={!activeCue}>切分</button><button type="button" className="tool-button" onClick={mergeActive} disabled={!activeCue}>合併</button></div></div>{showSearch && <div className="search-panel"><label>搜尋<input type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="要找的字詞" /></label><label>取代為<input type="text" value={replaceTerm} onChange={(event) => setReplaceTerm(event.target.value)} placeholder="新的字詞" /></label><button type="button" className="tool-button" onClick={replaceText} disabled={!searchTerm}>全部取代</button></div>}<div className="cue-table-head"><span>#</span><span>時間（秒）</span><span>字幕文字</span><span>信心度</span><span /></div><div className="cue-list">{(cues.length ? cues : [{ id: "empty", startMs: 0, endMs: 0, text: "辨識後，字幕會出現在這裡。" }]).map((cue, index) => <div className={`cue-row ${activeCueId === cue.id ? "active" : ""} ${cue.id === "empty" ? "empty-row" : ""}`} key={cue.id} onClick={() => cue.id !== "empty" && setActiveCueId(cue.id)}><span className="cue-index">{String(index + 1).padStart(2, "0")}</span><div className="cue-times">{cue.id === "empty" ? <span>—</span> : <><label><span className="sr-only">第 {index + 1} 段開始秒數</span><input className="time-input" type="number" min="0" step="0.01" value={(cue.startMs / 1000).toFixed(2)} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) editCue(cue.id, { startMs: Math.round(value * 1000) }); }} /></label><i>→</i><label><span className="sr-only">第 {index + 1} 段結束秒數</span><input className="time-input" type="number" min="0" step="0.01" value={(cue.endMs / 1000).toFixed(2)} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) editCue(cue.id, { endMs: Math.round(value * 1000) }); }} /></label></>}</div>{cue.id === "empty" ? <span className="empty-cue-copy">{cue.text}</span> : <textarea aria-label={`第 ${index + 1} 段字幕`} value={cue.text} onChange={(event) => editCue(cue.id, { text: event.target.value })} rows={1} />}<span className={`confidence confidence-${Math.round((cue.confidence ?? 0.93) * 10)}`}>{Math.round((cue.confidence ?? 0.93) * 100)}%</span>{cue.id !== "empty" ? <button type="button" className="delete-cue" onClick={(event) => { event.stopPropagation(); removeCue(cue.id); }} aria-label={`刪除第 ${index + 1} 段字幕`}>×</button> : <span />}</div>)}</div><button type="button" className="add-cue" onClick={() => { const start = activeCue?.endMs ?? currentMs; const next = { id: uid(), startMs: start, endMs: start + 1800, text: "新增字幕" }; replaceCues([...cues, next]); setActiveCueId(next.id); }}>＋ 新增字幕段落</button></div>{showStyle && <div className="style-panel"><div><strong>字幕樣式</strong><span>燒錄影片時套用</span></div><label>大小 <input type="range" min="3" max="7" step="0.1" value={style.fontSizePercent} onChange={(event) => setStyle({ ...style, fontSizePercent: Number(event.target.value) })} /></label><label>位置 <select value={style.position} onChange={(event) => setStyle({ ...style, position: event.target.value as CaptionStyle["position"] })}><option value="bottom">底部</option><option value="middle">中央</option><option value="top">頂部</option></select></label><label>文字色 <input type="color" value={style.color} onChange={(event) => setStyle({ ...style, color: event.target.value })} /></label></div>}</section>

      <section className="export-section" aria-labelledby="export-title"><div className="export-heading"><div><p className="section-kicker">03 / DELIVERY</p><h2 id="export-title">帶走你的字幕。</h2></div><span className="export-lock">LOCAL EXPORT ONLY</span></div><div className="export-grid"><button className="export-card" type="button" onClick={() => exportSubtitles("srt")} disabled={!cues.length}><span className="export-card-label">SRT</span><strong>通用字幕檔</strong><small>適合 YouTube、Premiere、剪映</small><b>下載 ↗</b></button><button className="export-card" type="button" onClick={() => exportSubtitles("vtt")} disabled={!cues.length}><span className="export-card-label">VTT</span><strong>網頁字幕檔</strong><small>適合 HTML5 video、線上課程</small><b>下載 ↗</b></button><button className="export-card export-card-featured" type="button" onClick={renderVideo} disabled={!file || !cues.length || stage === "processing"}><span className="export-card-label">MP4 + CC</span><strong>燒錄字幕影片</strong><small>字幕直接嵌進影片畫面</small><b>開始渲染 ↗</b></button></div>{outputUrl && <div className="output-ready"><span className="output-icon">✓</span><div><strong>影片已完成</strong><span>字幕已燒錄，仍然只在你的裝置上</span></div><a className="primary-button" href={outputUrl} download={`${file?.name.replace(/\.[^/.]+$/, "") ?? "freecap"}-captioned.mp4`}>下載 MP4 ↗</a></div>}</section>

      <section className="mcp-banner" aria-labelledby="mcp-title"><div className="mcp-banner-mark" aria-hidden="true"><span>↯</span></div><div className="mcp-banner-copy"><p className="section-kicker">FOR YOUR AI TOOLS</p><h2 id="mcp-title">讓 Claude、Cursor、Codex<br /><em>替你處理影片。</em></h2><p>安裝一次本機 MCP，AI 就能讀取影片、校對字幕、輸出成品。影片路徑只會在本機流動。</p></div><div className="mcp-banner-action"><code>{installCommand}</code><button type="button" onClick={() => copyText("banner", installCommand)}>{copied === "banner" ? "已複製 ✓" : "複製安裝指令"}</button><button type="button" className="text-link" onClick={() => setShowMcp(true)}>查看設定說明 →</button></div></section>

      <footer className="footer"><div className="footer-brand"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>Free<span className="brand-accent">Cap</span></span></div><span>Free forever · local by default</span><div className="footer-links"><a href="https://github.com/hellomileshsu/freecap" target="_blank" rel="noreferrer">GitHub ↗</a><button type="button" onClick={() => setShowMcp(true)}>MCP 設定</button></div></footer>

      {showMcp && <div className="modal-backdrop" role="presentation" onClick={() => setShowMcp(false)}><section className="mcp-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-modal-title" onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setShowMcp(false)} aria-label="關閉">×</button><p className="section-kicker">LOCAL MCP / SETUP</p><h2 id="mcp-modal-title">把 FreeCap 接進你的工作流。</h2><p className="modal-lead">本機 MCP 會以 stdio 執行，不開放網路埠給外部。第一次呼叫時，模型會下載並快取 Whisper。</p><div className="setup-step"><span>01</span><div><strong>Claude Code / Codex</strong><div className="code-row"><code>{installCommand}</code><button type="button" onClick={() => copyText("command", installCommand)}>{copied === "command" ? "✓" : "複製"}</button></div></div></div><div className="setup-step"><span>02</span><div><strong>Cursor / 其他 MCP Client</strong><div className="code-row code-block"><code>{mcpConfig}</code><button type="button" onClick={() => copyText("json", mcpConfig)}>{copied === "json" ? "✓" : "複製"}</button></div></div></div><div className="setup-warning"><span>ⓘ</span><p>ChatGPT 網頁版目前只接受遠端 MCP，不能直接啟動本機程序。FreeCap 的零成本支援先以 Claude Code、Cursor、Codex 為主。</p></div><a href="https://github.com/hellomileshsu/freecap#readme" target="_blank" rel="noreferrer" className="modal-doc-link">閱讀完整安裝文件 ↗</a></section></div>}
    </main>
  );
}

function assTimestamp(ms: number) {
  const safe = Math.max(0, Math.round(ms / 10) * 10);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = ((safe % 60_000) / 1000).toFixed(2).padStart(5, "0");
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}
