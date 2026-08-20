export type CaptionLanguage = "auto" | "zh" | "en";
export type CaptionModel = "tiny" | "base" | "small";

export type CaptionCue = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
};

export type CaptionStyle = {
  fontFamily: string;
  fontSizePercent: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  backgroundColor: string;
  backgroundOpacity: number;
  position: "bottom" | "middle" | "top";
  marginPercent: number;
};

export type CaptionProject = {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
  language: CaptionLanguage;
  model: CaptionModel;
  cues: CaptionCue[];
  style: CaptionStyle;
  createdAt: string;
  updatedAt: string;
};

export type CaptionJobStatus =
  | "queued"
  | "extracting"
  | "transcribing"
  | "ready"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled";

export type CaptionJob = {
  id: string;
  status: CaptionJobStatus;
  progress: number;
  inputPath: string;
  outputDirectory: string;
  project?: CaptionProject;
  outputPaths?: string[];
  error?: string;
};
