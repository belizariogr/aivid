// Biblioteca de projetos: um diretório por projeto com project.json e as imagens enviadas.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const RESOLUTIONS = ["360p", "540p", "720p", "1080p"];
export const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:2", "4:5", "21:9"];
export const FPS = [24, 25, 48, 50];
export const CONTINUITY = ["continue", "frame", "cut"];
// De onde sai a imagem inicial de um bloco de corte. "scene" usa a imagem inicial da cena;
// "block" usa o último quadro de um bloco anterior da mesma cena (id do bloco); "keyframe" gera a
// imagem com o Z-Image a partir de uma referência (`ref`), e `id` guarda a prévia gerada.
export const CUT_START = ["scene", "none", "block", "background", "preview", "keyframe"];
// Imagem inicial do 1º bloco da cena. "previous" é o último quadro da cena anterior.
export const SCENE_START = ["none", "background", "preview", "previous", "keyframe"];
export const MAX_RETAKES = 3;
// Referências de uma abertura gerada (o Z-Image parte dessa imagem).
const REF_KINDS = ["scene", "none", "block", "background", "preview", "previous"];

export const newId = () => randomUUID();
const now = () => new Date().toISOString();
const str = (v, max = 20000) => (typeof v === "string" ? v.slice(0, max) : "");
const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);
const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string"))] : []);

export function clampDuration(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 5;
  return Math.min(20, Math.max(2, n));
}

export function defaultSettings() {
  return { resolution: "720p", draftResolution: "360p", aspectRatio: "16:9", fps: 24, seed: null, audio: false, contextSeconds: 2, review: false, judge: false, retakes: 2, learn: true };
}

export function normalizeSettings(s = {}) {
  const d = defaultSettings();
  const seed = s.seed === null || s.seed === "" || s.seed === undefined ? null : Math.trunc(Number(s.seed));
  return {
    resolution: pick(s.resolution, RESOLUTIONS, d.resolution),
    // Resolução do rascunho: baixa, para acertar prompts e aberturas antes da versão final.
    draftResolution: pick(s.draftResolution, RESOLUTIONS, d.draftResolution),
    aspectRatio: pick(s.aspectRatio, ASPECTS, d.aspectRatio),
    fps: pick(Number(s.fps), FPS, d.fps),
    seed: Number.isFinite(seed) && seed >= 0 ? seed % 2147483647 : null,
    audio: Boolean(s.audio),
    contextSeconds: Math.min(5, Math.max(1, Number(s.contextSeconds) || d.contextSeconds)),
    // Revisão de continuidade com IA antes de cada bloco (usa o modelo da revisão escolhido em Configurações).
    review: Boolean(s.review),
    // Juiz depois de cada bloco: reprovado, gera outro take até `retakes` vezes e fica com o melhor.
    judge: Boolean(s.judge),
    retakes: Math.min(MAX_RETAKES, Math.max(0, Math.round(Number(s.retakes ?? d.retakes)) || 0)),
    // A revisão e o ajuste antes do retake podem anotar aprendizados que valem para todo o projeto.
    learn: s.learn === undefined ? d.learn : Boolean(s.learn),
  };
}

export function normalizeCharacter(c = {}, previous) {
  return {
    id: typeof c.id === "string" && c.id ? c.id : newId(),
    name: str(c.name, 120).trim() || "Personagem",
    role: str(c.role, 200),
    appearance: str(c.appearance, 4000),
    wardrobe: str(c.wardrobe, 2000),
    personality: str(c.personality, 4000),
    voice: str(c.voice, 1000),
    notes: str(c.notes, 4000),
    // A foto e as fichas de referência só mudam pelos endpoints de imagem.
    photo: previous ? previous.photo : null,
    refs: previous?.refs ?? [],
  };
}

export function normalizeCutStart(start, kinds = CUT_START) {
  const kind = pick(start?.kind, kinds, kinds[0]);
  const id = typeof start?.id === "string" && start.id ? start.id : null;
  if (kind === "keyframe") {
    const ref = start?.ref?.kind === "keyframe" ? null : start?.ref;
    return { kind, id, ref: normalizeCutStart(ref, REF_KINDS) };
  }
  if (["scene", "none", "previous"].includes(kind)) return { kind, id: null };
  return id ? { kind, id } : { kind: kinds[0], id: null };
}

// A imagem de abertura gerada é do servidor: continua valendo enquanto a referência (e a descrição)
// não mudam, e só o servidor a descarta para gerar outra.
function keepKeyframe(start, old, sameOpening = true) {
  if (start.kind !== "keyframe") return start;
  const keep = old?.kind === "keyframe" && JSON.stringify(old.ref) === JSON.stringify(start.ref) && sameOpening;
  return { ...start, id: keep ? old.id ?? null : null };
}

export function normalizeBlock(b = {}, previous) {
  const takes = previous?.takes ?? [];
  const selected = takes.some((t) => t.id === b.selectedTakeId) ? b.selectedTakeId : previous?.selectedTakeId ?? null;
  // A revisão de continuidade é do servidor. Uma edição feita antes de a interface ver a revisão
  // não desfaz o que ela mudou no bloco.
  const review = previous?.review ?? null;
  const plan = review && b.review?.at !== review.at ? previous : b;
  return {
    id: typeof b.id === "string" && b.id ? b.id : newId(),
    title: str(b.title, 200),
    prompt: str(plan.prompt, 8000),
    duration: clampDuration(b.duration ?? 5),
    continuity: pick(plan.continuity, CONTINUITY, "continue"),
    start: keepKeyframe(normalizeCutStart(plan.start), previous?.start, str(plan.opening, 4000) === (previous?.opening ?? "")),
    note: str(plan.note, 2000),
    // Estado do lugar e dos objetos que difere do fundo (em inglês); entra no prompt. Não é o
    // `state` que a interface recebe (Pronto, Não gerado…), calculado em blockState.
    currentState: str(plan.currentState, 2000),
    // Descrição do quadro de abertura, usada quando a abertura é gerada pelo Z-Image.
    opening: str(plan.opening, 4000),
    review,
    characterIds: b.characterIds == null ? null : ids(b.characterIds),
    takes,
    selectedTakeId: selected,
  };
}

export function normalizeScene(s = {}, previous) {
  const oldBlocks = new Map((previous?.blocks ?? []).map((b) => [b.id, b]));
  const start = s.start && typeof s.start === "object" ? s.start : {};
  return {
    id: typeof s.id === "string" && s.id ? s.id : newId(),
    title: str(s.title, 200).trim() || "Cena sem título",
    synopsis: str(s.synopsis, 8000),
    characterIds: ids(s.characterIds),
    backgroundId: typeof s.backgroundId === "string" ? s.backgroundId : null,
    start: keepKeyframe(normalizeCutStart(start, SCENE_START), previous?.start),
    blocks: (Array.isArray(s.blocks) ? s.blocks : []).map((b) => normalizeBlock(b, oldBlocks.get(b?.id))),
    exports: previous?.exports ?? [],
  };
}

export function newProject(name) {
  const t = now();
  return {
    version: 1,
    id: newId(),
    name: str(name, 200).trim() || "Novo projeto",
    createdAt: t,
    updatedAt: t,
    prePrompt: "",
    negativePrompt: "",
    outputDir: "",
    settings: defaultSettings(),
    characters: [],
    backgrounds: [],
    previews: [],
    scenes: [],
    memory: [],
  };
}

// Aprendizados do projeto: notas curtas (em inglês) que entram em todo prompt de vídeo e imagem.
export const MAX_NOTES = 15;
export function normalizeMemory(list, previous = []) {
  const old = new Map(previous.map((n) => [n.id, n]));
  return (Array.isArray(list) ? list : [])
    .map((n) => {
      const text = str(typeof n === "string" ? n : n?.text, 400).trim();
      if (!text) return null;
      const before = old.get(n?.id);
      return { id: before?.id ?? (typeof n?.id === "string" && n.id ? n.id : newId()), text, at: before?.at ?? n?.at ?? now(), by: str(before?.by ?? n?.by ?? "você", 200) };
    })
    .filter(Boolean)
    .slice(0, MAX_NOTES);
}

// Aplica uma edição vinda da interface sem perder o que só o servidor controla
// (fotos, imagens de fundo, prévias e takes gerados).
export function mergeEdit(project, input) {
  const next = structuredClone(project);
  if ("name" in input) next.name = str(input.name, 200).trim() || project.name;
  if ("prePrompt" in input) next.prePrompt = str(input.prePrompt, 8000);
  if ("negativePrompt" in input) next.negativePrompt = str(input.negativePrompt, 2000);
  if ("outputDir" in input) next.outputDir = str(input.outputDir, 4000);
  if ("settings" in input) next.settings = normalizeSettings({ ...project.settings, ...input.settings });
  if (Array.isArray(input.memory)) next.memory = normalizeMemory(input.memory, project.memory ?? []);
  if (Array.isArray(input.characters)) {
    const old = new Map(project.characters.map((c) => [c.id, c]));
    next.characters = input.characters.map((c) => normalizeCharacter(c, old.get(c?.id)));
  }
  if (Array.isArray(input.backgrounds)) {
    const old = new Map(project.backgrounds.map((b) => [b.id, b]));
    next.backgrounds = input.backgrounds
      .filter((b) => old.has(b?.id))
      .map((b) => ({ ...old.get(b.id), name: str(b.name, 200).trim() || old.get(b.id).name, description: str(b.description, 4000) }));
  }
  if (Array.isArray(input.scenes)) {
    const old = new Map(project.scenes.map((s) => [s.id, s]));
    next.scenes = input.scenes.map((s) => normalizeScene(s, old.get(s?.id)));
  }
  next.updatedAt = now();
  return next;
}

const BLOCK_STATUS = new Set(["empty", "ready", "stale", "missing"]);

// Projetos salvos antes de `currentState` guardavam o estado do bloco em `state`, que a interface
// sobrescrevia com o status do bloco. Mantém o texto que ainda for estado e descarta o status.
export function migrateProject(project) {
  for (const scene of project.scenes ?? [])
    for (const block of scene.blocks ?? []) {
      if (!("state" in block)) continue;
      if (block.currentState === undefined && typeof block.state === "string" && !BLOCK_STATUS.has(block.state)) block.currentState = block.state;
      delete block.state;
    }
  return project;
}

export class Store {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, "projects");
    this.trash = path.join(root, "trash");
    fs.mkdirSync(this.dir, { recursive: true });
    this.projects = new Map();
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const p = migrateProject(JSON.parse(fs.readFileSync(path.join(this.dir, entry.name, "project.json"), "utf8")));
        this.projects.set(p.id, p);
      } catch {
        /* pasta incompleta; ignora */
      }
    }
  }

  list() {
    return [...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    const p = this.projects.get(id);
    if (!p) throw Object.assign(new Error("Projeto não encontrado."), { status: 404 });
    return p;
  }

  projectDir(id) {
    return path.join(this.dir, id);
  }

  assetsDir(id, kind) {
    const dir = path.join(this.projectDir(id), "assets", kind);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  save(project) {
    const dir = this.projectDir(project.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "project.json");
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(project, null, 2));
    fs.renameSync(tmp, file);
    this.projects.set(project.id, project);
    return project;
  }

  create(name, settings = null) {
    const project = newProject(name);
    if (settings) project.settings = normalizeSettings(settings);
    return this.save(project);
  }

  // Altera o projeto mais recente em memória (evita sobrescrever o trabalho do gerador).
  update(id, fn) {
    const current = structuredClone(this.get(id));
    const result = fn(current) ?? current;
    result.updatedAt = now();
    return this.save(result);
  }

  edit(id, input) {
    return this.save(mergeEdit(this.get(id), input));
  }

  // Copia personagens (com fotos), fundos, configurações e cenas. Os vídeos ficam com o original:
  // a cópia começa sem takes, sem prévias e sem pasta de saída, para não misturar os arquivos.
  clone(id, name) {
    const source = this.get(id);
    const copy = structuredClone(source);
    const t = now();
    Object.assign(copy, { id: newId(), name: str(name, 200).trim() || `${source.name} (cópia)`, createdAt: t, updatedAt: t, outputDir: "", previews: [] });
    const from = path.join(this.projectDir(id), "assets");
    const to = path.join(this.projectDir(copy.id), "assets");
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
    const moved = (file) => (typeof file === "string" && file.startsWith(from + path.sep) ? path.join(to, path.relative(from, file)) : file);
    for (const c of copy.characters) {
      c.photo = moved(c.photo);
      c.refs = (c.refs ?? []).map((r) => ({ ...r, file: moved(r.file) }));
    }
    for (const b of copy.backgrounds) b.image = moved(b.image);
    // Ids novos nas cenas e blocos: a fila identifica as tarefas por cena.
    for (const scene of copy.scenes) {
      scene.id = newId();
      scene.exports = [];
      if (scene.start?.kind === "preview") scene.start = { kind: "none", id: null };
      if (scene.start?.kind === "keyframe") scene.start = { ...scene.start, id: null };
      const ids = new Map(scene.blocks.map((b) => [b.id, newId()]));
      for (const block of scene.blocks) {
        Object.assign(block, { id: ids.get(block.id), takes: [], selectedTakeId: null, review: null });
        if (block.start?.kind === "block") block.start = { kind: "block", id: ids.get(block.start.id) ?? null };
        if (block.start?.kind === "keyframe") block.start = { ...block.start, id: null, ref: block.start.ref?.kind === "block" ? { kind: "block", id: ids.get(block.start.ref.id) ?? null } : block.start.ref };
        if (block.start?.kind === "keyframe" && ["preview"].includes(block.start.ref?.kind)) block.start.ref = { kind: "scene", id: null };
        if (block.start?.kind === "preview" || (block.start?.kind === "block" && !block.start.id)) block.start = { kind: "scene", id: null };
      }
    }
    return this.save(copy);
  }

  remove(id) {
    this.get(id);
    fs.mkdirSync(this.trash, { recursive: true });
    fs.renameSync(this.projectDir(id), path.join(this.trash, `${id}-${Date.now()}`));
    this.projects.delete(id);
  }
}

export function findScene(project, sceneId) {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw Object.assign(new Error("Cena não encontrada."), { status: 404 });
  return scene;
}

export function selectedTake(block) {
  return block?.takes.find((t) => t.id === block.selectedTakeId) ?? null;
}

// Bloco de onde o take foi gerado: o anterior (continuação ou último quadro), o bloco cujo último
// quadro abriu um corte, ou o último bloco da cena anterior. Devolve { scene, index } ou null.
function sourceOf(project, scene, index, take) {
  if (take.mode === "continue" || take.mode === "frame") return { scene, index: index - 1 };
  if (!take.basedOnBlock) return null;
  const owner = take.basedOnScene && project ? project.scenes.find((s) => s.id === take.basedOnScene) : scene;
  return { scene: owner ?? null, index: owner ? owner.blocks.findIndex((b) => b.id === take.basedOnBlock) : -1 };
}

// Um bloco fica "desatualizado" quando foi gerado a partir de outro take do bloco de origem.
// `project` permite seguir a origem até a cena anterior.
export function blockState(scene, index, project = null, seen = new Set()) {
  const block = scene.blocks[index];
  const take = selectedTake(block);
  if (!take) return "empty";
  const from = sourceOf(project, scene, index, take);
  if (from) {
    const sameScene = from.scene === scene;
    if (!from.scene || from.index < 0 || (sameScene && from.index >= index)) return "stale";
    const source = selectedTake(from.scene.blocks[from.index]);
    if (!source || source.id !== take.basedOn) return "stale";
    // Um bloco gerado de um bloco desatualizado também está desatualizado.
    const key = `${from.scene.id ?? ""}:${from.index}`;
    if (!seen.has(key) && blockState(from.scene, from.index, project, new Set(seen).add(`${scene.id ?? ""}:${index}`)) === "stale") return "stale";
  }
  if (!fs.existsSync(take.file)) return "missing";
  return "ready";
}

export function slug(text, fallback = "item") {
  const s = String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || fallback;
}
