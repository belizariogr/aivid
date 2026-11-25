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

test("a cut can open from the last frame of an earlier block and goes stale with it", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(fs.mkdtempSync(path.join(root, "ltx-")));
  const queue = new JobQueue({ store, ltx });
  const p = store.create("Portão");
  store.edit(p.id, {
    outputDir: path.join(root, "out"),
    scenes: [
      {
        id: "s",
        title: "Portão",
        blocks: [
          { id: "b1", prompt: "Wide shot, she opens the gate", duration: 2 },
          { id: "b2", prompt: "Close-up of her face", duration: 2, continuity: "cut", start: { kind: "none" } },
          { id: "b3", prompt: "Back to the wide shot, the gate stands open", duration: 2, continuity: "cut", start: { kind: "block", id: "b1" } },
          { id: "b4", prompt: "Opens from a later block", duration: 2, continuity: "cut", start: { kind: "block", id: "b4" } },
        ],
      },
    ],
  });
  queue.addScene(p.id, "s");
  await waitIdle(queue);
  const job = queue.jobs[0];
  assert.equal(job.status, "error");
  assert.match(job.error, /bloco 4 começa do último quadro do bloco 4/);
  assert.equal(ltx.calls.length, 3, "o erro do bloco 4 não é repetido");
  assert.equal(ltx.calls[1][1].imagePath, undefined, "corte só com o texto");
  assert.match(ltx.calls[2][1].imagePath, /bloco-03-quadro-inicial\.png$/);
  assert.match(ltx.calls[2][1].prompt, /opening frame/);

  let scene = store.get(p.id).scenes[0];
  const take3 = selectedTake(scene.blocks[2]);
  assert.equal(take3.basedOnBlock, "b1");
  assert.equal(take3.basedOn, selectedTake(scene.blocks[0]).id);
  assert.deepEqual([0, 1, 2].map((i) => blockState(scene, i)), ["ready", "ready", "ready"]);

  // Refazer o bloco 1 deixa desatualizado o corte que saiu do fim dele, mas não o corte só com texto.
  queue.addScene(p.id, "s", { only: "b1" });
  await waitIdle(queue);
  scene = store.get(p.id).scenes[0];
  assert.deepEqual([0, 1, 2].map((i) => blockState(scene, i)), ["ready", "ready", "stale"]);
});

test("the continuity review can change a block before it renders, and a failed review keeps the plan", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(fs.mkdtempSync(path.join(root, "ltx-")));
  const seen = [];
  const reviewer = {
    async review({ scene, index, startImage }) {
      seen.push({ index, startImage, rendered: scene.blocks.map((b) => Boolean(selectedTake(b))) });
      if (index === 2) throw new Error("sem rede");
      return { changed: true, block: { continuity: "cut", start: { kind: "block", id: "b1" }, prompt: "Wide again, the gate stands open", note: "Voltou ao plano aberto." }, reason: "O bloco 2 terminou em close.", model: "Fake" };
    },
  };
  const queue = new JobQueue({ store, ltx, reviewer });
  const p = store.create("Revisão");
  store.edit(p.id, {
    outputDir: path.join(root, "out"),
    settings: { review: true },
    scenes: [{ id: "s", title: "Portão", blocks: [{ id: "b1", prompt: "Opens the gate", duration: 2 }, { id: "b2", prompt: "Close-up", duration: 2, continuity: "frame" }, { id: "b3", prompt: "Waits", duration: 2, continuity: "continue" }] }],
  });
  queue.addScene(p.id, "s");
  await waitIdle(queue);
  const job = queue.jobs[0];
  assert.equal(job.status, "complete", job.error);
  assert.deepEqual(seen.map((x) => x.index), [1, 2], "o 1º bloco não tem quadro anterior para revisar");
  assert.deepEqual(seen[0].rendered, [true, false, false]);

  const scene = store.get(p.id).scenes[0];
  const b2 = scene.blocks[1];
  assert.equal(b2.continuity, "cut");
  assert.deepEqual(b2.start, { kind: "block", id: "b1" });
  assert.equal(b2.review.changed, true);
  assert.equal(b2.review.before.continuity, "frame");
  assert.equal(ltx.calls[1][1].prompt.includes("Wide again, the gate stands open"), true);
  assert.match(ltx.calls[1][1].imagePath, /bloco-02-quadro-inicial\.png$/);
  assert.equal(selectedTake(b2).basedOnBlock, "b1");
  assert.equal(scene.blocks[2].review, null);
  assert.match(job.warnings[0], /Bloco 3: a revisão de continuidade falhou \(sem rede\)/);
  assert.equal(ltx.calls[2][0], "extend", "o bloco 3 seguiu o plano");

  // Uma edição antiga da interface (sem ter visto a revisão) não desfaz o ajuste.
  store.edit(p.id, { scenes: [{ ...scene, blocks: scene.blocks.map((b) => ({ ...b, review: null, prompt: b.id === "b2" ? "stale edit" : b.prompt })) }] });
  assert.equal(store.get(p.id).scenes[0].blocks[1].prompt, "Wide again, the gate stands open");
});

test("a cut can open from an image generated for it, reused by later renders", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(fs.mkdtempSync(path.join(root, "ltx-")));
  const queue = new JobQueue({ store, ltx });
  const p = store.create("Abertura");
  store.edit(p.id, {
    outputDir: path.join(root, "out"),
    scenes: [
      {
        id: "s",
        title: "Portão",
        blocks: [
          { id: "b1", prompt: "Wide, she opens the gate", duration: 2 },
          { id: "b2", prompt: "Reverse angle", duration: 2, continuity: "cut", currentState: "The gate stands wide open.", opening: "Low angle from inside the square, the open gate behind her.", start: { kind: "keyframe", ref: { kind: "block", id: "b1" } } },
        ],
      },
    ],
  });
  queue.addScene(p.id, "s");
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "complete", queue.jobs[0].error);
  assert.deepEqual(ltx.calls.map((c) => c[0]), ["generate", "image", "generate"]);
  const image = ltx.calls[1][1];
  assert.match(image.prompt, /Low angle from inside the square/);
  assert.match(image.prompt, /Current state: The gate stands wide open\./);
  assert.match(image.imagePath, /referencia/, "parte do último quadro do bloco 1");
  let project = store.get(p.id);
  const b2 = project.scenes[0].blocks[1];
  const preview = project.previews.find((x) => x.id === b2.start.id);
  assert.equal(preview.kind, "keyframe");
  assert.ok(preview.file.includes(path.join("out", "previas")));
  assert.equal(ltx.calls[2][1].imagePath, preview.file);
  assert.match(ltx.calls[2][1].prompt, /Current state: The gate stands wide open\./);

  // Gerar o bloco de novo reaproveita a imagem; uma edição da interface não a descarta.
  store.edit(p.id, { scenes: [{ ...project.scenes[0], blocks: project.scenes[0].blocks.map((b) => ({ ...b, start: b.start.kind === "keyframe" ? { ...b.start, id: null } : b.start })) }] });
  queue.addScene(p.id, "s", { only: "b2" });
  await waitIdle(queue);
  assert.deepEqual(ltx.calls.map((c) => c[0]), ["generate", "image", "generate", "generate"]);
  assert.equal(ltx.calls[3][1].imagePath, preview.file);

  // Sem o Z-Image, usa a referência e avisa.
  ltx.generateImage = async () => {
    const { LtxError } = await import("../server/ltx.js");
    throw new LtxError("sem z-image", { code: "NO_IMAGE_MODEL" });
  };
  project = store.get(p.id);
  store.update(p.id, (x) => void (x.scenes[0].blocks[1].start.id = null));
  queue.addScene(p.id, "s", { only: "b2" });
  await waitIdle(queue);
  const job = queue.jobs.at(-1);
  assert.equal(job.status, "complete", job.error);
  assert.match(job.warnings[0], /sem o Z-Image/);
  assert.match(ltx.calls.at(-1)[1].imagePath, /referencia/);
});

test("the judge asks for retakes and keeps the best take when none passes", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(fs.mkdtempSync(path.join(root, "ltx-")));
  const scores = { b1: [9], b2: [3, 6, 4] };
  const reviewer = {
    async judge({ scene, index }) {
      const id = scene.blocks[index].id;
      const score = scores[id].shift();
      return { pass: score >= 7, score, problems: score >= 7 ? [] : ["A ação não aconteceu."], reason: `nota ${score}`, model: "Fake" };
    },
  };
  const queue = new JobQueue({ store, ltx, reviewer });
  const p = store.create("Juiz");
  store.edit(p.id, {
    outputDir: path.join(root, "out"),
    settings: { judge: true, retakes: 2, seed: 10 },
    scenes: [{ id: "s", title: "Cena", blocks: [{ id: "b1", prompt: "a", duration: 2 }, { id: "b2", prompt: "b", duration: 2, continuity: "cut", start: { kind: "none" } }] }],
  });
  queue.addScene(p.id, "s");
  await waitIdle(queue);
  const job = queue.jobs[0];
  assert.equal(job.status, "complete", job.error);
  const scene = store.get(p.id).scenes[0];
  assert.equal(scene.blocks[0].takes.length, 1);
  assert.equal(scene.blocks[1].takes.length, 3, "1 take + 2 retakes");
  assert.deepEqual(ltx.calls.slice(1).map((c) => c[1].seed), [11, 11 + 7919, 11 + 2 * 7919], "cada retake muda a seed");
  const best = selectedTake(scene.blocks[1]);
  assert.equal(best.judge.score, 6);
  assert.equal(best.retake, 1);
  assert.match(job.warnings[0], /Bloco 2: nenhum take passou no juiz depois de 3 tentativa\(s\); ficou o de nota 6/);
  const { attention } = await import("../server/jobs.js");
  const items = attention(store.get(p.id));
  assert.deepEqual(items.map((i) => [i.block, i.kind]), [[2, "judge"]]);
});

test("a scene can open from the last frame of the previous scene, and the film is joined with a report", { skip: !ffmpeg && "ffmpeg ausente", timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(fs.mkdtempSync(path.join(root, "ltx-")));
  const queue = new JobQueue({ store, ltx });
  const p = store.create("Meu Filme");
  store.edit(p.id, {
    outputDir: path.join(root, "out"),
    scenes: [
      { id: "s1", title: "Um", blocks: [{ id: "a1", prompt: "a", duration: 2 }, { id: "a2", prompt: "b", duration: 2, continuity: "continue" }] },
      { id: "s2", title: "Dois", start: { kind: "previous" }, blocks: [{ id: "c1", prompt: "c", duration: 3 }] },
      { id: "s3", title: "Três", blocks: [{ id: "d1", prompt: "", duration: 2 }] },
    ],
  });
  const r = queue.addFilm(p.id);
  assert.equal(r.added.length, 3);
  await waitIdle(queue);
  const film = queue.jobs.find((j) => j.kind === "film");
  assert.equal(film.status, "complete", film.error);
  const project = store.get(p.id);
  const c1 = selectedTake(project.scenes[1].blocks[0]);
  assert.equal(c1.basedOnScene, "s1");
  assert.equal(c1.basedOnBlock, "a2");
  assert.match(ltx.calls[2][1].imagePath, /quadro-inicial\.png$/);
  assert.equal(blockState(project.scenes[1], 0, project), "ready");
  assert.equal((await media.probe(film.result.file)).frames, (2 + 2 + 3 + 2) * 24);
  assert.match(fs.readFileSync(film.result.report, "utf8"), /# Meu Filme/);
  assert.ok(film.result.file.endsWith("meu-filme-filme.mp4"));

  // Refazer o último bloco da cena 1 deixa a abertura da cena 2 desatualizada.
  queue.addScene(p.id, "s1", { only: "a2" });
  await waitIdle(queue);
  const after = store.get(p.id);
  assert.equal(blockState(after.scenes[1], 0, after), "stale");
});

test("character reference sheets are generated from the photo", { skip: !ffmpeg && "ffmpeg ausente" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-jobs-"));
  const store = new Store(path.join(root, "lib"));
  const ltx = new FakeLtx(fs.mkdtempSync(path.join(root, "ltx-")));
  const queue = new JobQueue({ store, ltx });
  const p = store.create("Fichas");
  store.edit(p.id, { characters: [{ id: "ana", name: "Ana", appearance: "short black hair" }] });
  const photo = path.join(root, "ana.png");
  fs.writeFileSync(photo, "x");
  store.update(p.id, (x) => void (x.characters[0].photo = photo));
  queue.addCharsheet(p.id, "ana");
  await waitIdle(queue);
  assert.equal(queue.jobs[0].status, "complete", queue.jobs[0].error);
  const refs = store.get(p.id).characters[0].refs;
  assert.deepEqual(refs.map((r) => r.view), ["front", "profile", "body"]);
  assert.ok(refs.every((r) => fs.existsSync(r.file)));
  assert.equal(ltx.calls[2][1].height, 1152);
  assert.equal(ltx.calls[0][1].imagePath, photo);
  assert.match(ltx.calls[1][1].prompt, /Side profile/);
});
