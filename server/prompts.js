// Montagem dos prompts enviados ao LTX a partir do projeto, da cena e do bloco.

const clean = (s) => String(s || "").trim().replace(/\s+\n/g, "\n");
const sentence = (s) => {
  const t = clean(s);
  return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
};

export function sceneCharacters(project, scene, block) {
  const ids = block?.characterIds ?? scene?.characterIds ?? [];
  return ids.map((id) => project.characters.find((c) => c.id === id)).filter(Boolean);
}

export function describeCharacter(c) {
  const parts = [sentence(c.appearance), c.wardrobe && sentence(`Wearing ${clean(c.wardrobe)}`)].filter(Boolean).join(" ");
  return `${c.name}${c.role ? ` (${clean(c.role)})` : ""}${parts ? `: ${parts}` : ""}`;
}

function setting(project, scene) {
  const bg = project.backgrounds.find((b) => b.id === scene?.backgroundId);
  return bg?.description ? `Setting: ${sentence(bg.description)}` : "";
}

function cast(characters) {
  return characters.length ? `Characters: ${characters.map(describeCharacter).join(" ")}` : "";
}

const MODE_HINT = {
  continue:
    "Continue the shot seamlessly from the previous footage: same characters, setting, lighting, lens and camera style, with no cut or jump.",
  frame:
    "The attached image is the last frame of the previous shot and the opening frame of this one. Continue the action from it, preserving setting, layout, lighting and character appearance.",
  image:
    "Use the attached image as the opening frame. Preserve its setting, layout, lighting and character appearance while animating the action.",
};

export function videoPrompt(project, scene, block, { mode, hasImage = false }) {
  const hint = mode === "continue" ? MODE_HINT.continue : mode === "frame" ? MODE_HINT.frame : hasImage ? MODE_HINT.image : "";
  return [clean(project.prePrompt), setting(project, scene), cast(sceneCharacters(project, scene, block)), clean(block.prompt), hint]
    .filter(Boolean)
    .join("\n\n");
}

export function previewPrompt(project, scene, extra, { withCharacters = true } = {}) {
  const body = clean(extra) || clean(scene?.blocks?.[0]?.prompt) || clean(scene?.synopsis);
  return [
    clean(project.prePrompt),
    setting(project, scene),
    withCharacters ? cast(sceneCharacters(project, scene, null)) : "Empty environment with no people.",
    body,
    "Single still frame, cinematic composition.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function avatarPrompt(project, character, extra) {
  return [
    clean(project.prePrompt),
    `Character portrait of ${describeCharacter(character)}`,
    clean(extra),
    "Head and shoulders, facing the camera, neutral background, even soft lighting, sharp focus on the face.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Dimensões para o Z-Image respeitando a proporção do projeto (múltiplos de 64).
export function imageSize(aspectRatio, short = 768) {
  const [w, h] = aspectRatio.split(":").map(Number);
  const ratio = w / h;
  const snap = (v) => Math.max(256, Math.round(v / 64) * 64);
  return ratio >= 1 ? { width: snap(short * ratio), height: snap(short) } : { width: snap(short), height: snap(short / ratio) };
}
