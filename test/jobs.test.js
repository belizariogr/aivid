// Fila com um LTX simulado e FFmpeg real: confere a matemática de quadros da continuidade.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store, blockState, selectedTake } from "../server/store.js";
import { JobQueue } from "../server/jobs.js";
import * as media from "../server/media.js";

const ffmpeg = await media.findBinary("ffmpeg").catch(() => null);

function makeVideo(file, frames, fps, color) {
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x192:r=${fps}`, "-frames:v", String(frames), "-pix_fmt", "yuv420p", file]);
}

class FakeLtx {
  constructor(dir) {
    this.dir = dir;
    this.calls = [];
    this.n = 0;
    this.busy = 0;
  }
  async ensureLocal() {}
  async progress() {
    return this.busy-- > 0 ? { status: "running", progress: 30 } : { status: "idle" };
  }
  async cancel() {}
  async durations() {
    return [2, 3, 4, 5, 6, 8, 10, 20];
  }
  async generateVideo(req) {
    this.calls.push(["generate", req]);
    const out = path.join(this.dir, `gen-${++this.n}.mp4`);
    makeVideo(out, req.duration * req.fps + 1, req.fps, "blue");
    return { status: "complete", video_path: out };
  }
  async extend(req) {
    this.calls.push(["extend", req]);
    const info = await media.probe(req.video_path);
    const extra = Math.ceil((req.duration * info.fps) / 8) * 8;
    const tail = path.join(this.dir, `tail-${++this.n}.mp4`);
    makeVideo(tail, extra, info.fps, "red");
    const out = path.join(this.dir, `ext-${this.n}.mp4`);
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", req.video_path, "-i", tail, "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-pix_fmt", "yuv420p", out]);
    return { status: "complete", video_path: out };
  }
  async generateImage(req) {
    this.calls.push(["image", req]);
    const out = path.join(this.dir, `img-${++this.n}.png`);
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=green:s=64x64", "-frames:v", "1", out]);
    return { status: "complete", image_paths: [out] };
  }
}

const waitIdle = (q) =>
  new Promise((resolve) => {
    const check = () => (q.jobs.every((j) => !["queued", "running"].includes(j.status)) ? resolve() : setTimeout(check, 20));
    check();
  });

test("scene renders with extend, last-frame and cut continuity", { skip: !ffmpeg && "ffmpeg ausente", timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(fs.mkdtempSync(path.join(root, "ltx-")));
  const queue = new JobQueue({ store, ltx });
  const p = store.create("Filme");
  store.edit(p.id, {
    outputDir: path.join(root, "out"),
    prePrompt: "Film look",
    settings: { fps: 24, contextSeconds: 2 },
    scenes: [
      {
        id: "s1",
        title: "Abertura",
        blocks: [
          { id: "b1", prompt: "Opening", duration: 7 },
          { id: "b2", prompt: "Keeps walking", duration: 5, continuity: "continue" },
          { id: "b3", prompt: "Sits down", duration: 3, continuity: "frame" },
          { id: "b4", prompt: "New angle", duration: 4, continuity: "cut" },
        ],
      },
    ],
  });

  queue.addScene(p.id, "s1");
  await waitIdle(queue);
  const job = queue.jobs[0];
  assert.equal(job.status, "complete", job.error);

  const scene = store.get(p.id).scenes[0];
  const frames = await Promise.all(scene.blocks.map(async (b) => (await media.probe(selectedTake(b).file)).frames));
  assert.deepEqual(frames, [7 * 24, 5 * 24, 3 * 24, 4 * 24]);

  // Bloco 1: duração 7 não existe no LTX → gera 8 e recorta.
  assert.equal(ltx.calls[0][1].duration, 8);
  assert.match(ltx.calls[0][1].prompt, /^Film look/);
  // Bloco 2: extend recebe 49 quadros de contexto (2 s → 8k+1).
  const [kind, ext] = ltx.calls[1];
  assert.equal(kind, "extend");
  assert.equal(ext.mode, "end");
  assert.equal(ext.duration, 5);
  assert.equal((await media.probe(ext.video_path).catch(() => ({ frames: 0 }))).frames, 0, "contexto temporário removido");
  // O trecho salvo é só a parte nova (vermelha), sem o contexto (azul).
  const firstFrame = path.join(root, "f.png");
  await media.extractFrame(selectedTake(scene.blocks[1]).file, firstFrame, { which: "first" });
  const rgb = execFileSync(ffmpeg, ["-loglevel", "error", "-i", firstFrame, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  assert.ok(rgb[0] > 200 && rgb[2] < 60, `primeiro quadro deveria ser vermelho, veio ${[...rgb]}`);
  // Bloco 3 usa o último quadro do bloco 2 como imagem inicial.
  assert.equal(ltx.calls[2][0], "generate");
  assert.ok(ltx.calls[2][1].imagePath.endsWith(".png"));
  assert.match(ltx.calls[2][1].prompt, /last frame of the previous shot/);
  // Bloco 4 é corte: sem imagem.
  assert.equal(ltx.calls[3][1].imagePath, undefined);
  assert.deepEqual(scene.blocks.map((_, i) => blockState(scene, i)), ["ready", "ready", "ready", "ready"]);
  assert.ok(fs.existsSync(path.join(root, "out", "cena-01-abertura", "bloco-02.json")));

  // Gerar o bloco 1 de novo deixa a continuação desatualizada e cria um take novo.
  queue.addScene(p.id, "s1", { only: "b1" });
  await waitIdle(queue);
  const after = store.get(p.id).scenes[0];
  assert.equal(after.blocks[0].takes.length, 2);
  assert.ok(selectedTake(after.blocks[0]).file.endsWith("bloco-01_take-2.mp4"));
  assert.deepEqual(after.blocks.map((_, i) => blockState(after, i)), ["ready", "stale", "stale", "ready"]);

  // Exporta a cena unida.
  const files = after.blocks.map((b) => selectedTake(b).file);
  const joined = path.join(root, "out", "unida.mp4");
  await media.concat(files, joined);
  const total = (await media.probe(joined)).frames;
  assert.equal(total, (7 + 5 + 3 + 4) * 24);
});

test("continuation requires the previous block", { skip: !ffmpeg && "ffmpeg ausente" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const queue = new JobQueue({ store, ltx: new FakeLtx(root) });
  const p = store.create("X");
  store.edit(p.id, { outputDir: path.join(root, "out"), scenes: [{ id: "s", blocks: [{ id: "a", prompt: "a" }, { id: "b", prompt: "b" }] }] });
  queue.addScene(p.id, "s", { only: "b" });
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "error");
  assert.match(queue.jobs[0].error, /bloco 1 ainda não foi gerado/);
});

test("preview images are saved in the output folder", { skip: !ffmpeg && "ffmpeg ausente" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(root);
  const queue = new JobQueue({ store, ltx });
  const p = store.create("X");
  store.edit(p.id, { outputDir: path.join(root, "out"), prePrompt: "Noir", settings: { aspectRatio: "9:16" } });
  queue.add({ kind: "preview", projectId: p.id, prompt: "dark alley", withCharacters: false });
  await waitIdle(queue);
  const saved = store.get(p.id).previews[0];
  assert.ok(saved.file.startsWith(path.join(root, "out", "previas")));
  assert.ok(fs.existsSync(saved.file));
  const req = ltx.calls[0][1];
  assert.equal(req.width < req.height, true);
  assert.match(req.prompt, /Noir[\s\S]*no people[\s\S]*dark alley/);
});

test("waits while the LTX is busy with another generation", { skip: !ffmpeg && "ffmpeg ausente" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(root);
  ltx.busy = 2;
  const phases = [];
  const queue = new JobQueue({ store, ltx, onChange: (jobs) => phases.push(jobs[0]?.phase) });
  queue.idlePoll = 10;
  const p = store.create("X");
  store.edit(p.id, { outputDir: path.join(root, "out"), scenes: [{ id: "s", blocks: [{ id: "a", prompt: "a", duration: 2 }] }] });
  queue.addScene(p.id, "s");
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "complete", queue.jobs[0].error);
  assert.ok(phases.some((x) => /Aguardando o LTX/.test(x || "")));
});
