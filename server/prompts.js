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

// Fundo que vale para o bloco. Um corte que abre de outro fundo (por exemplo, o mesmo lugar com o
// portão aberto) troca a descrição dali em diante, até um corte voltar à imagem da cena.
export function blockBackground(project, scene, block) {
  const find = (id) => project.backgrounds.find((b) => b.id === id) ?? null;
  const blocks = scene?.blocks ?? [];
  let i = block ? blocks.findIndex((b) => b.id === block.id) : -1;
  const seen = new Set();
  while (i > 0 && !seen.has(i)) {
    seen.add(i);
    const b = blocks[i];
    if (b.continuity === "cut") {
      const own = b.start ?? { kind: "scene" };
      // Uma abertura gerada herda o fundo da sua referência.
      const start = own.kind === "keyframe" ? own.ref ?? { kind: "scene" } : own;
      if (start.kind === "background" && find(start.id)) return find(start.id);
      if (start.kind === "scene") break;
      if (start.kind === "block") {
        const from = blocks.findIndex((x) => x.id === start.id);
        if (from < 0 || from >= i) break;
        i = from;
        continue;
      }
    }
    i--;
  }
  return find(scene?.backgroundId);
}

function setting(project, scene, block = null) {
  const bg = blockBackground(project, scene, block);
  return bg?.description ? `Setting: ${sentence(bg.description)}` : "";
}

// Aprendizados do projeto (escritos pela IA ou por você), logo depois do pré-prompt.
function notes(project) {
  const list = (project.memory ?? []).map((n) => sentence(n.text)).filter(Boolean);
  return list.length ? `Project notes: ${list.join(" ")}` : "";
}

function current(block) {
  return clean(block?.currentState) ? `Current state: ${sentence(block.currentState)}` : "";
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
  storyboard:
    "The attached keyframes are frames of this shot at fixed times. Move smoothly and naturally from one to the next, keeping the characters, the place, the state and the lighting exactly as they appear in them.",
};

export function videoPrompt(project, scene, block, { mode, hasImage = false }) {
  const hint = mode === "storyboard" ? MODE_HINT.storyboard : mode === "continue" ? MODE_HINT.continue : mode === "frame" ? MODE_HINT.frame : hasImage ? MODE_HINT.image : "";
  return [clean(project.prePrompt), notes(project), setting(project, scene, block), current(block), cast(sceneCharacters(project, scene, block)), clean(block.prompt), hint]
    .filter(Boolean)
    .join("\n\n");
}

// Quadro de abertura gerado pelo Z-Image para um corte (ou para o 1º bloco da cena).
export function keyframePrompt(project, scene, block) {
  const opening = clean(block.opening) || clean(block.prompt);
  return [
    clean(project.prePrompt),
    notes(project),
    setting(project, scene, block),
    current(block),
    cast(sceneCharacters(project, scene, block)),
    opening,
    "Single still frame: the opening frame of this shot, cinematic composition, sharp, no motion blur.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Quadro do storyboard: a descrição escrita pela IA já é o prompt completo e curto da imagem.
// O Z-Image se perde com prompts longos (personagens duplicados, colagens com glitch), então
// nada do pré-prompt, do cenário ou do elenco é empilhado aqui: a IA já trouxe o essencial.
export function framePrompt(project, scene, block, frame) {
  return clean(frame.description);
}

// Imagens do storyboard na resolução nativa do Z-Image Turbo (~1 megapixel, 1344×768 em 16:9).
// Acima disso ele repete e cola pedaços da imagem (glitch, personagens duplicados); 768 px de
// lado menor já cobre o vídeo em 720p, e o LTX ajusta o tamanho dos keyframes.
export const STORYBOARD_SHORT_SIDE = 768;

export function previewPrompt(project, scene, extra, { withCharacters = true } = {}) {
  const body = clean(extra) || clean(scene?.blocks?.[0]?.prompt) || clean(scene?.synopsis);
  return [
    clean(project.prePrompt),
    notes(project),
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

// Fichas de referência de um personagem: o mesmo rosto e figurino em três vistas.
export const REFERENCE_VIEWS = {
  front: { label: "Frente", text: "Front view, head and shoulders, facing the camera, neutral expression." },
  profile: { label: "Perfil", text: "Side profile view, head and shoulders, looking to the left." },
  body: { label: "Corpo inteiro", text: "Full body view, standing, facing the camera, the whole outfit visible from head to feet." },
};

export function referencePrompt(project, character, view) {
  return [
    clean(project.prePrompt),
    notes(project),
    `Character reference sheet of ${describeCharacter(character)}`,
    REFERENCE_VIEWS[view].text,
    "Plain light gray background, even soft studio lighting, sharp focus, the same face, hair and outfit as the reference.",
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
