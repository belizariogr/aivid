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

test("a recreated scene does not overwrite videos already in its folder", { skip: !ffmpeg && "ffmpeg ausente" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const queue = new JobQueue({ store, ltx: new FakeLtx(root) });
  const p = store.create("X");
  const scene = (id) => [{ id, title: "Abertura", blocks: [{ id: `${id}-b`, prompt: "a", duration: 2, continuity: "cut" }] }];
  store.edit(p.id, { outputDir: path.join(root, "out"), scenes: scene("s1") });
  queue.addScene(p.id, "s1");
  await waitIdle(queue);
  store.edit(p.id, { scenes: scene("s2") });
  queue.addScene(p.id, "s2");
  await waitIdle(queue);
  const folder = path.join(root, "out", "cena-01-abertura");
  assert.ok(fs.existsSync(path.join(folder, "bloco-01.mp4")));
  assert.ok(selectedTake(store.get(p.id).scenes[0].blocks[0]).file.endsWith("bloco-01_take-2.mp4"));
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

// LTX que falha nas primeiras `failures` gerações e depois funciona.
class FlakyLtx extends FakeLtx {
  constructor(dir, failures) {
    super(dir);
    this.failures = failures;
  }
  async generateVideo(req) {
    if (this.failures-- > 0) {
      this.calls.push(["fail", req]);
      throw new Error("CUDA out of memory");
    }
    return super.generateVideo(req);
  }
}

function flakyScene(failures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-retry-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FlakyLtx(fs.mkdtempSync(path.join(root, "ltx-")), failures);
  const queue = new JobQueue({ store, ltx });
  queue.retryDelays = [0, 0];
  const p = store.create("X");
  store.edit(p.id, { outputDir: path.join(root, "out"), settings: { fps: 24 }, scenes: [{ id: "s", blocks: [{ id: "a", prompt: "a", duration: 2 }, { id: "b", prompt: "b", duration: 2, continuity: "cut" }] }] });
  return { store, ltx, queue, projectId: p.id };
}

test("a failed block is generated again up to two more times", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const { store, ltx, queue, projectId } = flakyScene(2);
  const phases = [];
  queue.onChange = (jobs) => phases.push(jobs[0]?.phase);
  queue.addScene(projectId, "s");
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "complete", queue.jobs[0].error);
  assert.deepEqual(ltx.calls.map((c) => c[0]), ["fail", "fail", "generate", "generate"]);
  assert.ok(phases.some((x) => /Bloco 1 falhou \(CUDA out of memory\)\. Tentando de novo/.test(x || "")));
  assert.ok(phases.some((x) => /tentativa 3 de 3/.test(x || "")));
  const scene = store.get(projectId).scenes[0];
  assert.deepEqual(scene.blocks.map((_, i) => blockState(scene, i)), ["ready", "ready"]);
  assert.equal(scene.blocks[0].takes.length, 1);
});

test("a block that keeps failing stops the scene after three attempts", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const { ltx, queue, projectId } = flakyScene(3);
  queue.addScene(projectId, "s");
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "error");
  assert.match(queue.jobs[0].error, /Bloco 1 falhou 3 vezes\. Último erro: CUDA out of memory/);
  assert.deepEqual(ltx.calls.map((c) => c[0]), ["fail", "fail", "fail"]);
});

test("errors only the user can fix are not retried", { skip: !ffmpeg && "ffmpeg ausente" }, async () => {
  const { ltx, queue, projectId, store } = flakyScene(0);
  store.edit(projectId, { outputDir: "" });
  queue.addScene(projectId, "s");
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "error");
  assert.match(queue.jobs[0].error, /^Escolha a pasta de saída/);
  assert.equal(ltx.calls.length, 0);
});

test("cancelling during the pause before a retry stops the job", { skip: !ffmpeg && "ffmpeg ausente", timeout: 30_000 }, async () => {
  const { ltx, queue, projectId } = flakyScene(1);
  queue.retryDelays = [10_000, 10_000];
  const job = queue.addScene(projectId, "s");
  while (!/Tentando de novo/.test(job.phase)) await new Promise((r) => setTimeout(r, 10));
  await queue.cancel(job.id);
  await waitIdle(queue);
  assert.equal(job.status, "cancelled");
  assert.deepEqual(ltx.calls.map((c) => c[0]), ["fail"]);
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

// LTX cujo estado de progresso é compartilhado entre "aberturas" do Takes.
class ControlledLtx extends FakeLtx {
  constructor(dir, state) {
    super(dir);
    this.state = state;
  }
  async progress() {
    return { ...this.state };
  }
  async generateVideo(req) {
    if (!this.state.hang) return super.generateVideo(req);
    this.calls.push(["generate", req]);
    Object.assign(this.state, { id: "g1", status: "running", progress: 40, result: null });
    return new Promise((_, reject) => (this.state.abandon = reject));
  }
}

async function closeMidGeneration(root) {
  const store = new Store(path.join(root, "lib"));
  const state = { id: "old", status: "complete", result: "/tmp/antigo.mp4", hang: true };
  const ltx = new ControlledLtx(fs.mkdtempSync(path.join(root, "ltx-")), state);
  const file = path.join(root, "lib", "jobs.json");
  const queue = new JobQueue({ store, ltx, file });
  queue.pollMs = 10;
  const p = store.create("Rec");
  store.edit(p.id, {
    outputDir: path.join(root, "out"),
    settings: { fps: 24 },
    scenes: [{ id: "s", title: "Cena", blocks: [{ id: "a", prompt: "a", duration: 3 }, { id: "b", prompt: "b", duration: 2, continuity: "continue" }] }],
  });
  queue.addScene(p.id, "s");
  while (!queue.jobs[0]?.ltxGenerationId) await new Promise((r) => setTimeout(r, 10));
  await queue.stop({ cancel: false }); // o Takes fecha; o LTX continua gerando
  state.abandon(new Error("conexão encerrada"));
  delete state.hang;
  return { store: new Store(path.join(root, "lib")), state, file, ltxDir: ltx.dir, projectId: p.id };
}

test("reopening recovers a generation the LTX kept running and finishes the queue", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-rec-"));
  const { store, state, file, ltxDir, projectId } = await closeMidGeneration(root);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved[0].status, "running");
  assert.equal(saved[0].inflight.blockId, "a");

  const phases = [];
  const ltx = new ControlledLtx(ltxDir, state);
  const queue = new JobQueue({ store, ltx, file, onChange: (jobs) => phases.push(jobs[0].phase) });
  queue.pollMs = 10;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(queue.jobs[0].status, "running");
  assert.match(phases.at(-1), /recuperado/);
  // O LTX termina a geração enquanto o Takes reaberto acompanha.
  const video = path.join(ltxDir, "terminado.mp4");
  makeVideo(video, 73, 24, "blue");
  Object.assign(state, { status: "complete", progress: 100, result: video });
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "complete", queue.jobs[0].error);
  const scene = store.get(projectId).scenes[0];
  assert.deepEqual(scene.blocks.map((_, i) => blockState(scene, i)), ["ready", "ready"]);
  assert.equal((await media.probe(selectedTake(scene.blocks[0]).file)).frames, 72);
  assert.equal(ltx.calls.filter(([k]) => k === "generate").length, 0, "não gera o bloco 1 de novo");
  assert.equal(ltx.calls.filter(([k]) => k === "extend").length, 1);
});

test("a generation lost while closed becomes interrupted and can be resumed", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-rec-"));
  const { store, state, file, ltxDir, projectId } = await closeMidGeneration(root);
  Object.assign(state, { id: "outra", status: "complete", result: "/tmp/outra.mp4" }); // o LTX fez outra coisa
  const ltx = new ControlledLtx(ltxDir, state);
  const queue = new JobQueue({ store, ltx, file });
  queue.pollMs = 10;
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "interrupted");
  assert.match(queue.jobs[0].error, /Retomar/);
  queue.resume(queue.jobs[0].id);
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "complete", queue.jobs[0].error);
  const scene = store.get(projectId).scenes[0];
  assert.deepEqual(scene.blocks.map((_, i) => blockState(scene, i)), ["ready", "ready"]);
});
