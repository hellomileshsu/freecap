import { fromWhisperChunks, uid } from "./subtitles";
import type { CaptionCue, CaptionLanguage, CaptionModel } from "./types";

const MODEL_IDS: Record<CaptionModel, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
};

type Progress = (value: number, label: string) => void;

export async function transcribeBrowserFile(
  file: File,
  language: CaptionLanguage,
  model: CaptionModel,
  onProgress: Progress = () => undefined,
): Promise<CaptionCue[]> {
  onProgress(4, "準備本機音訊引擎");
  const [{ FFmpeg }, { fetchFile, toBlobURL }, { pipeline, env }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
    import("@huggingface/transformers"),
  ]);

  env.allowLocalModels = false;
  env.useBrowserCache = true;
  const ffmpeg = new FFmpeg();
  const coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
  });
  onProgress(18, "擷取影片音訊");
  await ffmpeg.writeFile("freecap-input", await fetchFile(file));
  await ffmpeg.exec(["-i", "freecap-input", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "freecap-audio.wav"]);
  const audioData = await ffmpeg.readFile("freecap-audio.wav");
  const audioBlob = new Blob([audioData as Uint8Array], { type: "audio/wav" });
  const audioUrl = URL.createObjectURL(audioBlob);

  onProgress(28, `載入 ${model} 語音模型`);
  const device = "gpu" in navigator && (navigator as Navigator & { gpu?: unknown }).gpu ? "webgpu" : "wasm";
  const transcriber = await pipeline("automatic-speech-recognition", MODEL_IDS[model], {
    device,
    dtype: device === "webgpu" ? "fp16" : "q8",
    progress_callback: (event: { progress?: number }) => {
      if (typeof event.progress === "number") onProgress(28 + Math.round(event.progress * 0.32), "下載並快取模型");
    },
  });
  onProgress(62, "本機辨識中");
  const output = await transcriber(audioUrl, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: "segment",
    ...(language !== "auto" ? { language } : {}),
  });
  URL.revokeObjectURL(audioUrl);
  onProgress(92, "整理字幕時間軸");
  const chunks = "chunks" in output ? output.chunks : [];
  const cues = fromWhisperChunks(chunks as Array<{ text?: string; timestamp?: [number | null, number | null] }>);
  onProgress(100, "辨識完成");
  return cues.length ? cues : [{ id: uid(), startMs: 0, endMs: 2500, text: output.text?.trim() || "（沒有偵測到語音）" }];
}
