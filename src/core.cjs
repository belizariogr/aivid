const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20];
const defaults = () => ({
  resolution: "720p",
  duration: 10,
  fps: 24,
  aspectRatio: "16:9",
  seed: 42,
  chain: false,
  merge: false,
  modelId: "ltx-2.3-22b-distilled-1.1",
});
function normalizeProject(input, existing) {
  if (!input || typeof input.name !== "string" || !input.name.trim())
    throw new Error("Dê um nome ao projeto.");
  const settings = { ...defaults(), ...input.settings };
  if (
    !["540p", "720p", "1080p"].includes(settings.resolution) ||
    !DURATIONS.includes(Number(settings.duration)) ||
    ![24, 25].includes(Number(settings.fps)) ||
    !["16:9", "9:16", "1:1"].includes(settings.aspectRatio)
  )
    throw new Error("Configurações de vídeo inválidas.");
  if (
    !Number.isInteger(Number(settings.seed)) ||
    Number(settings.seed) < 0 ||
    Number(settings.seed) > 2147483647
  )
    throw new Error("A semente deve ser um número entre 0 e 2147483647.");
  for (const k of ["duration", "fps", "seed"])
    settings[k] = Number(settings[k]);
  settings.chain = Boolean(settings.chain);
  settings.merge = Boolean(settings.merge);
  const allowedModels = [
    "ltx-2.3-22b-distilled-1.1",
    "ltx-2.3-22b-distilled",
    "ltx-2.5-22b-distilled",
  ];
  if (!allowedModels.includes(settings.modelId))
    throw new Error("Modelo inválido.");
  const previous = new Map((existing?.scenes || []).map((s) => [s.id, s]));
  const raw = Array.isArray(input.scenes)
    ? input.scenes
    : existing?.scenes || [];
  if (raw.length > 60) throw new Error("Use no máximo 60 cenas por projeto.");
  const scenes = raw.map((scene, index) => {
    const old = previous.get(scene.id);
    const duration = Number(scene.duration || settings.duration);
    if (!DURATIONS.includes(duration))
      throw new Error("Duração de cena inválida.");
    return {
      id: old?.id || randomUUID(),
      name: String(scene.name || `Cena ${index + 1}`).slice(0, 100),
      prompt: String(scene.prompt || "").slice(0, 10000),
      duration,
      reference: String(scene.reference || "").slice(0, 100),
      characterIds: Array.isArray(scene.characterIds)
        ? scene.characterIds.filter((id) =>
            (existing?.characters || []).some((c) => c.id === id),
          )
        : (existing?.characters || []).map((c) => c.id),
      image: old?.image || null,
    };
  });
  return {
    scenes,
    id: existing?.id || randomUUID(),
    name: input.name.trim().slice(0, 100),
    description: String(input.description || "").slice(0, 10000),
    prompt: String(input.prompt || "").slice(0, 50000),
    outputDir: existing?.outputDir || "",
    characters: existing?.characters || [],
    sceneImage: existing?.sceneImage || null,
    settings,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function splitScenes(prompt) {
  if (typeof prompt !== "string" || !prompt.trim())
    throw new Error("Escreva o que acontece no vídeo.");
  const scenes = prompt
    .split(/^\s*---\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
  if (scenes.length > 60)
    throw new Error("Use no máximo 60 cenas por geração.");
  if (scenes.some((s) => s.length > 10000))
    throw new Error("Cada cena pode ter até 10 mil caracteres.");
  return scenes;
}
function buildPrompt(project, scene, characterIds) {
  const cast = project.characters
    .filter((c) => !characterIds || characterIds.includes(c.id))
    .map(
      (c) =>
        `${c.name}: ${c.description || "personagem da imagem de referência"}`,
    )
    .join("\n");
  return [
    project.description && `Context and continuity:\n${project.description}`,
    cast &&
      `Recurring characters (preserve their appearance and clothing):\n${cast}`,
    `Scene action:\n${scene}`,
    "No on-screen text, no subtitles, no speech, no narration.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
class Store {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, "library.json");
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    this.data = { projects: [], jobs: [] };
    if (fs.existsSync(this.file))
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    for (const j of this.data.jobs)
      if (["queued", "running"].includes(j.status)) {
        j.status = "interrupted";
        j.error =
          "O app foi fechado durante esta geração. Gere novamente para continuar.";
      }
    this.save();
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  project(id) {
    const p = this.data.projects.find((p) => p.id === id);
    if (!p) throw new Error("Projeto não encontrado.");
    return p;
  }
  upsert(input) {
    let old = input.id ? this.project(input.id) : undefined;
    const p = normalizeProject(input, old);
    if (old) this.data.projects[this.data.projects.indexOf(old)] = p;
    else this.data.projects.unshift(p);
    this.save();
    return p;
  }
  asset(projectId, source) {
    this.project(projectId);
    const ext = path.extname(source).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext))
      throw new Error("Use imagens PNG, JPG ou WebP.");
    if (fs.statSync(source).size > 30 * 1024 * 1024)
      throw new Error("Use uma imagem com até 30 MB.");
    const dir = path.join(this.root, "assets", projectId);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, randomUUID() + ext);
    fs.copyFileSync(source, dest);
    return dest;
  }
  assetData(filename) {
    if (!filename) return null;
    const resolved = fs.realpathSync(filename);
    const base = fs.realpathSync(path.join(this.root, "assets")) + path.sep;
    if (!resolved.startsWith(base))
      throw new Error("Imagem fora da biblioteca.");
    const ext = path.extname(resolved);
    return `data:${ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"};base64,${fs.readFileSync(resolved).toString("base64")}`;
  }
  view() {
    return {
      projects: this.data.projects.map((p) => ({
        ...p,
        characters: p.characters.map((c) => ({
          ...c,
          preview: this.assetData(c.image),
        })),
        scenePreview: this.assetData(p.sceneImage),
      })),
      jobs: this.data.jobs,
    };
  }
}
module.exports = {
  Store,
  defaults,
  normalizeProject,
  splitScenes,
  buildPrompt,
};
