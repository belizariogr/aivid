// Biblioteca de projetos: um diretório por projeto com project.json e as imagens enviadas.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const RESOLUTIONS = ["360p", "540p", "720p", "1080p"];
export const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:2", "4:5", "21:9"];
export const FPS = [24, 25, 48, 50];
export const CONTINUITY = ["continue", "frame", "cut"];

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
  return { resolution: "720p", aspectRatio: "16:9", fps: 24, seed: null, audio: false, contextSeconds: 2 };
}

export function normalizeSettings(s = {}) {
  const d = defaultSettings();
  const seed = s.seed === null || s.seed === "" || s.seed === undefined ? null : Math.trunc(Number(s.seed));
  return {
    resolution: pick(s.resolution, RESOLUTIONS, d.resolution),
    aspectRatio: pick(s.aspectRatio, ASPECTS, d.aspectRatio),
    fps: pick(Number(s.fps), FPS, d.fps),
    seed: Number.isFinite(seed) && seed >= 0 ? seed % 2147483647 : null,
    audio: Boolean(s.audio),
    contextSeconds: Math.min(5, Math.max(1, Number(s.contextSeconds) || d.contextSeconds)),
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
    // A foto só muda pelos endpoints de imagem.
    photo: previous ? previous.photo : null,
  };
}

export function normalizeBlock(b = {}, previous) {
  const takes = previous?.takes ?? [];
  const selected = takes.some((t) => t.id === b.selectedTakeId) ? b.selectedTakeId : previous?.selectedTakeId ?? null;
  return {
    id: typeof b.id === "string" && b.id ? b.id : newId(),
    title: str(b.title, 200),
    prompt: str(b.prompt, 8000),
    duration: clampDuration(b.duration ?? 5),
    continuity: pick(b.continuity, CONTINUITY, "continue"),
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
    start: {
      kind: pick(start.kind, ["none", "background", "preview"], "none"),
      id: typeof start.id === "string" ? start.id : null,
    },
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
  };
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
        const p = JSON.parse(fs.readFileSync(path.join(this.dir, entry.name, "project.json"), "utf8"));
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

  create(name) {
    return this.save(newProject(name));
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
    for (const c of copy.characters) c.photo = moved(c.photo);
    for (const b of copy.backgrounds) b.image = moved(b.image);
    // Ids novos nas cenas e blocos: a fila identifica as tarefas por cena.
    for (const scene of copy.scenes) {
      scene.id = newId();
      scene.exports = [];
      if (scene.start?.kind === "preview") scene.start = { kind: "none", id: null };
      for (const block of scene.blocks) Object.assign(block, { id: newId(), takes: [], selectedTakeId: null });
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

// Um bloco fica "desatualizado" quando foi gerado a partir de outro take do bloco anterior.
export function blockState(scene, index) {
  const block = scene.blocks[index];
  const take = selectedTake(block);
  if (!take) return "empty";
  if (index > 0 && take.mode !== "cut" && take.mode !== "start") {
    const prev = selectedTake(scene.blocks[index - 1]);
    if (!prev || prev.id !== take.basedOn) return "stale";
    // Uma continuação de um bloco desatualizado também está desatualizada.
    if (blockState(scene, index - 1) === "stale") return "stale";
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
