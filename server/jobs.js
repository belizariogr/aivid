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

// Erro que não se resolve gerando de novo (falta algo que só o usuário pode corrigir).
const fatal = (message) => Object.assign(new Error(message), { retry: false });

function requireOutput(project) {
  if (!project.outputDir) throw fatal("Escolha a pasta de saída do projeto antes de gerar.");
  try {
    fs.mkdirSync(project.outputDir, { recursive: true });
    fs.accessSync(project.outputDir, fs.constants.W_OK);
  } catch (error) {
    throw Object.assign(error, { retry: false });
  }
}

const ACTIVE = ["queued", "running"];
const RESUMABLE = ["interrupted", "error", "cancelled"];

export class JobQueue {
  // `file` guarda a fila em disco: se o Takes fechar no meio de uma geração, ao abrir de novo
  // ele reconhece a geração que o LTX continuou fazendo, mostra o progresso e salva o resultado.
  constructor({ store, ltx, onChange = () => {}, mediaLib = media, file = null }) {
    this.store = store;
    this.ltx = ltx;
    this.media = mediaLib;
    this.onChange = onChange;
    this.file = file;
    this.jobs = [];
    this.running = null;
    this.pollMs = 1500;
    this.idlePoll = 3000;
    // Pausa antes de cada nova tentativa de um bloco que falhou; o tamanho da lista é o número de novas tentativas.
    this.retryDelays = [5000, 15000];
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      this.jobs = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.jobs = [];
    }
    for (const job of this.jobs) {
      job.ltxActive = false;
      if (job.status === "running") {
        job.recovering = true;
        job.phase = "Retomando depois que o Takes foi fechado…";
      }
    }
    if (this.jobs.some((j) => ACTIVE.includes(j.status))) setImmediate(() => this.pump());
  }

  list() {
    return this.jobs.map(({ abort, ...job }) => job);
  }

  persist() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.list()));
    fs.renameSync(tmp, this.file);
  }

  changed() {
    try {
      this.persist();
    } catch {
      /* falha ao gravar a fila não interrompe a geração */
    }
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
      done: [],
      inflight: null,
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
    if (this.jobs.some((j) => ACTIVE.includes(j.status) && j.sceneId === sceneId && j.kind === "video"))
      throw new Error("Esta cena já está na fila.");
    return this.add({
      kind: "video",
      projectId,
      sceneId,
      blockIds: blocks.map((b) => b.id),
      title: `${scene.title} — ${blocks.length === 1 ? `bloco ${blocks[0].index + 1}` : `blocos ${blocks[0].index + 1}–${blocks.at(-1).index + 1}`}`,
    });
  }

  // Põe na fila todas as cenas do projeto, em ordem. Pula as que já estão na fila ou não têm o que gerar.
  addAllScenes(projectId, { missing = false } = {}) {
    const project = this.store.get(projectId);
    const added = [];
    const skipped = [];
    for (const scene of project.scenes) {
      try {
        added.push(this.addScene(projectId, scene.id, { missing }));
      } catch (error) {
        skipped.push({ sceneId: scene.id, title: scene.title, reason: error.message });
      }
    }
    if (!added.length) throw Object.assign(new Error(missing ? "Nenhuma cena tem blocos pendentes." : "Nenhuma cena para gerar."), { status: 409, details: skipped.map((x) => `${x.title}: ${x.reason}`) });
    return { added, skipped };
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

  // Recoloca na fila o que faltou de uma tarefa interrompida, cancelada ou com erro.
  resume(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new Error("Tarefa não encontrada.");
    if (!RESUMABLE.includes(job.status)) throw new Error("Esta tarefa não pode ser retomada.");
    if (job.kind === "video" && this.jobs.some((j) => j !== job && ACTIVE.includes(j.status) && j.sceneId === job.sceneId && j.kind === "video"))
      throw new Error("Esta cena já está na fila.");
    Object.assign(job, { status: "queued", phase: "Na fila", error: null, cancelRequested: false, inflight: null, ltxGenerationId: null, finishedAt: null });
    this.changed();
    setImmediate(() => this.pump());
    return job;
  }

  remove(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (job && ACTIVE.includes(job.status)) throw new Error("Cancele a tarefa antes de removê-la.");
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.changed();
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => ACTIVE.includes(j.status));
    this.changed();
  }

  async pump() {
    if (this.running || this.stopped) return;
    const job = this.jobs.find((j) => j.status === "running" && j.recovering) ?? this.jobs.find((j) => j.status === "queued");
    if (!job) return;
    this.running = job;
    job.status = "running";
    job.startedAt ??= new Date().toISOString();
    job.abort = new AbortController();
    this.changed();
    try {
      if (job.recovering) {
        job.recovering = false;
        if (job.inflight) await this.recoverInflight(job);
      }
      if (!job.cancelRequested) {
        if (job.kind === "video") await this.runVideo(job);
        else if (job.result) {
          /* recuperada: já terminou */
        } else if (job.kind === "preview") await this.runPreview(job);
        else if (job.kind === "avatar") await this.runAvatar(job);
        else throw new Error(`Tipo de tarefa desconhecido: ${job.kind}`);
      }
      job.status = job.cancelRequested ? "cancelled" : "complete";
      job.phase = job.cancelRequested ? "Cancelada" : "Concluída";
      if (!job.cancelRequested) job.progress = 100;
    } catch (error) {
      if (this.stopped) return; // o servidor está saindo; a tarefa continua "running" no disco
      if (job.cancelRequested || error.code === "ABORTED") {
        job.status = "cancelled";
        job.phase = "Cancelada";
      } else if (error.code === "INTERRUPTED") {
        job.status = "interrupted";
        job.error = error.message;
        job.phase = "Interrompida";
      } else {
        job.status = "error";
        job.error = error.message;
        job.phase = "Erro";
      }
    } finally {
      if (!this.stopped) {
        job.finishedAt = new Date().toISOString();
        job.abort = null;
        job.ltxActive = false;
        job.inflight = null;
        this.running = null;
        this.changed();
        setImmediate(() => this.pump());
      }
    }
  }

  // Encerramento do servidor. Sem `cancel`, o LTX termina a geração atual e ela é recuperada
  // na próxima abertura; com `cancel`, tudo o que está na fila ou gerando é cancelado.
  async stop({ cancel = false } = {}) {
    if (cancel) {
      const active = this.jobs.filter((j) => ACTIVE.includes(j.status));
      await Promise.race([Promise.all(active.map((j) => this.cancel(j.id).catch(() => {}))), new Promise((r) => setTimeout(r, 4000))]);
    }
    this.stopped = true;
    this.persist();
  }

  // O LTX gera uma coisa por vez: se estiver ocupado (pelo próprio LTX ou por outro app), espera.
  async waitForLtx(job) {
    for (;;) {
      if (job.cancelRequested) throw Object.assign(new Error("Operação cancelada."), { code: "ABORTED" });
      const p = await this.ltx.progress();
      if (p.status !== "running") return;
      const phase = `Aguardando o LTX terminar outra geração${p.progress ? ` (${p.progress}%)` : ""}`;
      if (job.phase !== phase) {
        job.phase = phase;
        this.changed();
      }
      await new Promise((r) => setTimeout(r, this.idlePoll));
    }
  }

  // Chama o LTX acompanhando o progresso. `inflight` descreve como salvar o resultado e fica
  // gravado até o resultado ser salvo, para a geração sobreviver a um fechamento do Takes.
  async withLtx(job, label, inflight, call) {
    await this.ltx.ensureLocal();
    await this.waitForLtx(job);
    job.phase = label;
    job.ltxBefore = (await this.ltx.progress().catch(() => ({}))).id ?? null;
    job.ltxGenerationId = null;
    job.inflight = { label, ...inflight };
    job.ltxActive = true;
    this.changed();
    const timer = setInterval(async () => {
      try {
        const p = await this.ltx.progress();
        if (p.status === "running" && job.status === "running" && !job.cancelRequested) {
          if (p.id && p.id !== job.ltxBefore) job.ltxGenerationId = p.id;
          job.stepProgress = p.progress;
          job.remainingSeconds = p.remainingSeconds ?? null;
          this.changed();
        }
      } catch {
        /* a chamada principal reporta a falha */
      }
    }, this.pollMs);
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

  // Depois de reabrir: acompanha a geração que o LTX continuou fazendo e salva o resultado.
  async recoverInflight(job) {
    const inf = job.inflight;
    const lost = () =>
      Object.assign(new Error("A geração em andamento se perdeu quando o Takes foi fechado (o LTX também foi fechado ou começou outra coisa). Use Retomar para gerar de novo."), { code: "INTERRUPTED" });
    let p = await this.ltx.progress().catch(() => null);
    if (!p) throw lost();
    const ours = job.ltxGenerationId ?? (p.id && p.id !== job.ltxBefore ? p.id : null);
    // O pedido nem chegou a começar no LTX (ou o LTX foi reiniciado): basta gerar de novo.
    if (!ours) {
      job.inflight = null;
      return;
    }
    if (p.id !== ours) throw lost();
    job.ltxGenerationId = ours;
    job.ltxActive = true;
    while (p.status === "running") {
      job.phase = `${inf.label} (recuperado depois de reabrir o Takes)`;
      job.stepProgress = p.progress;
      job.remainingSeconds = p.remainingSeconds ?? null;
      this.changed();
      if (job.cancelRequested) return;
      await new Promise((r) => setTimeout(r, this.pollMs));
      p = await this.ltx.progress().catch(() => null);
      if (!p || p.id !== ours) throw lost();
    }
    job.ltxActive = false;
    job.stepProgress = null;
    if (p.status === "cancelled") {
      job.cancelRequested = true;
      return;
    }
    const result = Array.isArray(p.result) ? p.result[0] : p.result;
    if (p.status !== "complete" || !result || !fs.existsSync(result)) throw lost();
    await this.finish(job, result);
  }

  async finish(job, resultPath) {
    const inf = job.inflight;
    if (inf.type === "block") await this.finishBlock(job, inf, resultPath);
    else if (inf.type === "preview") await this.finishPreview(job, inf, resultPath);
    else if (inf.type === "avatar") await this.finishAvatar(job, inf, resultPath);
    job.inflight = null;
    this.changed();
  }

  async runVideo(job) {
    job.done ??= [];
    const total = job.blockIds.length;
    for (const blockId of job.blockIds) {
      if (job.cancelRequested) return;
      if (job.done.includes(blockId)) continue;
      const project = this.store.get(job.projectId);
      const scene = findScene(project, job.sceneId);
      const index = scene.blocks.findIndex((b) => b.id === blockId);
      if (index < 0) {
        job.done.push(blockId); // bloco removido enquanto estava na fila
        continue;
      }
      job.current = { index, n: job.done.length + 1, total };
      job.progress = Math.round((job.done.length / total) * 100);
      const ok = await this.renderBlockWithRetry(job, blockId);
      if (!ok) return;
    }
  }

  // Um bloco que falha é gerado de novo algumas vezes antes de a tarefa parar com erro.
  // Não repete cancelamentos nem erros que só o usuário resolve (pasta de saída, bloco anterior ausente).
  async renderBlockWithRetry(job, blockId) {
    const attempts = this.retryDelays.length + 1;
    for (let attempt = 1; ; attempt++) {
      const project = this.store.get(job.projectId);
      const scene = findScene(project, job.sceneId);
      const index = scene.blocks.findIndex((b) => b.id === blockId);
      if (index < 0) {
        job.done.push(blockId); // bloco removido enquanto esperava a nova tentativa
        return true;
      }
      job.current = { ...job.current, index, attempt, attempts };
      try {
        return await this.renderBlock(job, project, scene, index, { attempt, attempts });
      } catch (error) {
        const final = attempt >= attempts || error.retry === false || error.code === "ABORTED" || job.cancelRequested || this.stopped;
        if (final) {
          if (attempt > 1 && error.retry !== false && error.code !== "ABORTED" && !job.cancelRequested)
            error.message = `Bloco ${index + 1} falhou ${attempt} vezes. Último erro: ${error.message}`;
          throw error;
        }
        job.inflight = null;
        job.ltxGenerationId = null;
        const delay = this.retryDelays[attempt - 1];
        job.phase = `Bloco ${index + 1} falhou (${error.message}). Tentando de novo${delay >= 1000 ? ` em ${Math.round(delay / 1000)} s` : ""}…`;
        this.changed();
        await this.pause(job, delay);
        if (job.cancelRequested) return false;
      }
    }
  }

  // Espera que termina antes se a tarefa for cancelada.
  pause(job, ms) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve) => {
      const signal = job.abort?.signal;
      const done = () => (clearTimeout(t), signal?.removeEventListener("abort", done), resolve());
      const t = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  async renderBlock(job, project, scene, index, { attempt = 1, attempts = 1 } = {}) {
    requireOutput(project);
    const block = scene.blocks[index];
    const s = project.settings;
    const prev = index > 0 ? selectedTake(scene.blocks[index - 1]) : null;
    const mode = index === 0 ? "start" : block.continuity;
    if ((mode === "continue" || mode === "frame") && !prev)
      throw fatal(`O bloco ${index} ainda não foi gerado. Gere os blocos anteriores primeiro.`);
    if ((mode === "continue" || mode === "frame") && !fs.existsSync(prev.file))
      throw fatal(`O vídeo do bloco ${index} não está mais em ${prev.file}.`);

    const folder = sceneFolder(project, scene);
    const work = path.join(folder, ".trabalho");
    await fsp.mkdir(work, { recursive: true });
    // Pula nomes já usados na pasta (cenas apagadas ou recriadas não sobrescrevem vídeos antigos).
    const baseName = (n) => `bloco-${pad(index + 1)}${n > 1 ? `_take-${n}` : ""}`;
    let takeNo = block.takes.length + 1;
    while (fs.existsSync(path.join(folder, `${baseName(takeNo)}.mp4`))) takeNo++;
    const base = baseName(takeNo);
    const signal = job.abort.signal;
    const label = `Bloco ${index + 1} de ${scene.blocks.length}${attempt > 1 ? ` (tentativa ${attempt} de ${attempts})` : ""}`;
    const inflight = {
      type: "block",
      blockId: block.id,
      index,
      mode,
      folder,
      base,
      takeNo,
      duration: block.duration,
      prompt: block.prompt,
      wantedFrames: Math.round(block.duration * s.fps),
      audio: s.audio,
      prevTakeId: prev?.id ?? null,
      usedImage: null,
      contextFrames: 0,
      contextFile: null,
      projectName: project.name,
      sceneTitle: scene.title,
    };
    let result;

    if (mode === "continue") {
      job.phase = `${label}: preparando a continuação`;
      this.changed();
      const info = await this.media.probe(prev.file);
      inflight.contextFrames = this.media.latentFrames(Math.round(s.contextSeconds * info.fps), info.frames);
      inflight.contextFile = path.join(work, `${base}-contexto.mp4`);
      await this.media.cutFrames(prev.file, inflight.contextFile, { startFrame: info.frames - inflight.contextFrames, count: inflight.contextFrames, fps: info.fps, signal });
      inflight.request = { video_path: inflight.contextFile, duration: block.duration, prompt: videoPrompt(project, scene, block, { mode }), mode: "end" };
      result = await this.withLtx(job, `${label}: gerando continuação no LTX`, inflight, () => this.ltx.extend(inflight.request, { signal }));
    } else {
      if (mode === "frame") {
        inflight.usedImage = path.join(work, `${base}-quadro-inicial.png`);
        await this.media.extractFrame(prev.file, inflight.usedImage, { which: "last", signal });
      } else {
        const image = startImage(project, scene);
        inflight.usedImage = image && fs.existsSync(image) ? image : null;
      }
      const allowed = await this.ltx.durations(s.resolution, s.fps);
      inflight.request = {
        prompt: videoPrompt(project, scene, block, { mode, hasImage: Boolean(inflight.usedImage) }),
        promptProvenance: "enhanced", // envia o texto exatamente como escrito
        negativePrompt: project.negativePrompt || "",
        resolution: s.resolution,
        model: "fast",
        duration: renderDuration(block.duration, allowed),
        fps: s.fps,
        audio: s.audio,
        aspectRatio: s.aspectRatio,
        ...(s.seed != null ? { seed: (s.seed + index) % 2147483647 } : {}),
        ...(inflight.usedImage ? { imagePath: inflight.usedImage } : {}),
      };
      result = await this.withLtx(job, `${label}: gerando no LTX`, inflight, () => this.ltx.generateVideo(inflight.request, { signal }));
    }
    if (job.cancelRequested || result?.status !== "complete") return false;
    if (!result.video_path) throw new Error("O LTX não devolveu o vídeo.");
    await this.finish(job, result.video_path);
    return true;
  }

  // Salva o trecho certo do vídeo do LTX como um take do bloco.
  async finishBlock(job, inf, resultPath) {
    const output = path.join(inf.folder, `${inf.base}.mp4`);
    const signal = job.abort?.signal;
    const info = await this.media.probe(resultPath);
    try {
      if (inf.mode === "continue") {
        job.phase = `Bloco ${inf.index + 1}: separando o trecho novo`;
        this.changed();
        const count = Math.min(inf.wantedFrames, info.frames - inf.contextFrames);
        if (count < 1) throw new Error("A continuação gerada não tem quadros novos.");
        await this.media.cutFrames(resultPath, output, { startFrame: inf.contextFrames, count, fps: info.fps, audio: inf.audio && info.hasAudio, signal });
        if (inf.contextFile) await fsp.rm(inf.contextFile, { force: true });
      } else {
        // Recorta sempre no quadro exato: o LTX devolve 8k+1 quadros e às vezes uma trilha de áudio vazia.
        job.phase = `Bloco ${inf.index + 1}: ajustando para ${inf.duration}s`;
        this.changed();
        await this.media.cutFrames(resultPath, output, { startFrame: 0, count: Math.min(inf.wantedFrames, info.frames), fps: info.fps, audio: inf.audio && info.hasAudio, signal });
      }
    } catch (error) {
      await fsp.rm(output, { force: true });
      throw error;
    }
    const take = {
      id: newId(),
      file: output,
      createdAt: new Date().toISOString(),
      mode: inf.mode,
      duration: inf.duration,
      prompt: inf.prompt,
      basedOn: inf.mode === "continue" || inf.mode === "frame" ? inf.prevTakeId : null,
      startImage: inf.usedImage,
    };
    await fsp.writeFile(
      path.join(inf.folder, `${inf.base}.json`),
      JSON.stringify({ project: inf.projectName, scene: inf.sceneTitle, block: inf.index + 1, take: inf.takeNo, mode: inf.mode, request: inf.request, createdAt: take.createdAt }, null, 2),
    );
    this.store.update(job.projectId, (p) => {
      const block = findScene(p, job.sceneId).blocks.find((b) => b.id === inf.blockId);
      if (!block) return;
      block.takes.push(take);
      block.selectedTakeId = take.id;
    });
    job.done.push(inf.blockId);
    job.steps.push({ blockIndex: inf.index, file: output });
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
    const inflight = { type: "preview", request, sceneId: scene?.id ?? null, sceneTitle: scene?.title ?? null };
    const result = await this.withLtx(job, "Gerando prévia no LTX", inflight, () => this.ltx.generateImage(request, { signal: job.abort.signal }));
    if (job.cancelRequested || result?.status !== "complete") return;
    if (!result.image_paths?.[0]) throw new Error("O LTX não devolveu a imagem.");
    await this.finish(job, result.image_paths[0]);
  }

  async finishPreview(job, inf, source) {
    const project = this.store.get(job.projectId);
    requireOutput(project);
    const dir = path.join(project.outputDir, "previas");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${inf.sceneTitle ? slug(inf.sceneTitle, "cena") : "previa"}-${stamp()}${path.extname(source) || ".png"}`);
    await fsp.copyFile(source, file);
    const preview = { id: newId(), sceneId: inf.sceneId, backgroundId: job.backgroundId ?? null, prompt: inf.request.prompt, file, createdAt: new Date().toISOString() };
    this.store.update(project.id, (p) => {
      p.previews.unshift(preview);
    });
    await fsp.writeFile(file.replace(/\.[^.]+$/, ".json"), JSON.stringify({ request: inf.request, createdAt: preview.createdAt }, null, 2));
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
    const result = await this.withLtx(job, "Gerando foto no LTX", { type: "avatar", request }, () => this.ltx.generateImage(request, { signal: job.abort.signal }));
    if (job.cancelRequested || result?.status !== "complete") return;
    if (!result.image_paths?.[0]) throw new Error("O LTX não devolveu a imagem.");
    await this.finish(job, result.image_paths[0]);
  }

  async finishAvatar(job, inf, source) {
    const file = path.join(this.store.assetsDir(job.projectId, "avatar-drafts"), `${job.characterId}-${stamp()}${path.extname(source) || ".png"}`);
    await fsp.copyFile(source, file);
    job.result = { draft: file, characterId: job.characterId };
  }
}
