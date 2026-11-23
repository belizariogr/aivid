// Operações de vídeo com FFmpeg/FFprobe: medir, recortar por quadro, extrair quadros e unir blocos.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const binCache = new Map();

export async function findBinary(name) {
  if (binCache.has(name)) return binCache.get(name);
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, ...(process.env.PATH || "").split(":").map((d) => path.join(d, name))];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error(`${name} não encontrado. Instale com: brew install ffmpeg`);
  binCache.set(name, found);
  return found;
}

function exec(binary, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { maxBuffer: 64 << 20, signal }, (error, stdout, stderr) => {
      if (error) {
        if (error.name === "AbortError") return reject(Object.assign(new Error("Operação cancelada."), { code: "ABORTED" }));
        const tail = String(stderr || error.message).trim().split("\n").slice(-3).join(" ");
        return reject(new Error(`${path.basename(binary)} falhou: ${tail}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseRate(rate) {
  const [n, d] = String(rate || "0/1").split("/").map(Number);
  return d ? n / d : n;
}

export async function probe(file) {
  const ffprobe = await findBinary("ffprobe");
  const { stdout } = await exec(ffprobe, [
    "-v", "error",
    "-count_frames",
    "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_read_frames,duration:format=duration",
    "-of", "json",
    file,
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`Sem trilha de vídeo: ${file}`);
  const fps = parseRate(video.r_frame_rate);
  const frames = Number(video.nb_read_frames) || Math.round(Number(video.duration || data.format?.duration || 0) * fps);
  return {
    width: video.width,
    height: video.height,
    fps,
    frames,
    duration: frames / fps,
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

const ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];

// Recorta [startFrame, startFrame+count) mantendo o áudio alinhado quando pedido.
export async function cutFrames(input, output, { startFrame = 0, count, fps, audio = false, signal }) {
  const ffmpeg = await findBinary("ffmpeg");
  const end = count == null ? "" : `:end_frame=${startFrame + count}`;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", `trim=start_frame=${startFrame}${end},setpts=PTS-STARTPTS`];
  if (audio) {
    const start = (startFrame / fps).toFixed(6);
    const dur = count == null ? "" : `:duration=${(count / fps).toFixed(6)}`;
    args.push("-af", `atrim=start=${start}${dur},asetpts=PTS-STARTPTS`, "-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push(...ENCODE, output);
  await exec(ffmpeg, args, { signal });
  return output;
}

// Último (ou primeiro) quadro do clipe como PNG.
export async function extractFrame(input, output, { which = "last", signal } = {}) {
  const ffmpeg = await findBinary("ffmpeg");
  const args =
    which === "last"
      ? ["-hide_banner", "-loglevel", "error", "-y", "-sseof", "-1", "-i", input, "-update", "1", output]
      : ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-frames:v", "1", output];
  await exec(ffmpeg, args, { signal });
  return output;
}

// Junta blocos em um único arquivo (só para conferência; os blocos continuam separados).
export async function concat(files, output, { audio = false, signal } = {}) {
  const ffmpeg = await findBinary("ffmpeg");
  const list = output + ".txt";
  await fs.writeFile(list, files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join("\n"));
  try {
    await exec(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, ...(audio ? ["-c:a", "aac"] : ["-an"]), ...ENCODE, output],
      { signal },
    );
  } finally {
    await fs.rm(list, { force: true });
  }
  return output;
}

// Quantidade de quadros válida para o LTX (8k+1) mais próxima do pedido, sem passar do limite.
export function latentFrames(frames, max = Infinity) {
  const nearest = Math.round((frames - 1) / 8) * 8 + 1;
  const limit = Math.floor((max - 1) / 8) * 8 + 1;
  return Math.max(9, Math.min(nearest, limit));
}
