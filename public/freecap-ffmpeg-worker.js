/*
 * FreeCap FFmpeg worker, adapted from @ffmpeg/ffmpeg 0.12.15 (MIT).
 *
 * This file is served from public/ so Vite does not inject its browser-only
 * HMR client into the worker during local development. Web Workers do not have
 * a `window` global, which otherwise makes FFmpeg fail before loading its WASM.
 */

const CORE_URL = "https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd/ffmpeg-core.js";
const FFMessageType = {
  LOAD: "LOAD",
  EXEC: "EXEC",
  FFPROBE: "FFPROBE",
  WRITE_FILE: "WRITE_FILE",
  READ_FILE: "READ_FILE",
  DELETE_FILE: "DELETE_FILE",
  RENAME: "RENAME",
  CREATE_DIR: "CREATE_DIR",
  LIST_DIR: "LIST_DIR",
  DELETE_DIR: "DELETE_DIR",
  ERROR: "ERROR",
  DOWNLOAD: "DOWNLOAD",
  PROGRESS: "PROGRESS",
  LOG: "LOG",
  MOUNT: "MOUNT",
  UNMOUNT: "UNMOUNT",
};

const ERROR_UNKNOWN_MESSAGE_TYPE = new Error("unknown message type");
const ERROR_NOT_LOADED = new Error("ffmpeg is not loaded, call `await ffmpeg.load()` first");
const ERROR_IMPORT_FAILURE = new Error("failed to import ffmpeg-core.js");

let ffmpeg;

async function load({ coreURL: requestedCoreURL, wasmURL: requestedWasmURL, workerURL: requestedWorkerURL }) {
  const first = !ffmpeg;
  let coreURL = requestedCoreURL;
  try {
    if (!coreURL) coreURL = CORE_URL;
    importScripts(coreURL);
  } catch {
    if (!coreURL || coreURL === CORE_URL) coreURL = CORE_URL.replace("/umd/", "/esm/");
    self.createFFmpegCore = (await import(coreURL)).default;
    if (!self.createFFmpegCore) throw ERROR_IMPORT_FAILURE;
  }

  const wasmURL = requestedWasmURL || coreURL.replace(/\.js$/g, ".wasm");
  const workerURL = requestedWorkerURL || coreURL.replace(/\.js$/g, ".worker.js");
  ffmpeg = await self.createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify({ wasmURL, workerURL }))}`,
  });
  ffmpeg.setLogger((data) => self.postMessage({ type: FFMessageType.LOG, data }));
  ffmpeg.setProgress((data) => self.postMessage({ type: FFMessageType.PROGRESS, data }));
  return first;
}

function exec({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.exec(...args);
  const result = ffmpeg.ret;
  ffmpeg.reset();
  return result;
}

function ffprobe({ args, timeout = -1 }) {
  ffmpeg.setTimeout(timeout);
  ffmpeg.ffprobe(...args);
  const result = ffmpeg.ret;
  ffmpeg.reset();
  return result;
}

function writeFile({ path, data }) {
  ffmpeg.FS.writeFile(path, data);
  return true;
}

function readFile({ path, encoding }) {
  return ffmpeg.FS.readFile(path, { encoding });
}

function deleteFile({ path }) {
  ffmpeg.FS.unlink(path);
  return true;
}

function rename({ oldPath, newPath }) {
  ffmpeg.FS.rename(oldPath, newPath);
  return true;
}

function createDir({ path }) {
  ffmpeg.FS.mkdir(path);
  return true;
}

function listDir({ path }) {
  return ffmpeg.FS.readdir(path).map((name) => {
    const stat = ffmpeg.FS.stat(`${path}/${name}`);
    return { name, isDir: ffmpeg.FS.isDir(stat.mode) };
  });
}

function deleteDir({ path }) {
  ffmpeg.FS.rmdir(path);
  return true;
}

function mount({ fsType, options, mountPoint }) {
  const fileSystem = ffmpeg.FS.filesystems[fsType];
  if (!fileSystem) return false;
  ffmpeg.FS.mount(fileSystem, options, mountPoint);
  return true;
}

function unmount({ mountPoint }) {
  ffmpeg.FS.unmount(mountPoint);
  return true;
}

self.onmessage = async ({ data: { id, type, data: input } }) => {
  const transfer = [];
  let data;
  try {
    if (type !== FFMessageType.LOAD && !ffmpeg) throw ERROR_NOT_LOADED;
    switch (type) {
      case FFMessageType.LOAD:
        data = await load(input);
        break;
      case FFMessageType.EXEC:
        data = exec(input);
        break;
      case FFMessageType.FFPROBE:
        data = ffprobe(input);
        break;
      case FFMessageType.WRITE_FILE:
        data = writeFile(input);
        break;
      case FFMessageType.READ_FILE:
        data = readFile(input);
        break;
      case FFMessageType.DELETE_FILE:
        data = deleteFile(input);
        break;
      case FFMessageType.RENAME:
        data = rename(input);
        break;
      case FFMessageType.CREATE_DIR:
        data = createDir(input);
        break;
      case FFMessageType.LIST_DIR:
        data = listDir(input);
        break;
      case FFMessageType.DELETE_DIR:
        data = deleteDir(input);
        break;
      case FFMessageType.MOUNT:
        data = mount(input);
        break;
      case FFMessageType.UNMOUNT:
        data = unmount(input);
        break;
      default:
        throw ERROR_UNKNOWN_MESSAGE_TYPE;
    }
  } catch (error) {
    self.postMessage({ id, type: FFMessageType.ERROR, data: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (data instanceof Uint8Array) transfer.push(data.buffer);
  self.postMessage({ id, type, data }, transfer);
};
