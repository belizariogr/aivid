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
import { newId, findScene, selectedTake, slug, blockState, MAX_NOTES, frameTimes, storyboardFrames, shotStart } from "./store.js";
import { videoPrompt, previewPrompt, avatarPrompt, keyframePrompt, referencePrompt, framePrompt, STORYBOARD_SHORT_SIDE, REFERENCE_VIEWS, imageSize } from "./prompts.js";
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

// Rascunho e versão final: o rascunho gera em resolução baixa para acertar prompts e aberturas;
// a versão final gera de novo na resolução do projeto, com o plano congelado. Na versão final,
// cada bloco parte da versão final do bloco de origem (mesma resolução).
export const QUALITY = ["draft", "final"];
export function takeFor(block, quality = null) {
  const sel = selectedTake(block);
  if (quality !== "final") return sel;
  if (sel?.quality === "final") return sel;
  return [...(block?.takes ?? [])].reverse().find((t) => t.quality === "final") ?? null;
}

// O que abre o bloco nos modos "start" e "cut": a escolha do corte ou, no 1º bloco, a da cena.
export function openingSpec(scene, index) {
  if (index > 0) return scene.blocks[index]?.start ?? { kind: "scene", id: null };
  return scene.start?.kind ? scene.start : { kind: "none", id: null };
}

// Resolve a abertura em { image }, { source: { scene, block, take } } (quadro a extrair na hora)
// ou { generate: { ref } } (abertura a gerar com o Z-Image a partir da referência `ref`).
export function resolveStart(project, scene, index, spec = openingSpec(scene, index), depth = 0, quality = null) {
  const n = index + 1;
  const kind = spec?.kind ?? "scene";
  if (kind === "none") return { image: null };
  if (kind === "background" || kind === "preview") {
    const file = kind === "background" ? project.backgrounds.find((b) => b.id === spec.id)?.image : project.previews.find((p) => p.id === spec.id)?.file;
    if (!file || !fs.existsSync(file)) throw fatal(`A imagem inicial do bloco ${n} (${kind === "background" ? "fundo" : "prévia"}) não existe mais. Escolha outra.`);
    return { image: file };
  }
  if (kind === "block") {
    const from = scene.blocks.findIndex((b) => b.id === spec.id);
    if (from < 0) throw fatal(`O bloco ${n} começa do último quadro de um bloco que foi removido. Escolha outra imagem inicial.`);
    if (from >= index) throw fatal(`O bloco ${n} começa do último quadro do bloco ${from + 1}, que vem depois dele. Escolha um bloco anterior.`);
    const take = takeFor(scene.blocks[from], quality);
    if (!take) throw Object.assign(fatal(`O bloco ${n} começa do último quadro do bloco ${from + 1}, que ainda não foi gerado${quality === "final" ? " na versão final" : ""}.`), { pending: true });
    if (!fs.existsSync(take.file)) throw fatal(`O vídeo do bloco ${from + 1} não está mais em ${take.file}.`);
    return { source: { scene, block: scene.blocks[from], take } };
  }
  if (kind === "previous") {
    const at = project.scenes.findIndex((s) => s.id === scene.id);
    const before = project.scenes[at - 1];
    if (!before?.blocks.length) throw fatal(`A cena "${scene.title}" abre do último quadro da cena anterior, mas não há cena anterior com blocos.`);
    const last = before.blocks.at(-1);
    const take = takeFor(last, quality);
    if (!take) throw Object.assign(fatal(`A cena "${scene.title}" abre do último quadro da cena anterior, que ainda não foi gerada até o fim${quality === "final" ? " na versão final" : ""}.`), { pending: true });
    if (!fs.existsSync(take.file)) throw fatal(`O vídeo do último bloco da cena anterior não está mais em ${take.file}.`);
    return { source: { scene: before, block: last, take } };
  }
  if (kind === "keyframe") {
    const file = spec.id ? project.previews.find((p) => p.id === spec.id)?.file : null;
    if (file && fs.existsSync(file)) return { image: file, keyframe: true };
    return depth ? { image: null } : { generate: { ref: spec.ref ?? { kind: "scene", id: null } } };
  }
  // "scene": a abertura da cena (se ela ainda vai ser gerada, nada).
  if (index === 0 || depth > 1) {
    const image = startImage(project, scene);
    return { image: image && fs.existsSync(image) ? image : null };
  }
  const opening = resolveStart(project, scene, 0, openingSpec(scene, 0), depth + 1, quality);
  return opening.generate ? { image: null } : opening;
}

// Compatível com a versão anterior: só para blocos de corte.
export const cutStart = (project, scene, index) => resolveStart(project, scene, index);

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

// O que ainda precisa de uma pessoa: blocos sem vídeo, desatualizados, sem arquivo ou reprovados
// pelo juiz (mesmo depois dos retakes).
export function attention(project) {
  const items = [];
  project.scenes.forEach((scene, si) =>
    scene.blocks.forEach((b, bi) => {
      const where = { sceneId: scene.id, blockId: b.id, scene: si + 1, block: bi + 1, sceneTitle: scene.title };
      const st = blockState(scene, bi, project);
      const take = selectedTake(b);
      if (st === "empty") items.push({ ...where, kind: "empty", message: "Ainda não foi gerado." });
      else if (st === "missing") items.push({ ...where, kind: "missing", message: "O arquivo do vídeo sumiu." });
      else if (st === "stale") items.push({ ...where, kind: "stale", message: "O bloco de origem mudou depois desta geração." });
      if (take?.judge && !take.judge.pass)
        items.push({ ...where, kind: "judge", message: `Reprovado pelo juiz (nota ${take.judge.score}): ${[take.judge.reason, ...(take.judge.problems ?? [])].filter(Boolean).join(" ")}` });
    }),
  );
  return items;
}

function report(project, items, film) {
  const lines = [`# ${project.name}`, "", film ? `Filme: ${film}` : "Nenhum bloco gerado para unir.", ""];
  const blocks = project.scenes.reduce((n, s) => n + s.blocks.length, 0);
  lines.push(`${project.scenes.length} cenas, ${blocks} blocos.`, "");
  if (!items.length) lines.push("Nada precisa de revisão.");
  else {
    lines.push(`## Precisa de você (${items.length})`, "");
    for (const i of items) lines.push(`- Cena ${i.scene} (${i.sceneTitle}), bloco ${i.block}: ${i.message}`);
  }
  return lines.join("\n") + "\n";
}

const ACTIVE = ["queued", "running"];
const RESUMABLE = ["interrupted", "error", "cancelled"];

export class JobQueue {
  // `file` guarda a fila em disco: se o Takes fechar no meio de uma geração, ao abrir de novo
  // ele reconhece a geração que o LTX continuou fazendo, mostra o progresso e salva o resultado.
  constructor({ store, ltx, onChange = () => {}, mediaLib = media, file = null, reviewer = null }) {
    this.store = store;
    this.ltx = ltx;
    this.reviewer = reviewer;
    this.media = mediaLib;
    this.onChange = onChange;
    this.file = file;
    this.jobs = [];
    this.running = null;
    this.pollMs = 1500;
    // Consultas seguidas sem resposta do LTX antes de dar uma geração recuperada como perdida.
    this.recoverTolerance = 40;
    // Guarda do LTX: o LTX só gera para o Takes. Uma geração que não é nossa é cancelada; se ele
    // não obedecer em `foreignGraceMs`, ou ficar `unresponsiveLimit` consultas sem responder, ou
    // uma geração nossa ficar `stallMs` sem avançar, o LTX Desktop é reiniciado.
    this.foreignGraceMs = 60_000;
    this.unresponsiveLimit = 20;
    this.stallMs = 12 * 60_000;
    this.maxRestarts = 3;
    this.ltxRestart = null;
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
  addScene(projectId, sceneId, { from = 0, only = null, missing = false, quality = "draft" } = {}) {
    const project = this.store.get(projectId);
    const scene = findScene(project, sceneId);
    quality = QUALITY.includes(quality) ? quality : "draft";
    let blocks = scene.blocks.map((b, i) => ({ id: b.id, index: i }));
    if (only) blocks = blocks.filter((b) => b.id === only);
    else blocks = blocks.slice(from);
    if (missing) blocks = blocks.filter((b) => !takeFor(scene.blocks[b.index], quality));
    if (!blocks.length) throw new Error("Nenhum bloco para gerar.");
    if (this.jobs.some((j) => ACTIVE.includes(j.status) && j.sceneId === sceneId && j.kind === "video"))
      throw new Error("Esta cena já está na fila.");
    return this.add({
      kind: "video",
      projectId,
      sceneId,
      blockIds: blocks.map((b) => b.id),
      quality,
      title: `${quality === "final" ? "★ Final · " : "Rascunho · "}${scene.title} — ${blocks.length === 1 ? `bloco ${blocks[0].index + 1}` : `blocos ${blocks[0].index + 1}–${blocks.at(-1).index + 1}`}`,
    });
  }

  // Põe na fila todas as cenas do projeto, em ordem. Pula as que já estão na fila ou não têm o que gerar.
  addAllScenes(projectId, { missing = false, quality = "draft" } = {}) {
    const project = this.store.get(projectId);
    const added = [];
    const skipped = [];
    for (const scene of project.scenes) {
      // No modo storyboard, cada cena tem o storyboard completado antes do vídeo.
      if (project.settings.storyboard) {
        try {
          this.addStoryboard(projectId, scene.id);
        } catch {
          /* já na fila */
        }
      }
      try {
        added.push(this.addScene(projectId, scene.id, { missing, quality }));
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
        if (job.inflight) {
          const recovered = job.inflight.type === "block" ? job.inflight.blockId : null;
          await this.recoverInflight(job);
          // O bloco recuperado também passa pelo juiz (e pelos retakes, se reprovar).
          if (recovered && job.kind === "video" && job.done?.includes(recovered) && !job.cancelRequested) {
            const index = findScene(this.store.get(job.projectId), job.sceneId).blocks.findIndex((b) => b.id === recovered);
            job.current = { ...job.current, index };
            await this.renderBlockJudged(job, recovered, { rendered: true });
          }
        }
      }
      if (!job.cancelRequested) {
        if (job.kind === "video") await this.runVideo(job);
        else if (job.kind === "film") await this.runFilm(job);
        else if (job.kind === "charsheet") await this.runCharsheet(job);
        else if (job.kind === "storyboard") await this.runStoryboard(job);
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
  // Antes de cada geração: o LTX precisa estar livre. Como só o Takes gera nele, o que estiver
  // rodando é uma geração presa ou perdida: cancela e, se não parar, reinicia o LTX Desktop.
  // Se o LTX estiver fechado ou sem responder, abre (ou reinicia) também.
  async waitForLtx(job) {
    let cancelledAt = null;
    let misses = 0;
    for (;;) {
      if (job.cancelRequested) throw Object.assign(new Error("Operação cancelada."), { code: "ABORTED" });
      if (this.ltxRestart) await this.ltxRestart.catch(() => {});
      let p;
      try {
        p = await this.ltx.progress();
        misses = 0;
      } catch (error) {
        if (error.code === "ABORTED") throw error;
        misses++;
        if (error.code === "NOT_RUNNING") await this.restartLtx(job, "O LTX Desktop estava fechado");
        else if (misses >= this.unresponsiveLimit) {
          await this.restartLtx(job, "O LTX parou de responder");
          misses = 0;
        } else await this.pause(job, this.idlePoll);
        continue;
      }
      if (p.status !== "running") return;
      if (!cancelledAt) {
        job.phase = `O LTX está gerando algo que não é do Takes${p.progress ? ` (${p.progress}%)` : ""}. Cancelando…`;
        this.changed();
        await this.ltx.cancel().catch(() => {});
        cancelledAt = Date.now();
        (job.warnings ??= []).push(`O LTX estava ocupado com uma geração que não era do Takes${p.progress ? ` (parada em ${p.progress}%)` : ""}; ela foi cancelada.`);
      } else if (Date.now() - cancelledAt > this.foreignGraceMs) {
        await this.restartLtx(job, "O LTX não parou a geração que não era do Takes");
        cancelledAt = null;
        continue;
      }
      await this.pause(job, this.idlePoll);
    }
  }

  // Reinicia o LTX Desktop uma vez por vez (outras chamadas esperam a mesma reinicialização).
  restartLtx(job, reason) {
    if (this.ltxRestart) return this.ltxRestart;
    job.ltxRestarts = (job.ltxRestarts ?? 0) + 1;
    if (job.ltxRestarts > this.maxRestarts)
      return Promise.reject(fatal(`${reason}, e o LTX Desktop já foi reiniciado ${this.maxRestarts} vezes nesta tarefa. Confira o LTX e use Retomar.`));
    (job.warnings ??= []).push(`${reason}: o LTX Desktop foi reiniciado (${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}).`);
    job.phase = `${reason}. Reiniciando o LTX Desktop…`;
    this.changed();
    this.ltxRestart = this.ltx
      .restartApp({ signal: job.abort?.signal, onPhase: (text) => ((job.phase = text), this.changed()) })
      .finally(() => (this.ltxRestart = null));
    return this.ltxRestart;
  }

  // Chama o LTX acompanhando o progresso. `inflight` descreve como salvar o resultado e fica
  // gravado até o resultado ser salvo, para a geração sobreviver a um fechamento do Takes.
  async withLtx(job, label, inflight, call) {
    await this.waitForLtx(job);
    await this.ltx.ensureLocal();
    job.phase = label;
    job.ltxBefore = (await this.ltx.progress().catch(() => ({}))).id ?? null;
    job.ltxGenerationId = null;
    job.inflight = { label, ...inflight };
    job.ltxActive = true;
    this.changed();
    // Vigia: uma geração que não avança por `stallMs` (ou um LTX que não responde) é cancelada e,
    // se preciso, o LTX é reiniciado; o bloco é gerado de novo pelas novas tentativas.
    let lastSign = null;
    let lastChange = Date.now();
    let misses = 0;
    let stalled = null;
    let stalledAt = 0;
    let polling = false;
    const stall = async (reason) => {
      stalled = reason;
      stalledAt = Date.now();
      job.phase = `${reason}. Cancelando…`;
      this.changed();
      await this.ltx.cancel().catch(() => {});
    };
    const timer = setInterval(async () => {
      if (polling || this.ltxRestart) return;
      polling = true;
      try {
        const p = await this.ltx.progress();
        misses = 0;
        const sign = `${p.id}|${p.status}|${p.progress}|${p.phase}|${p.currentStep}`;
        if (sign !== lastSign) {
          lastSign = sign;
          lastChange = Date.now();
        }
        if (p.status === "running" && job.status === "running" && !job.cancelRequested) {
          if (p.id && p.id !== job.ltxBefore) job.ltxGenerationId = p.id;
          job.stepProgress = p.progress;
          job.remainingSeconds = p.remainingSeconds ?? null;
          if (!stalled && Date.now() - lastChange > this.stallMs) await stall(`O LTX travou em ${p.progress ?? 0}% (${Math.round(this.stallMs / 60_000)} min sem avançar)`);
          else if (stalled && Date.now() - stalledAt > this.foreignGraceMs) this.restartLtx(job, `${stalled} e não parou`).catch(() => {});
          else this.changed();
        }
      } catch {
        // A chamada principal reporta falhas da geração; aqui só conta o LTX sem responder.
        if (++misses >= this.unresponsiveLimit && !stalled) {
          stalled = "O LTX parou de responder durante a geração";
          stalledAt = Date.now();
          this.restartLtx(job, stalled).catch(() => {});
        }
      } finally {
        polling = false;
      }
    }, this.pollMs);
    const retry = () => Object.assign(new Error(`${stalled}; o bloco vai ser gerado de novo.`), { code: "LTX_STALLED" });
    try {
      let result;
      try {
        result = await call();
      } catch (error) {
        if (stalled && !job.cancelRequested) throw retry();
        throw error;
      }
      if (stalled && !job.cancelRequested) throw retry();
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
    // Durante a inferência o LTX às vezes demora a responder: só desiste depois de várias
    // consultas seguidas sem resposta, não na primeira.
    const poll = async () => {
      for (let miss = 0; miss < this.recoverTolerance; miss++) {
        const r = await this.ltx.progress().catch(() => null);
        if (r) return r;
        if (job.cancelRequested) return null;
        await new Promise((res) => setTimeout(res, this.pollMs));
      }
      return null;
    };
    let p = await poll();
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
      p = await poll();
      if (job.cancelRequested) return;
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
    let out;
    if (inf.type === "block") out = await this.finishBlock(job, inf, resultPath);
    else if (inf.type === "preview") out = await this.finishPreview(job, inf, resultPath);
    else if (inf.type === "avatar") out = await this.finishAvatar(job, inf, resultPath);
    else if (inf.type === "keyframe") out = await this.finishKeyframe(job, inf, resultPath);
    else if (inf.type === "charsheet") out = await this.finishCharsheet(job, inf, resultPath);
    else if (inf.type === "frame") out = await this.finishFrame(job, inf, resultPath);
    job.inflight = null;
    this.changed();
    return out;
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
      const ok = await this.renderBlockJudged(job, blockId);
      if (!ok) return;
    }
  }

  // Um bloco que falha é gerado de novo algumas vezes antes de a tarefa parar com erro.
  // Não repete cancelamentos nem erros que só o usuário resolve (pasta de saída, bloco anterior ausente).
  // Revisão antes, geração com novas tentativas e, com o juiz ligado, retakes até aprovar.
  // Se nenhum take for aprovado, fica o de maior nota e o bloco aparece em "Precisa de você".
  // `rendered`: o 1º take já existe (recuperado depois de reabrir o Takes); só falta o juiz.
  async renderBlockJudged(job, blockId, { rendered = false } = {}) {
    // Na versão final o plano já foi acertado no rascunho: sem revisão nem ajustes, só o juiz.
    const frozen = job.quality === "final";
    if (!rendered && !frozen) await this.reviewBlock(job, blockId);
    if (job.cancelRequested) return false;
    const verdicts = [];
    for (let retake = 0; ; retake++) {
      const ok = rendered && retake === 0 ? true : await this.renderBlockWithRetry(job, blockId, { retake });
      if (!ok) return false;
      const verdict = await this.judgeBlock(job, blockId);
      if (!verdict) return true;
      verdicts.push(verdict);
      const max = Math.min(3, Math.max(0, Number(this.store.get(job.projectId).settings.retakes ?? 2) || 0));
      if (verdict.pass) return true;
      const n = (job.current?.index ?? 0) + 1;
      if (retake >= max) {
        const best = verdicts.reduce((a, b) => (b.score > a.score ? b : a));
        this.store.update(job.projectId, (p) => {
          const b = findScene(p, job.sceneId).blocks.find((x) => x.id === blockId);
          if (b?.takes.some((t) => t.id === best.takeId)) b.selectedTakeId = best.takeId;
        });
        (job.warnings ??= []).push(`Bloco ${n}: nenhum take passou no juiz depois de ${verdicts.length} tentativa(s); ficou o de nota ${best.score}. ${best.reason}`);
        this.changed();
        return true;
      }
      job.phase = `Bloco ${n} reprovado pelo juiz (${verdict.reason || "sem motivo"}). Ajustando para o take ${retake + 2}…`;
      this.changed();
      if (!frozen) await this.reviseAfterJudge(job, blockId, verdict, retake + 1);
      if (job.cancelRequested) return false;
      job.phase = `Bloco ${n}: gerando outro take (${retake + 1} de ${max})…`;
      this.changed();
    }
  }

  // Antes de um retake: a LLM recebe o que o juiz apontou e os quadros do take reprovado e ajusta
  // prompt, estado ou abertura (ou mantém tudo, e o retake só troca a semente). Se falhar, o retake
  // segue com o mesmo plano.
  async reviseAfterJudge(job, blockId, verdict, retake) {
    if (!this.reviewer?.revise) return;
    const project = this.store.get(job.projectId);
    const scene = findScene(project, job.sceneId);
    const index = scene.blocks.findIndex((b) => b.id === blockId);
    const block = scene.blocks[index];
    const take = block?.takes.find((t) => t.id === verdict.takeId);
    if (!take || !fs.existsSync(take.file)) return;
    job.phase = `Bloco ${index + 1}: a IA está ajustando o bloco a partir do que o juiz apontou`;
    this.changed();
    try {
      const work = path.join(sceneFolder(project, scene), ".trabalho");
      await fsp.mkdir(work, { recursive: true });
      const r = await this.reviewer.revise({ project, scene, index, take, verdict, work, signal: job.abort?.signal });
      const review = {
        at: new Date().toISOString(),
        kind: "retake",
        retake,
        changed: r.changed,
        reason: r.reason,
        model: r.model,
        before: r.changed
          ? { continuity: block.continuity, start: block.start, prompt: block.prompt, note: block.note, currentState: block.currentState ?? "", opening: block.opening ?? "", ...(r.sceneStart ? { sceneStart: scene.start } : {}) }
          : null,
      };
      this.store.update(job.projectId, (p) => {
        const sc = findScene(p, job.sceneId);
        const b = sc.blocks.find((x) => x.id === blockId);
        if (!b) return;
        if (r.changed) Object.assign(b, index === 0 ? { prompt: r.block.prompt, note: r.block.note, currentState: r.block.currentState, opening: r.block.opening } : r.block);
        if (index === 0 && r.sceneStart) sc.start = r.sceneStart;
        if (r.regenerateOpening) {
          if (index === 0 && sc.start.kind === "keyframe") sc.start = { ...sc.start, id: null };
          else if (b.start?.kind === "keyframe") b.start = { ...b.start, id: null };
        }
        b.review = review;
      });
      (job.reviews ??= []).push({ blockIndex: index, changed: r.changed, reason: r.reason, retake });
      this.learn(job, r.memory, `IA · ${scene.title}, bloco ${index + 1} (take reprovado)`);
    } catch (error) {
      if (error.code === "ABORTED" || job.cancelRequested || job.abort?.signal.aborted) {
        job.cancelRequested = true;
        return;
      }
      (job.warnings ??= []).push(`Bloco ${index + 1}: o ajuste antes do retake falhou (${error.message}); o retake usou o mesmo plano.`);
    }
    this.changed();
  }

  // Juiz depois do bloco: a LLM olha quadros do take e diz se a ação, os personagens, o estado e a
  // transição estão certos. Devolve null se o juiz estiver desligado ou falhar (aí o take fica).
  async judgeBlock(job, blockId) {
    const project = this.store.get(job.projectId);
    if (!this.reviewer || !project.settings.judge) return null;
    const scene = findScene(project, job.sceneId);
    const index = scene.blocks.findIndex((b) => b.id === blockId);
    const take = selectedTake(scene.blocks[index]);
    if (!take || !fs.existsSync(take.file)) return null;
    job.phase = `Bloco ${index + 1}: o juiz está conferindo o take`;
    this.changed();
    try {
      const work = path.join(sceneFolder(project, scene), ".trabalho");
      await fsp.mkdir(work, { recursive: true });
      const v = await this.reviewer.judge({ project, scene, index, take, work, signal: job.abort?.signal });
      const judge = { at: new Date().toISOString(), pass: v.pass, score: v.score, problems: v.problems, reason: v.reason, model: v.model };
      this.store.update(job.projectId, (p) => {
        const t = findScene(p, job.sceneId).blocks.find((x) => x.id === blockId)?.takes.find((x) => x.id === take.id);
        if (t) t.judge = judge;
      });
      (job.judged ??= []).push({ blockIndex: index, pass: v.pass, score: v.score });
      this.changed();
      return { takeId: take.id, ...judge };
    } catch (error) {
      if (error.code === "ABORTED" || job.cancelRequested || job.abort?.signal.aborted) {
        job.cancelRequested = true;
        return null;
      }
      (job.warnings ??= []).push(`Bloco ${index + 1}: o juiz falhou (${error.message}). O take ficou sem conferência.`);
      this.changed();
      return null;
    }
  }

  async renderBlockWithRetry(job, blockId, { retake = 0 } = {}) {
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
        return await this.renderBlock(job, project, scene, index, { attempt, attempts, retake });
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

  // Revisão de continuidade com IA (opcional, por projeto): a LLM vê os quadros já gerados e pode
  // ajustar a continuidade, a imagem inicial e o prompt do bloco antes de ele ir para o LTX.
  // Se a revisão falhar, o bloco segue o plano e a tarefa guarda um aviso.
  async reviewBlock(job, blockId) {
    const project = this.store.get(job.projectId);
    if (!this.reviewer || !project.settings.review) return;
    const scene = findScene(project, job.sceneId);
    const index = scene.blocks.findIndex((b) => b.id === blockId);
    const prev = index > 0 ? selectedTake(scene.blocks[index - 1]) : null;
    if (!prev || !fs.existsSync(prev.file)) return; // sem quadro real para revisar
    const block = scene.blocks[index];
    job.phase = `Bloco ${index + 1}: revisando a continuidade com IA`;
    this.changed();
    const work = path.join(sceneFolder(project, scene), ".trabalho");
    let startImage = null;
    try {
      await fsp.mkdir(work, { recursive: true });
      if (block.continuity === "cut") startImage = resolveStart(project, scene, index).image ?? null;
    } catch {
      /* o erro da imagem inicial aparece na geração */
    }
    try {
      const r = await this.reviewer.review({ project, scene, index, work, startImage, signal: job.abort?.signal });
      const review = {
        at: new Date().toISOString(),
        changed: r.changed,
        reason: r.reason,
        model: r.model,
        before: r.changed ? { continuity: block.continuity, start: block.start, prompt: block.prompt, note: block.note, currentState: block.currentState ?? "", opening: block.opening ?? "" } : null,
      };
      this.store.update(job.projectId, (p) => {
        const b = findScene(p, job.sceneId).blocks.find((x) => x.id === blockId);
        if (!b) return;
        if (r.changed) Object.assign(b, r.block);
        b.review = review;
      });
      (job.reviews ??= []).push({ blockIndex: index, changed: r.changed, reason: r.reason });
      this.learn(job, r.memory, `IA · ${scene.title}, bloco ${index + 1}`);
    } catch (error) {
      if (error.code === "ABORTED" || job.cancelRequested || job.abort?.signal.aborted) {
        job.cancelRequested = true;
        return;
      }
      (job.warnings ??= []).push(`Bloco ${index + 1}: a revisão de continuidade falhou (${error.message}). O bloco seguiu o plano.`);
    }
    this.changed();
  }

  // Aprendizados que a IA anotou para todo o projeto (se o projeto permitir).
  learn(job, memory, source) {
    if (!memory || (!memory.add?.length && !memory.remove?.length)) return;
    const project = this.store.get(job.projectId);
    if (project.settings.learn === false) return;
    let added = 0;
    let full = false;
    this.store.update(job.projectId, (p) => {
      p.memory = (p.memory ?? []).filter((n) => !memory.remove.includes(n.id));
      for (const text of memory.add) {
        if (p.memory.some((n) => n.text.toLowerCase() === text.toLowerCase())) continue;
        if (p.memory.length >= MAX_NOTES) {
          full = true;
          break;
        }
        p.memory.push({ id: newId(), text, at: new Date().toISOString(), by: source });
        added++;
      }
    });
    (job.learned ??= []).push({ added, removed: memory.remove.length, source });
    if (full) (job.warnings ??= []).push(`A IA quis anotar um aprendizado, mas o projeto já tem ${MAX_NOTES} notas. Apague as que não servem mais na aba Projeto.`);
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

  async renderBlock(job, project, scene, index, { attempt = 1, attempts = 1, retake = 0 } = {}) {
    requireOutput(project);
    const block = scene.blocks[index];
    const s = project.settings;
    const quality = job.quality ?? "draft";
    const resolution = quality === "final" ? s.resolution : s.draftResolution ?? s.resolution;
    const prev = index > 0 ? takeFor(scene.blocks[index - 1], quality) : null;
    // Modo storyboard: o 1º bloco de cada plano nasce dos quadros (keyframes); os blocos seguintes
    // do mesmo plano continuam o vídeo (extend, com o plano já gerado como contexto) e os quadros
    // servem de gabarito para o juiz. "Partir do último quadro" usa o último quadro real como
    // primeiro keyframe.
    const shotFirst = index === 0 || block.continuity === "cut";
    const board = s.storyboard ? storyboardFrames(project, scene, index) : [];
    const boardReady = board.length >= 2 && board.every((f) => f.file);
    if (s.storyboard && shotFirst && !boardReady) throw Object.assign(fatal(`O bloco ${index + 1} ainda não tem o storyboard completo. Gere o storyboard da cena antes do vídeo.`), { pending: true });
    const useBoard = s.storyboard && boardReady && (shotFirst || (block.continuity === "frame" && prev));
    const mode = useBoard ? "storyboard" : index === 0 ? "start" : block.continuity;
    if ((mode === "continue" || mode === "frame") && !prev)
      throw fatal(`O bloco ${index} ainda não foi gerado${quality === "final" ? " na versão final" : ""}. Gere os blocos anteriores primeiro.`);
    if ((mode === "continue" || mode === "frame") && !fs.existsSync(prev.file))
      throw fatal(`O vídeo do bloco ${index} não está mais em ${prev.file}.`);

    const folder = sceneFolder(project, scene);
    const work = path.join(folder, ".trabalho");
    await fsp.mkdir(work, { recursive: true });
    // Pula nomes já usados na pasta (cenas apagadas ou recriadas não sobrescrevem vídeos antigos).
    const baseName = quality === "final" ? (n) => `bloco-${pad(index + 1)}_final${n > 1 ? `-${n}` : ""}` : (n) => `bloco-${pad(index + 1)}${n > 1 ? `_take-${n}` : ""}`;
    let takeNo = (quality === "final" ? block.takes.filter((t) => t.quality === "final").length : block.takes.filter((t) => t.quality !== "final").length) + 1;
    while (fs.existsSync(path.join(folder, `${baseName(takeNo)}.mp4`))) takeNo++;
    const base = baseName(takeNo);
    const signal = job.abort.signal;
    const label = `${quality === "final" ? "★ Final" : `Rascunho ${resolution}`} · bloco ${index + 1} de ${scene.blocks.length}${retake ? ` (retake ${retake})` : ""}${attempt > 1 ? ` (tentativa ${attempt} de ${attempts})` : ""}`;
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
      sourceBlockId: mode === "continue" || mode === "frame" ? scene.blocks[index - 1].id : null,
      sourceSceneId: null,
      usedImage: null,
      contextFrames: 0,
      contextFile: null,
      projectName: project.name,
      sceneTitle: scene.title,
      retake,
      quality,
      resolution,
    };
    let result;

    if (mode === "storyboard") {
      const allowed = await this.ltx.durations(resolution, s.fps);
      const renderDur = renderDuration(block.duration, allowed);
      const last = Math.floor((renderDur * s.fps) / 8) * 8;
      const used = new Set();
      // Depois de "partir do último quadro", o 1º keyframe é o último quadro real do bloco anterior.
      if (!shotFirst && prev) {
        const last = path.join(work, `${base}-quadro-inicial.png`);
        await this.media.extractFrame(prev.file, last, { which: "last", signal });
        board[0] = { ...board[0], file: last };
      }
      const keyframes = board.map((f) => {
        let at = Math.min(last, Math.round(Math.min(f.at, block.duration) * s.fps));
        while (used.has(at) && at > 0) at--;
        used.add(at);
        return { imagePath: f.file, frameIndex: at, strength: 1 };
      });
      inflight.usedImage = board[0].file;
      inflight.request = {
        prompt: videoPrompt(project, scene, block, { mode }),
        promptProvenance: "enhanced",
        negativePrompt: project.negativePrompt || "",
        resolution,
        model: "fast",
        duration: renderDur,
        fps: s.fps,
        audio: s.audio,
        aspectRatio: s.aspectRatio,
        ...(s.seed != null ? { seed: (s.seed + index + retake * 7919) % 2147483647 } : {}),
        keyframes,
      };
      result = await this.withLtx(job, `${label}: gerando no LTX pelo storyboard (${keyframes.length} quadros)`, inflight, () => this.ltx.generateVideo(inflight.request, { signal }));
    } else if (mode === "continue") {
      job.phase = `${label}: preparando a continuação`;
      this.changed();
      // Contexto: o fim do plano já gerado (os blocos anteriores do mesmo plano, até `contextSeconds`),
      // para o LTX continuar vendo os personagens, o estado e o movimento, e não só os últimos 2 s.
      const want = Number(s.contextSeconds) || 20;
      const parts = [];
      let seconds = 0;
      for (let k = index - 1; k >= shotStart(scene, index) && seconds < want; k--) {
        const t = k === index - 1 ? prev : takeFor(scene.blocks[k], quality);
        if (!t || !fs.existsSync(t.file)) break;
        parts.unshift(t.file);
        seconds += Number(scene.blocks[k].duration) || 0;
      }
      let source = prev.file;
      if (parts.length > 1) {
        source = path.join(work, `${base}-plano.mp4`);
        await this.media.concat(parts, source, { audio: s.audio, signal });
      }
      const info = await this.media.probe(source);
      inflight.contextFrames = this.media.latentFrames(Math.round(want * info.fps), info.frames);
      inflight.contextFile = path.join(work, `${base}-contexto.mp4`);
      await this.media.cutFrames(source, inflight.contextFile, { startFrame: info.frames - inflight.contextFrames, count: inflight.contextFrames, fps: info.fps, audio: s.audio && info.hasAudio, signal });
      if (source !== prev.file) await fsp.rm(source, { force: true });
      inflight.request = { video_path: inflight.contextFile, duration: block.duration, prompt: videoPrompt(project, scene, block, { mode }), mode: "end" };
      result = await this.withLtx(job, `${label}: gerando continuação no LTX`, inflight, () => this.ltx.extend(inflight.request, { signal }));
    } else {
      if (mode === "frame") {
        inflight.usedImage = path.join(work, `${base}-quadro-inicial.png`);
        await this.media.extractFrame(prev.file, inflight.usedImage, { which: "last", signal });
      } else {
        const start = resolveStart(project, scene, index, undefined, 0, quality);
        if (start.generate) {
          inflight.usedImage = await this.makeKeyframe(job, project, scene, index, start.generate.ref, label);
          if (job.cancelRequested) return false;
        } else if (start.source) {
          inflight.usedImage = path.join(work, `${base}-quadro-inicial.png`);
          inflight.prevTakeId = start.source.take.id;
          inflight.sourceBlockId = start.source.block.id;
          inflight.sourceSceneId = start.source.scene.id !== scene.id ? start.source.scene.id : null;
          await this.media.extractFrame(start.source.take.file, inflight.usedImage, { which: "last", signal });
        } else {
          inflight.usedImage = start.image;
          inflight.prevTakeId = null;
        }
      }
      const allowed = await this.ltx.durations(resolution, s.fps);
      inflight.request = {
        prompt: videoPrompt(project, scene, block, { mode, hasImage: Boolean(inflight.usedImage) }),
        promptProvenance: "enhanced", // envia o texto exatamente como escrito
        negativePrompt: project.negativePrompt || "",
        resolution,
        model: "fast",
        duration: renderDuration(block.duration, allowed),
        fps: s.fps,
        audio: s.audio,
        aspectRatio: s.aspectRatio,
        // Cada retake muda a seed fixa; sem seed, o LTX já sorteia uma.
        ...(s.seed != null ? { seed: (s.seed + index + retake * 7919) % 2147483647 } : {}),
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
      basedOn: inf.sourceBlockId || inf.mode === "continue" || inf.mode === "frame" ? inf.prevTakeId : null,
      basedOnBlock: inf.sourceBlockId ?? null,
      basedOnScene: inf.sourceSceneId ?? null,
      retake: inf.retake ?? 0,
      quality: inf.quality ?? "draft",
      resolution: inf.resolution ?? null,
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
    if (!job.done.includes(inf.blockId)) job.done.push(inf.blockId);
    job.steps.push({ blockIndex: inf.index, file: output });
  }

  // Gera com o Z-Image o quadro de abertura de um corte (ou do 1º bloco), a partir da referência
  // escolhida, e guarda como prévia. Com o juiz ligado, a LLM confere a imagem e pede outra uma vez.
  // Sem o Z-Image, usa a própria referência e deixa um aviso.
  async makeKeyframe(job, project, scene, index, ref, label) {
    const block = scene.blocks[index];
    const signal = job.abort.signal;
    const work = path.join(sceneFolder(project, scene), ".trabalho");
    await fsp.mkdir(work, { recursive: true });
    let reference = null;
    let from;
    try {
      from = resolveStart(project, scene, index, ref, 1, job.quality ?? "draft");
    } catch (error) {
      // Referência que ainda vai existir (bloco ou cena anterior por gerar): espera, não improvisa.
      if (error.pending) throw error;
      // A referência sumiu (fundo excluído, bloco removido): gera a abertura só pelo texto.
      (job.warnings ??= []).push(`Bloco ${index + 1}: a referência da imagem de abertura não está disponível (${error.message}); a imagem foi gerada só pelo texto.`);
      from = { image: null };
    }
    if (from.source) {
      reference = path.join(work, `bloco-${pad(index + 1)}-referencia-${Date.now().toString(36)}.png`);
      await this.media.extractFrame(from.source.take.file, reference, { which: "last", signal });
    } else reference = from.image ?? null;
    const { width, height } = imageSize(project.settings.aspectRatio);
    const request = {
      prompt: keyframePrompt(project, scene, block),
      width,
      height,
      numImages: 1,
      ...(reference ? { imagePath: reference, strength: 0.65 } : {}),
    };
    const check = Boolean(this.reviewer && project.settings.judge);
    const tries = check ? 2 : 1;
    for (let t = 1; t <= tries; t++) {
      let result;
      try {
        const inflight = { type: "keyframe", request, blockId: block.id, index, sceneTitle: scene.title };
        result = await this.withLtx(job, `${label}: gerando a imagem de abertura`, inflight, () => this.ltx.generateImage(request, { signal }));
      } catch (error) {
        if (error.code !== "NO_IMAGE_MODEL") throw error;
        (job.warnings ??= []).push(`Bloco ${index + 1}: sem o Z-Image no LTX, a abertura usou ${reference ? "a referência" : "só o texto"} em vez de uma imagem gerada.`);
        return reference;
      }
      if (job.cancelRequested || result?.status !== "complete") return null;
      if (!result.image_paths?.[0]) throw new Error("O LTX não devolveu a imagem de abertura.");
      const file = await this.finish(job, result.image_paths[0]);
      if (t === tries) return file;
      job.phase = `Bloco ${index + 1}: o juiz está conferindo a imagem de abertura`;
      this.changed();
      const fresh = this.store.get(job.projectId);
      const verdict = await this.reviewer
        .checkKeyframe({ project: fresh, scene: findScene(fresh, job.sceneId), index, file, work, signal })
        .catch((error) => (error.code === "ABORTED" || signal.aborted ? Promise.reject(error) : null));
      if (!verdict || verdict.pass) return file;
      (job.warnings ??= []).push(`Bloco ${index + 1}: a 1ª imagem de abertura foi recusada pelo juiz (${verdict.reason}); gerada outra.`);
    }
    return null;
  }

  async finishKeyframe(job, inf, source) {
    const project = this.store.get(job.projectId);
    requireOutput(project);
    const dir = path.join(project.outputDir, "previas");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slug(inf.sceneTitle, "cena")}-bloco-${pad(inf.index + 1)}-abertura-${stamp()}${path.extname(source) || ".png"}`);
    await fsp.copyFile(source, file);
    const preview = { id: newId(), sceneId: job.sceneId, backgroundId: null, kind: "keyframe", blockId: inf.blockId, prompt: inf.request.prompt, file, createdAt: new Date().toISOString() };
    await fsp.writeFile(file.replace(/\.[^.]+$/, ".json"), JSON.stringify({ request: inf.request, createdAt: preview.createdAt }, null, 2));
    this.store.update(job.projectId, (p) => {
      p.previews.unshift(preview);
      const scene = findScene(p, job.sceneId);
      const block = scene.blocks.find((b) => b.id === inf.blockId);
      const index = scene.blocks.indexOf(block);
      if (index === 0 && scene.start.kind === "keyframe") scene.start = { ...scene.start, id: preview.id };
      else if (block?.start?.kind === "keyframe") block.start = { ...block.start, id: preview.id };
    });
    return file;
  }

  // Filme completo: põe as cenas na fila e, no fim, une tudo e escreve o relatório.
  addFilm(projectId, { missing = true, quality = "draft" } = {}) {
    quality = QUALITY.includes(quality) ? quality : "draft";
    const project = this.store.get(projectId);
    if (!project.scenes.length) throw Object.assign(new Error("Nenhuma cena para gerar."), { status: 409 });
    if (this.jobs.some((j) => ACTIVE.includes(j.status) && j.kind === "film" && j.projectId === projectId))
      throw Object.assign(new Error("O filme deste projeto já está na fila."), { status: 409 });
    const added = [];
    const skipped = [];
    for (const scene of project.scenes) {
      // No modo storyboard, cada cena tem o storyboard completado antes do vídeo.
      if (project.settings.storyboard) {
        try {
          this.addStoryboard(projectId, scene.id);
        } catch {
          /* já na fila */
        }
      }
      try {
        added.push(this.addScene(projectId, scene.id, { missing, quality }));
      } catch (error) {
        skipped.push({ sceneId: scene.id, title: scene.title, reason: error.message });
      }
    }
    const film = this.add({ kind: "film", projectId, quality, title: `${project.name} — ${quality === "final" ? "★ versão final" : "rascunho"} do filme` });
    return { added, skipped, film };
  }

  async runFilm(job) {
    const project = this.store.get(job.projectId);
    requireOutput(project);
    job.phase = "Unindo as cenas";
    this.changed();
    const files = [];
    const quality = job.quality ?? "draft";
    let lacking = 0;
    for (const scene of project.scenes)
      scene.blocks.forEach((b) => {
        const take = takeFor(b, quality);
        if (take && fs.existsSync(take.file)) files.push(take.file);
        else lacking++;
      });
    const name = slug(project.name, "filme");
    const output = path.join(project.outputDir, `${name}-${quality === "final" ? "filme" : "rascunho"}.mp4`);
    if (files.length) await this.media.concat(files, output, { audio: project.settings.audio, signal: job.abort?.signal });
    const items = attention(project);
    const reportFile = path.join(project.outputDir, `${name}-relatorio.md`);
    await fsp.writeFile(reportFile, report(project, items, files.length ? output : null));
    job.result = { file: files.length ? output : null, report: reportFile, attention: items.length, blocks: files.length, lacking, quality };
    job.phase = items.length ? `Filme pronto. ${items.length} ponto(s) precisam de você.` : "Filme pronto.";
  }

  // Fichas de referência de um personagem: frente, perfil e corpo inteiro.
  addCharsheet(projectId, characterId) {
    const project = this.store.get(projectId);
    const character = project.characters.find((c) => c.id === characterId);
    if (!character) throw Object.assign(new Error("Personagem não encontrado."), { status: 404 });
    if (this.jobs.some((j) => ACTIVE.includes(j.status) && j.kind === "charsheet" && j.characterId === characterId))
      throw Object.assign(new Error("As fichas deste personagem já estão na fila."), { status: 409 });
    return this.add({ kind: "charsheet", projectId, characterId, title: `Fichas de referência — ${character.name}` });
  }

  async runCharsheet(job) {
    job.done ??= [];
    for (const view of Object.keys(REFERENCE_VIEWS)) {
      if (job.cancelRequested) return;
      if (job.done.includes(view)) continue;
      const project = this.store.get(job.projectId);
      const character = project.characters.find((c) => c.id === job.characterId);
      if (!character) throw new Error("Personagem não encontrado.");
      const photo = character.photo && fs.existsSync(character.photo) ? character.photo : null;
      const body = view === "body";
      const request = {
        prompt: referencePrompt(project, character, view),
        width: 768,
        height: body ? 1152 : 768,
        numImages: 1,
        ...(photo ? { imagePath: photo, strength: body ? 0.7 : 0.5 } : {}),
      };
      job.progress = Math.round((job.done.length / 3) * 100);
      const result = await this.withLtx(job, `Gerando ${REFERENCE_VIEWS[view].label.toLowerCase()} de ${character.name}`, { type: "charsheet", view, request }, () =>
        this.ltx.generateImage(request, { signal: job.abort.signal }),
      );
      if (job.cancelRequested || result?.status !== "complete") return;
      if (!result.image_paths?.[0]) throw new Error("O LTX não devolveu a imagem.");
      await this.finish(job, result.image_paths[0]);
    }
  }

  async finishCharsheet(job, inf, source) {
    const file = path.join(this.store.assetsDir(job.projectId, "character-refs"), `${job.characterId}-${inf.view}-${stamp()}${path.extname(source) || ".png"}`);
    await fsp.copyFile(source, file);
    this.store.update(job.projectId, (p) => {
      const c = p.characters.find((x) => x.id === job.characterId);
      if (!c) return;
      c.refs = [...(c.refs ?? []).filter((r) => r.view !== inf.view), { view: inf.view, file, createdAt: new Date().toISOString() }];
    });
    if (!job.done.includes(inf.view)) job.done.push(inf.view);
    return file;
  }

  // Storyboard da cena: a IA descreve os quadros de cada bloco, o Z-Image desenha cada um em alta
  // definição e a IA confere cada imagem (refaz com a descrição corrigida até 3 vezes). O vídeo
  // depois passa por esses quadros.
  addStoryboard(projectId, sceneId, { redo = false } = {}) {
    const scene = findScene(this.store.get(projectId), sceneId);
    if (this.jobs.some((j) => ACTIVE.includes(j.status) && j.kind === "storyboard" && j.sceneId === sceneId))
      throw Object.assign(new Error("O storyboard desta cena já está na fila."), { status: 409 });
    return this.add({ kind: "storyboard", projectId, sceneId, redo, title: `🎞 Storyboard · ${scene.title}` });
  }

  async runStoryboard(job) {
    let project = this.store.get(job.projectId);
    requireOutput(project);
    let scene = findScene(project, job.sceneId);
    const every = project.settings.frameEvery ?? 2;
    const layout = scene.blocks.map((b, i) => frameTimes(b, i, every));
    const matches = (frames, want) => frames?.length === want.length && want.every((w, k) => Math.abs(frames[k].at - w.at) < 0.01 && frames[k].shared === w.shared && (w.shared || frames[k].description));
    if (!job.planned && (job.redo || scene.blocks.some((b, i) => !matches(b.frames, layout[i])))) {
      if (!this.reviewer?.planStoryboard) throw fatal("Escolha o modelo do roteiro em Configurações para planejar o storyboard.");
      job.phase = `Storyboard de "${scene.title}": a IA está descrevendo os quadros`;
      this.changed();
      const plan = await this.reviewer.planStoryboard({ project, scene, layout, signal: job.abort?.signal });
      this.store.update(job.projectId, (p) => {
        const sc = findScene(p, job.sceneId);
        sc.blocks.forEach((b, i) => {
          const got = plan.blocks.find((x) => x.index === i);
          if (got?.prompt) b.prompt = got.prompt;
          const shot = i === 0 || b.continuity === "cut";
          b.plate = shot && got?.plate ? { description: got.plate, imageId: b.plate?.description === got.plate && !job.redo ? b.plate.imageId ?? null : null } : null;
          b.frames = layout[i].map((w) => {
            const old = (b.frames ?? []).find((f) => Math.abs(f.at - w.at) < 0.01);
            const description = w.shared ? "" : got?.frames.find((f) => Math.abs(f.at - w.at) < 0.5)?.description ?? old?.description ?? "";
            const same = old && old.description === description && !job.redo;
            return { id: old?.id ?? newId(), at: w.at, shared: w.shared, description, imageId: same ? old.imageId ?? null : null, status: same ? old.status ?? "pending" : "pending", judge: same ? old.judge ?? null : null };
          });
        });
      });
      job.planned = true;
      this.changed();
    }
    // Fundos ideais dos planos, a partir do fundo original da cena.
    project = this.store.get(job.projectId);
    scene = findScene(project, job.sceneId);
    for (const b of scene.blocks) {
      if (job.cancelRequested) return;
      if (b.plate?.description && !this.plateFile(project, b)) await this.drawPlate(job, b.id, `Storyboard de "${scene.title}" · fundo do plano do bloco ${scene.blocks.indexOf(b) + 1}`);
      project = this.store.get(job.projectId);
    }
    // Imagens, na ordem do filme: cada quadro parte do anterior.
    project = this.store.get(job.projectId);
    scene = findScene(project, job.sceneId);
    const total = scene.blocks.reduce((n, b) => n + (b.frames ?? []).filter((f) => !f.shared).length, 0);
    let n = 0;
    for (let i = 0; i < scene.blocks.length; i++) {
      for (let j = 0; j < (scene.blocks[i].frames ?? []).length; j++) {
        if (job.cancelRequested) return;
        if (scene.blocks[i].frames[j].shared) continue;
        n++;
        job.progress = Math.round(((n - 1) / Math.max(1, total)) * 100);
        await this.drawFrame(job, scene.blocks[i].id, scene.blocks[i].frames[j].id, `Storyboard de "${scene.title}" · quadro ${n} de ${total}`);
        project = this.store.get(job.projectId);
        scene = findScene(project, job.sceneId);
      }
    }
    job.phase = `Storyboard de "${scene.title}" pronto`;
  }

  plateFile(project, block) {
    const file = block?.plate?.imageId ? project.previews.find((p) => p.id === block.plate.imageId)?.file : null;
    return file && fs.existsSync(file) ? file : null;
  }

  // Fundo ideal do plano: o lugar vazio deste ângulo, desenhado a partir do fundo original da cena.
  async drawPlate(job, blockId, label) {
    const project = this.store.get(job.projectId);
    const scene = findScene(project, job.sceneId);
    const index = scene.blocks.findIndex((b) => b.id === blockId);
    const block = scene.blocks[index];
    const bg = project.backgrounds.find((b) => b.id === scene.backgroundId)?.image;
    const request = {
      prompt: block.plate.description,
      ...imageSize(project.settings.aspectRatio, STORYBOARD_SHORT_SIDE),
      numImages: 1,
      ...(bg && fs.existsSync(bg) ? { imagePath: bg, strength: 0.6 } : {}),
    };
    const inflight = { type: "frame", plate: true, request, blockId, frameId: null, index, at: 0, sceneTitle: scene.title };
    const result = await this.withLtx(job, label, inflight, () => this.ltx.generateImage(request, { signal: job.abort.signal }));
    if (job.cancelRequested || result?.status !== "complete") return;
    if (!result.image_paths?.[0]) throw new Error("O LTX não devolveu o fundo do plano.");
    await this.finish(job, result.image_paths[0]);
  }

  // Imagem de referência do quadro: o quadro anterior (mesmo plano), o fundo do plano ou o fundo.
  frameReference(project, scene, index, frameIndex) {
    const board = storyboardFrames(project, scene, index);
    const prev = frameIndex > 0 ? board[frameIndex - 1] : index > 0 ? storyboardFrames(project, scene, index - 1).at(-1) : null;
    const block = scene.blocks[index];
    const plate = frameIndex === 0 ? this.plateFile(project, scene.blocks[shotStart(scene, index)]) : null;
    // 1º quadro de um plano: parte do fundo ideal do plano (e não do quadro de outro ângulo).
    if (plate && (index === 0 || block.continuity === "cut")) return { file: plate, strength: 0.75, prev: prev?.file ?? null };
    if (prev?.file) return { file: prev.file, strength: frameIndex === 0 && block.continuity === "cut" ? 0.85 : 0.6, prev: prev.file };
    if (index === 0 && scene.start?.kind === "previous") {
      const at = project.scenes.findIndex((x) => x.id === scene.id);
      const before = project.scenes[at - 1];
      const last = before?.blocks.length ? storyboardFrames(project, before, before.blocks.length - 1).at(-1)?.file : null;
      if (last) return { file: last, strength: 0.6, prev: last };
    }
    const bg = project.backgrounds.find((b) => b.id === scene.backgroundId)?.image;
    return bg && fs.existsSync(bg) ? { file: bg, strength: 0.75, prev: null } : { file: null, strength: 0, prev: null };
  }

  async drawFrame(job, blockId, frameId, label) {
    const signal = job.abort.signal;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (job.cancelRequested) return;
      const project = this.store.get(job.projectId);
      const scene = findScene(project, job.sceneId);
      const index = scene.blocks.findIndex((b) => b.id === blockId);
      const block = scene.blocks[index];
      const fi = block.frames.findIndex((f) => f.id === frameId);
      const frame = block.frames[fi];
      if (!frame) return;
      const current = storyboardFrames(project, scene, index)[fi];
      if (current.file && frame.status !== "pending") return; // já desenhado e conferido
      const ref = this.frameReference(project, scene, index, fi);
      let file = current.file && frame.status === "pending" && attempt === 1 ? current.file : null;
      if (!file) {
        const short = STORYBOARD_SHORT_SIDE;
        const request = {
          prompt: framePrompt(project, scene, block, frame),
          ...imageSize(project.settings.aspectRatio, short),
          numImages: 1,
          ...(ref.file ? { imagePath: ref.file, strength: ref.strength } : {}),
        };
        const inflight = { type: "frame", request, blockId, frameId, index, at: frame.at, sceneTitle: scene.title };
        const result = await this.withLtx(job, `${label} (${frame.at} s do bloco ${index + 1})${attempt > 1 ? `, tentativa ${attempt}` : ""}`, inflight, () => this.ltx.generateImage(request, { signal }));
        if (job.cancelRequested || result?.status !== "complete") return;
        if (!result.image_paths?.[0]) throw new Error("O LTX não devolveu a imagem do quadro.");
        file = await this.finish(job, result.image_paths[0]);
      }
      if (!this.reviewer?.checkFrame) return this.setFrame(job, blockId, frameId, { status: "approved" });
      job.phase = `${label}: a IA está conferindo o quadro`;
      this.changed();
      let v;
      try {
        const fresh = this.store.get(job.projectId);
        const sc = findScene(fresh, job.sceneId);
        const work = path.join(sceneFolder(fresh, sc), ".trabalho");
        await fsp.mkdir(work, { recursive: true });
        v = await this.reviewer.checkFrame({ project: fresh, scene: sc, index, frame: sc.blocks[index].frames[fi], file, prevFile: ref.prev, work, signal });
      } catch (error) {
        if (error.code === "ABORTED" || signal.aborted) return;
        (job.warnings ??= []).push(`Quadro ${frame.at} s do bloco ${index + 1}: a conferência falhou (${error.message}); ficou sem conferir.`);
        return this.setFrame(job, blockId, frameId, { status: "approved" });
      }
      this.learn(job, v.memory, `IA · storyboard de ${scene.title}, bloco ${index + 1}`);
      const judge = { pass: v.pass, problems: v.problems, reason: v.reason, model: v.model, at: new Date().toISOString(), attempt };
      (job.judged ??= []).push({ blockIndex: index, pass: v.pass, frame: frame.at });
      if (v.pass) return this.setFrame(job, blockId, frameId, { status: "approved", judge });
      if (attempt === 3) {
        (job.warnings ??= []).push(`Quadro ${frame.at} s do bloco ${index + 1}: reprovado 3 vezes (${v.reason}); ficou o último. Refaça na aba Storyboard se precisar.`);
        return this.setFrame(job, blockId, frameId, { status: "rejected", judge });
      }
      // Reprovado: a próxima imagem sai da descrição corrigida (e do prompt do bloco, se a IA mudou).
      this.setFrame(job, blockId, frameId, { status: "pending", judge, imageId: null, ...(v.description ? { description: v.description } : {}) }, v.prompt);
    }
  }

  setFrame(job, blockId, frameId, patch, prompt = null) {
    this.store.update(job.projectId, (p) => {
      const b = findScene(p, job.sceneId).blocks.find((x) => x.id === blockId);
      const f = b?.frames?.find((x) => x.id === frameId);
      if (!f) return;
      Object.assign(f, patch);
      if (prompt) b.prompt = prompt;
    });
    this.changed();
  }

  async finishFrame(job, inf, source) {
    const project = this.store.get(job.projectId);
    requireOutput(project);
    const dir = path.join(project.outputDir, "storyboard");
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slug(inf.sceneTitle, "cena")}-bloco-${pad(inf.index + 1)}-${inf.plate ? "fundo" : `${String(inf.at).replace(".", "_")}s`}-${stamp()}${path.extname(source) || ".png"}`);
    await fsp.copyFile(source, file);
    const preview = { id: newId(), sceneId: job.sceneId, backgroundId: null, kind: inf.plate ? "plate" : "frame", blockId: inf.blockId, frameId: inf.frameId, prompt: inf.request.prompt, file, createdAt: new Date().toISOString() };
    await fsp.writeFile(file.replace(/\.[^.]+$/, ".json"), JSON.stringify({ request: inf.request, createdAt: preview.createdAt }, null, 2));
    this.store.update(job.projectId, (p) => {
      p.previews.unshift(preview);
      const b = findScene(p, job.sceneId).blocks.find((x) => x.id === inf.blockId);
      if (inf.plate) {
        if (b?.plate) b.plate.imageId = preview.id;
        return;
      }
      const f = b?.frames?.find((x) => x.id === inf.frameId);
      if (f) Object.assign(f, { imageId: preview.id, status: "pending" });
    });
    return file;
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
