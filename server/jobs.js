// Fila de geração. O LTX processa uma geração por vez, então a fila é serial.
//
// Continuidade de uma cena longa (cada bloco ≤ 20 s):
//  - "start"/"cut": o bloco é gerado do zero (texto ou imagem inicial da cena).
//  - "frame": o último quadro do bloco anterior vira a imagem inicial do bloco.
//  - "continue": os últimos segundos do bloco anterior são enviados ao /api/extend do LTX,
//    que gera a continuação com o movimento já em andamento. O trecho de contexto é
//    descartado e só a parte nova é salva como o próximo bloco.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { newId, findScene, selectedTake, slug } from "./store.js";
import { videoPrompt, previewPrompt, avatarPrompt, imageSize } from "./prompts.js";
import { renderDuration } from "./ltx.js";
import * as media from "./media.js";

const pad = (n) => String(n).padStart(2, "0");
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");

export function sceneFolder(project, scene) {
  const index = project.scenes.findIndex((s) => s.id === scene.id);
  return path.join(project.outputDir, `cena-${pad(index + 1)}-${slug(scene.title, "cena")}`);
}

export function startImage(project, scene) {
  const { kind, id } = scene.start || {};
  if (kind === "background") return project.backgrounds.find((b) => b.id === id)?.image ?? null;
  if (kind === "preview") return project.previews.find((p) => p.id === id)?.file ?? null;
  return null;
}

function requireOutput(project) {
  if (!project.outputDir) throw new Error("Escolha a pasta de saída do projeto antes de gerar.");
  fs.mkdirSync(project.outputDir, { recursive: true });
  fs.accessSync(project.outputDir, fs.constants.W_OK);
}

export class JobQueue {
  constructor({ store, ltx, onChange = () => {}, mediaLib = media }) {
    this.store = store;
    this.ltx = ltx;
    this.media = mediaLib;
    this.onChange = onChange;
    this.jobs = [];
    this.running = null;
  }

  list() {
    return this.jobs.map(({ abort, ...job }) => job);
  }

  changed() {
    this.onChange(this.list());
  }

  add(spec) {
    const job = {
      id: newId(),
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: 0,
      phase: "Na fila",
      error: null,
      steps: [],
      ...spec,
    };
    this.jobs.push(job);
    this.changed();
    setImmediate(() => this.pump());
    return job;
  }

  // Enfileira os blocos de uma cena. `from` (índice) gera dali em diante; `only` gera um bloco.
  addScene(projectId, sceneId, { from = 0, only = null, missing = false } = {}) {
    const project = this.store.get(projectId);
    const scene = findScene(project, sceneId);
    let blocks = scene.blocks.map((b, i) => ({ id: b.id, index: i }));
    if (only) blocks = blocks.filter((b) => b.id === only);
    else blocks = blocks.slice(from);
    if (missing) blocks = blocks.filter((b) => !selectedTake(scene.blocks[b.index]));
    if (!blocks.length) throw new Error("Nenhum bloco para gerar.");
    if (this.jobs.some((j) => ["queued", "running"].includes(j.status) && j.sceneId === sceneId && j.kind === "video"))
      throw new Error("Esta cena já está na fila.");
    return this.add({
      kind: "video",
      projectId,
      sceneId,
      blockIds: blocks.map((b) => b.id),
      title: `${scene.title} — ${blocks.length === 1 ? `bloco ${blocks[0].index + 1}` : `blocos ${blocks[0].index + 1}–${blocks.at(-1).index + 1}`}`,
    });
  }

  async cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error("Tarefa não encontrada.");
    if (job.status === "queued") {
      job.status = "cancelled";
      job.phase = "Cancelada";
    } else if (job.status === "running") {
      job.cancelRequested = true;
      job.phase = "Cancelando…";
      job.abort?.abort();
      if (job.ltxActive) await this.ltx.cancel().catch(() => {});
    }
    this.changed();
  }

  remove(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (job && ["queued", "running"].includes(job.status)) throw new Error("Cancele a tarefa antes de removê-la.");
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.changed();
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => ["queued", "running"].includes(j.status));
    this.changed();
  }

  async pump() {
    if (this.running) return;
    const job = this.jobs.find((j) => j.status === "queued");
    if (!job) return;
    this.running = job;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    job.abort = new AbortController();
    this.changed();
    try {
      await this.ltx.ensureLocal();
      await this.ltx.assertIdle();
      if (job.kind === "video") await this.runVideo(job);
      else if (job.kind === "preview") await this.runPreview(job);
      else if (job.kind === "avatar") await this.runAvatar(job);
      else throw new Error(`Tipo de tarefa desconhecido: ${job.kind}`);
      job.status = job.cancelRequested ? "cancelled" : "complete";
      job.phase = job.cancelRequested ? "Cancelada" : "Concluída";
      if (!job.cancelRequested) job.progress = 100;
    } catch (error) {
      if (job.cancelRequested || error.code === "ABORTED") {
        job.status = "cancelled";
        job.phase = "Cancelada";
      } else {
        job.status = "error";
        job.error = error.message;
        job.phase = "Erro";
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      job.abort = null;
      job.ltxActive = false;
      this.running = null;
      this.changed();
      setImmediate(() => this.pump());
    }
  }

  // Chama o LTX acompanhando o progresso global da geração.
  async withLtx(job, label, call) {
    job.phase = label;
    job.ltxActive = true;
    this.changed();
    const timer = setInterval(async () => {
      try {
        const p = await this.ltx.progress();
        if (p.status === "running" && job.status === "running" && !job.cancelRequested) {
          job.stepProgress = p.progress;
          job.remainingSeconds = p.remainingSeconds ?? null;
          job.ltxPhase = p.phase;
          this.changed();
        }
      } catch {
        /* a chamada principal reporta a falha */
      }
    }, 1500);
    try {
      const result = await call();
      if (result?.status === "cancelled") job.cancelRequested = true;
      return result;
    } finally {
      clearInterval(timer);
      job.ltxActive = false;
      job.stepProgress = null;
      job.remainingSeconds = null;
    }
  }

  async runVideo(job) {
    const total = job.blockIds.length;
    for (let n = 0; n < total; n++) {
      if (job.cancelRequested) return;
      const project = this.store.get(job.projectId);
      const scene = findScene(project, job.sceneId);
      const index = scene.blocks.findIndex((b) => b.id === job.blockIds[n]);
      if (index < 0) continue; // bloco removido enquanto estava na fila
      job.current = { index, n: n + 1, total };
      job.progress = Math.round((n / total) * 100);
      const take = await this.renderBlock(job, project, scene, index);
      if (!take) return;
      this.store.update(project.id, (p) => {
        const block = findScene(p, scene.id).blocks.find((b) => b.id === take.blockId);
        if (!block) return;
        delete take.blockId;
        block.takes.push(take);
        block.selectedTakeId = take.id;
      });
      job.steps.push({ blockIndex: index, file: take.file });
      this.changed();
    }
  }

  async renderBlock(job, project, scene, index) {
    requireOutput(project);
    const block = scene.blocks[index];
    const s = project.settings;
    const prev = index > 0 ? selectedTake(scene.blocks[index - 1]) : null;
    let mode = index === 0 ? "start" : block.continuity;
    if ((mode === "continue" || mode === "frame") && !prev)
      throw new Error(`O bloco ${index} ainda não foi gerado. Gere os blocos anteriores primeiro.`);
    if ((mode === "continue" || mode === "frame") && !fs.existsSync(prev.file))
      throw new Error(`O vídeo do bloco ${index} não está mais em ${prev.file}.`);

    const folder = sceneFolder(project, scene);
    const work = path.join(folder, ".trabalho");
    await fsp.mkdir(work, { recursive: true });
    const takeNo = block.takes.length + 1;
    const base = `bloco-${pad(index + 1)}${takeNo > 1 ? `_take-${takeNo}` : ""}`;
    const output = path.join(folder, `${base}.mp4`);
    const signal = job.abort.signal;
    const wantedFrames = Math.round(block.duration * s.fps);
    const label = `Bloco ${index + 1} de ${scene.blocks.length}`;
    let request;
    let usedImage = null;

    try {
      if (mode === "continue") {
        job.phase = `${label}: preparando a continuação`;
        this.changed();
        const info = await this.media.probe(prev.file);
        const contextFrames = this.media.latentFrames(Math.round(s.contextSeconds * info.fps), info.frames);
        const context = path.join(work, `${base}-contexto.mp4`);
        await this.media.cutFrames(prev.file, context, { startFrame: info.frames - contextFrames, count: contextFrames, fps: info.fps, signal });
        request = {
          video_path: context,
          duration: block.duration,
          prompt: videoPrompt(project, scene, block, { mode }),
          mode: "end",
        };
        const result = await this.withLtx(job, `${label}: gerando continuação no LTX`, () => this.ltx.extend(request, { signal }));
        if (job.cancelRequested || result?.status !== "complete") return null;
        if (!result.video_path) throw new Error("O LTX não devolveu o arquivo da continuação.");
        job.phase = `${label}: separando o trecho novo`;
        this.changed();
        const out = await this.media.probe(result.video_path);
        const count = Math.min(wantedFrames, out.frames - contextFrames);
        if (count < 1) throw new Error("A continuação gerada não tem quadros novos.");
        await this.media.cutFrames(result.video_path, output, { startFrame: contextFrames, count, fps: out.fps, audio: s.audio && out.hasAudio, signal });
        await fsp.rm(context, { force: true });
      } else {
        if (mode === "frame") {
          usedImage = path.join(work, `${base}-quadro-inicial.png`);
          await this.media.extractFrame(prev.file, usedImage, { which: "last", signal });
        } else {
          usedImage = startImage(project, scene);
          if (usedImage && !fs.existsSync(usedImage)) usedImage = null;
        }
        const allowed = await this.ltx.durations(s.resolution, s.fps);
        const duration = renderDuration(block.duration, allowed);
        request = {
          prompt: videoPrompt(project, scene, block, { mode, hasImage: Boolean(usedImage) }),
          promptProvenance: "enhanced", // envia o texto exatamente como escrito
          negativePrompt: project.negativePrompt || "",
          resolution: s.resolution,
          model: "fast",
          duration,
          fps: s.fps,
          audio: s.audio,
          aspectRatio: s.aspectRatio,
          ...(s.seed != null ? { seed: (s.seed + index) % 2147483647 } : {}),
          ...(usedImage ? { imagePath: usedImage } : {}),
        };
        const result = await this.withLtx(job, `${label}: gerando no LTX`, () => this.ltx.generateVideo(request, { signal }));
        if (job.cancelRequested || result?.status !== "complete") return null;
        if (!result.video_path) throw new Error("O LTX não devolveu um vídeo.");
        // Recorta sempre no quadro exato: o LTX devolve 8k+1 quadros e às vezes uma trilha de áudio vazia.
        const info = await this.media.probe(result.video_path);
        job.phase = `${label}: ajustando para ${block.duration}s`;
        this.changed();
        await this.media.cutFrames(result.video_path, output, { startFrame: 0, count: Math.min(wantedFrames, info.frames), fps: info.fps, audio: s.audio && info.hasAudio, signal });
      }
    } catch (error) {
      await fsp.rm(output, { force: true });
      throw error;
    }

    const take = {
      id: newId(),
      blockId: block.id,
      file: output,
      createdAt: new Date().toISOString(),
      mode,
      duration: block.duration,
      prompt: block.prompt,
      basedOn: mode === "continue" || mode === "frame" ? prev.id : null,
      startImage: usedImage,
    };
    await fsp.writeFile(
      path.join(folder, `${base}.json`),
      JSON.stringify({ project: project.name, scene: scene.title, block: index + 1, take: takeNo, mode, request, createdAt: take.createdAt }, null, 2),
    );
    return take;
  }

  async runPreview(job) {
    const project = this.store.get(job.projectId);
    requireOutput(project);
    const scene = job.sceneId ? findScene(project, job.sceneId) : null;
    const reference = job.backgroundId ? project.backgrounds.find((b) => b.id === job.backgroundId)?.image : null;
    const { width, height } = imageSize(project.settings.aspectRatio);
    const prompt = job.rawPrompt
      ? job.prompt
      : previewPrompt(project, scene, job.prompt, { withCharacters: job.withCharacters !== false });
    const request = {
      prompt,
      width,
      height,
      numImages: 1,
      ...(reference && fs.existsSync(reference) ? { imagePath: reference, strength: job.strength ?? 0.6 } : {}),
    };
    const result = await this.withLtx(job, "Gerando prévia no LTX", () => this.ltx.generateImage(request, { signal: job.abort.signal }));
    if (job.cancelRequested || result?.status !== "complete") return;
    const source = result.image_paths?.[0];
    if (!source) throw new Error("O LTX não devolveu a imagem.");
    const dir = path.join(project.outputDir, "previas");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${scene ? slug(scene.title, "cena") : "previa"}-${stamp()}${path.extname(source) || ".png"}`);
    await fsp.copyFile(source, file);
    const preview = { id: newId(), sceneId: scene?.id ?? null, backgroundId: job.backgroundId ?? null, prompt, file, createdAt: new Date().toISOString() };
    this.store.update(project.id, (p) => {
      p.previews.unshift(preview);
    });
    await fsp.writeFile(file.replace(/\.[^.]+$/, ".json"), JSON.stringify({ request, createdAt: preview.createdAt }, null, 2));
    job.result = { previewId: preview.id };
  }

  async runAvatar(job) {
    const project = this.store.get(job.projectId);
    const character = project.characters.find((c) => c.id === job.characterId);
    if (!character) throw new Error("Personagem não encontrado.");
    const reference = job.fromPhoto && character.photo && fs.existsSync(character.photo) ? character.photo : null;
    const request = {
      prompt: avatarPrompt(project, character, job.prompt),
      width: 768,
      height: 768,
      numImages: 1,
      ...(reference ? { imagePath: reference, strength: job.strength ?? 0.5 } : {}),
    };
    const result = await this.withLtx(job, "Gerando foto no LTX", () => this.ltx.generateImage(request, { signal: job.abort.signal }));
    if (job.cancelRequested || result?.status !== "complete") return;
    const source = result.image_paths?.[0];
    if (!source) throw new Error("O LTX não devolveu a imagem.");
    const file = path.join(this.store.assetsDir(project.id, "avatar-drafts"), `${character.id}-${stamp()}${path.extname(source) || ".png"}`);
    await fsp.copyFile(source, file);
    job.result = { draft: file, characterId: character.id };
  }
}
