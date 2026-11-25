// Pedido do roteiro automático à LLM (com o projeto e as regras de continuidade) e importação do roteiro.
import { normalizeScene, newId, CONTINUITY } from "./store.js";

export const BRIEF_FORMAT = "takes.llm-brief";
export const SCRIPT_FORMAT = "takes.scene-script";

export const CONTINUITY_RULES = `How Takes chains blocks (continuity errors are the most common failure, so read this carefully):
- LTX has no memory between blocks. For each block it only receives the text prompt and ONE opening image (or, for "continue", the last seconds of the previous block). Anything that changed earlier (a door or gate opened, an object moved, picked up, tied or removed, wet clothes, lights turned on) is forgotten unless that opening image shows it or the text says it.
- "continuity" of each block after the first:
  - "continue": LTX receives the last seconds of the previous block and keeps the motion going. The block starts in exactly the framing the previous block ENDS with. Best continuity; use it whenever the camera keeps rolling.
  - "frame": the last frame of the previous block becomes the opening image. It also starts in the framing the previous block ends with. Use it for a calmer change of action in the same shot.
  - "cut": a new shot. Choose its opening image with "start" (required on every "cut" block after the first):
    - "keyframe": Takes generates the opening image with an image model before rendering, from the block's "opening" (required: an English description of the first frame of the new shot: framing, who is where, the visible state) and a "reference" image it starts from ("scene", "block:N", "background:<id>" or "none"; default "scene"). Character descriptions, the setting and the "state" are added to it automatically. This is the best choice for a new angle or framing that shows the current state when no rendered frame matches it.
    - "block:N": the last frame of block N of this same scene (N is the 1-based number of an earlier block). It carries the current state and starts in the framing block N ends with, so write the prompt from that framing. Best for cutting back to a framing an earlier block ended on.
    - "scene": the scene's opening image. With a background it shows the place in its ORIGINAL state, as in the background description. Use it only when nothing visible in that view has changed since the scene began.
    - "background:<id>": another background of the project, for example a variant of the same place that already shows the changed state. Its description replaces the scene background description from this block on.
    - "none": no image, text only. Characters and the place drift the most; prefer "keyframe".
- The end framing of a block carries over. If block N ends in a close-up or after a zoom in, "continue" and "frame" in block N+1 start in that close-up. To return to a wide view, either describe the camera pulling back, or "cut" with a "start" whose image is wide and shows the current state ("block:M" of an earlier block that ended wide, or "keyframe").
- "state": for EVERY block where the place or an object differs from the background description, write the current state in English ("The gate stands wide open. An empty gap where the yellow ribbon used to hang."), also in "continue" and "frame" blocks and in later scenes in the same place. Takes adds it to the prompt and to generated opening images. Use "" when nothing differs.
- State carries across scenes: a scene that returns to a place keeps what changed there earlier. Scene "start" chooses how block 1 opens: "background" (the background image, ORIGINAL state), "previous" (the last frame of the previous scene; use it when the scene picks up exactly where the previous one ended, same place and continuous time), "keyframe" (generated from block 1's "opening" and the scene "reference": "background", "previous", "background:<id>" or "none") or "none" (text only).
- "note": a short note for the human editor, in the language of the script, about the continuity of the block: why this "continuity" and "start" were chosen, which changed state must hold, and anything to check by hand. Use "" when there is nothing to say.
- Pacing: blocks are at least 3 seconds; most should be 5 to 10 seconds. Every block costs a full render, and a string of very short cuts looks choppy; merge short beats into one block with camera movement instead.
- Dialogue must fit its block: about 2.5 spoken words per second at most (a 6-second block holds about 15 words). Split long lines across blocks.
- Before answering, review the blocks in order: track the framing each block ends with and the state of every object that changed. Make sure every "continue" or "frame" block starts in the framing the previous one ends with, every "cut" has a "start" whose image matches the new shot and the current state, and every block where the state differs has it in "state".`;

export function buildBrief(project) {
  return {
    format: BRIEF_FORMAT,
    version: 1,
    generatedAt: new Date().toISOString(),
    limits: { minBlockSeconds: 3, maxBlockSeconds: 20, wordsPerSecond: 2.5, continuity: CONTINUITY, cutStart: ["keyframe", "block:N", "scene", "background:<id>", "none"], sceneStart: ["background", "previous", "keyframe", "none"] },
    project: {
      name: project.name,
      prePrompt: project.prePrompt,
      video: { aspectRatio: project.settings.aspectRatio, fps: project.settings.fps, audio: project.settings.audio },
      characters: project.characters.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        appearance: c.appearance,
        wardrobe: c.wardrobe,
        personality: c.personality,
        voice: c.voice,
        notes: c.notes,
      })),
      backgrounds: project.backgrounds.map((b) => ({ id: b.id, name: b.name, description: b.description })),
      existingScenes: project.scenes.map((s, i) => ({
        number: i + 1,
        title: s.title,
        synopsis: s.synopsis,
        seconds: s.blocks.reduce((t, b) => t + b.duration, 0),
        lastBlockPrompt: s.blocks.at(-1)?.prompt ?? "",
      })),
    },
    responseFormat: {
      description: "Return exactly this structure. Every block needs duration and prompt.",
      example: {
        format: SCRIPT_FORMAT,
        version: 1,
        scene: {
          title: "Short scene title",
          synopsis: "One or two sentences about what happens in the scene.",
          backgroundId: project.backgrounds[0]?.id ?? null,
          start: "background",
          characterIds: project.characters.slice(0, 2).map((c) => c.id),
          blocks: [
            { duration: 8, continuity: "cut", characterIds: project.characters.slice(0, 1).map((c) => c.id), state: "", prompt: "English paragraph describing the opening shot, ending in a wide shot as something in the place changes.", note: "" },
            { duration: 6, continuity: "continue", state: "English sentence with the changed state.", prompt: "English paragraph continuing the same shot, ending in a close-up after the camera pushes in.", note: "Note in the script language about what changed and what to check." },
            { duration: 5, continuity: "cut", start: "block:1", state: "English sentence with the changed state.", prompt: "English paragraph for a new shot that opens on the wide framing block 1 ended with.", note: "Why this start was chosen." },
            { duration: 7, continuity: "cut", start: "keyframe", reference: "block:1", opening: "English description of the first frame of a new angle: framing, who is where, the visible state.", state: "English sentence with the changed state.", prompt: "English paragraph for the new angle.", note: "" },
          ],
        },
      },
    },
  };
}

const FULL_SCRIPT_INSTRUCTIONS = `You are a screenwriter and prompt writer for LTX, a local text/image-to-video model.
The user gives you the complete script of a video (a screenplay, a story or an outline, in any language). Turn ALL of it into scenes for the video project described in "project", in the order of the script, and split every scene into consecutive blocks.

Hard rules:
1. A scene is one continuous stretch of action in one place and time. Start a new scene when the script changes place or jumps in time. Cover the whole script: do not skip events and do not add major events that are not in it.
2. Each block is at most 20 seconds and at least 3 seconds ("duration", integer seconds). LTX cannot render longer clips, so long actions must be split across several blocks.
3. Blocks of a scene play back to back and must feel continuous. Block 1 of each scene opens as chosen by the scene "start": the background image shows the place in its ORIGINAL state, so when the state already differs at the start of the scene (for example a gate opened in an earlier scene) use "previous" or "keyframe". For each later block choose "continuity" ("continue", "frame" or "cut") and, for a "cut", its "start", following the continuity rules below. Prefer "continue" and "frame" while the action stays in the same shot; cut only when the shot really changes.
4. "prompt" is what LTX will render for that block, written in English as one paragraph of 3 to 7 sentences, present tense, in chronological order: who is in frame, what they do, how they move, the camera (framing, lens, movement), the lighting and the mood. Describe only what is visible or audible during that block. No lists, no markdown, no scene numbers, no "Block 2" references.
5. Dialogue: when "project.video.audio" is true, put the spoken lines in the prompt of the block where they are said, in quotes, with who says them and how (keep the script's language for the line itself). When audio is false, show the conversation visually instead of quoting it.
6. The project pre-prompt (style, look, rules) is added automatically before every prompt, and the appearance and wardrobe of each listed character are added automatically too. Do not repeat them; refer to characters by name and describe only what changes (expression, pose, action).
7. Use only characters and backgrounds that exist in "project" and refer to them by their "id" in "characterIds" and "backgroundId". "characterIds" in a block lists who appears in that block; omit it to use the scene cast. A person in the script who is not a project character is described in the prompt text and not listed in "characterIds". Use "backgroundId": null when no background fits.
8. Keep continuity explicit: the end of a block's prompt should leave characters where the next block picks them up.
9. When the user gives a total length, the sum of all block durations of all scenes should be close to it. Otherwise pace the blocks to the script (an action or a line usually takes 4 to 10 seconds).
10. "title", "synopsis" and "note" are written in the same language as the script the user gives (for a script in Portuguese, write them in Portuguese), even though every "prompt", "state" and "opening" is in English.
11. Reply with ONLY a JSON object that matches "responseFormat.example" exactly (same keys), with no comments and no text before or after it.

${CONTINUITY_RULES}`;

// Instruções e mensagem para gerar o roteiro completo pela API de um provedor.
export function fullScriptRequest(project, { script = "", seconds = null } = {}) {
  const brief = buildBrief(project);
  const [first, second, third, fourth] = brief.responseFormat.example.scene.blocks;
  const example = brief.responseFormat.example.scene;
  brief.responseFormat = {
    description: "Return exactly this structure, with one entry in \"scenes\" per scene of the script. Every block needs duration and prompt.",
    example: {
      format: SCRIPT_FORMAT,
      version: 1,
      scenes: [
        { ...example, title: "First scene title", blocks: [first, second, third, fourth] },
        { ...example, title: "Second scene title, picking up where the first ended", start: "previous", blocks: [{ ...first, state: "English sentence with the state that carries over.", prompt: "English paragraph describing the opening shot of the next scene." }] },
      ],
    },
  };
  const system = `${FULL_SCRIPT_INSTRUCTIONS}\n\nThe project file:\n\n${JSON.stringify(brief, null, 2)}`;
  const lines = ["Write the scenes for this complete script."];
  if (seconds) lines.push(`Total length of the video: about ${seconds} seconds.`);
  lines.push("", "<script>", String(script).trim(), "</script>");
  return { system, user: lines.join("\n") };
}

// Pede à LLM para corrigir um roteiro que não passou na validação.
export function repairRequest(errors) {
  return `Your reply could not be imported. Problems:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nReply again with the complete corrected JSON (all scenes and blocks), with no text before or after it.`;
}

// Aceita JSON puro, dentro de bloco de código ou com texto em volta.
export function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Cole o JSON devolvido pela LLM.");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [raw, fenced?.[1], raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)].filter(Boolean);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* tenta o próximo formato */
    }
  }
  throw new Error("Não encontrei um JSON válido no texto colado. Peça à LLM para responder só com o JSON.");
}

function resolveRef(list, value, label, errors, where) {
  if (value == null || value === "") return null;
  const key = String(value).trim().toLowerCase();
  const found = list.find((x) => x.id === value) ?? list.find((x) => x.name.trim().toLowerCase() === key);
  if (!found) errors.push(`${where}: ${label} "${value}" não existe no projeto.`);
  return found?.id ?? null;
}

// Palavras faladas no prompt: o que está entre aspas.
export function spokenWords(prompt) {
  const quoted = String(prompt).match(/"[^"]+"|“[^”]+”/g) ?? [];
  return quoted.reduce((n, q) => n + (q.slice(1, -1).match(/[\p{L}\p{N}']+/gu)?.length ?? 0), 0);
}

// Lê o "start" de um bloco de corte: "scene", "none", "block:N" ou "background:<id ou nome>".
// Devolve { kind, id } ou { kind: "block", number } (número do bloco, resolvido depois).
export function parseCutStart(project, value, number, errors, at, { reference = null, keyframe = true } = {}) {
  let kind;
  let ref;
  if (value && typeof value === "object") {
    kind = String(value.kind ?? (value.block != null ? "block" : value.backgroundId != null ? "background" : "")).toLowerCase();
    ref = value.block ?? value.backgroundId ?? value.id;
  } else {
    const m = String(value ?? "").trim().match(/^([a-z]+)\s*(?::\s*(.+))?$/i);
    kind = m?.[1].toLowerCase();
    ref = m?.[2];
  }
  if (kind === "scene" || kind === "none") return { kind, id: null };
  if (kind === "keyframe" && keyframe) {
    const ref = reference == null || reference === "" ? { kind: "scene", id: null } : parseCutStart(project, reference, number, errors, `${at} ("reference")`, { keyframe: false });
    return { kind: "keyframe", id: null, ref: ref ?? { kind: "scene", id: null } };
  }
  if (kind === "block") {
    const n = Number(ref);
    if (!Number.isInteger(n) || n < 1 || n >= number) {
      errors.push(`${at}: "start": "block:${ref ?? ""}" precisa apontar para um bloco anterior desta cena (1 a ${number - 1}).`);
      return null;
    }
    return { kind: "block", number: n };
  }
  if (kind === "background") {
    const id = resolveRef(project.backgrounds, ref, "fundo", errors, at);
    if (!ref) errors.push(`${at}: "start": "background:<id>" sem o id do fundo.`);
    return id ? { kind: "background", id } : null;
  }
  errors.push(`${at}: "start" "${typeof value === "object" ? JSON.stringify(value) : value}" inválido. Use ${keyframe ? '"keyframe", ' : ""}"scene", "none", "block:N" ou "background:<id>".`);
  return null;
}

// Valida e converte o roteiro em cena(s) do projeto. Lança erro com a lista de problemas.
// `strict` exige o "start" em todo corte (usado no roteiro automático, que pede correção à LLM).
export function parseScript(project, input, { strict = false } = {}) {
  const data = typeof input === "string" ? extractJson(input) : input;
  const list = Array.isArray(data?.scenes) ? data.scenes : data?.scene ? [data.scene] : Array.isArray(data?.blocks) ? [data] : null;
  if (!list?.length) throw new Error('O JSON precisa ter "scene" com "blocks".');
  const errors = [];
  const warnings = [];
  const scenes = list.map((raw, si) => {
    const where = list.length > 1 ? `Cena ${si + 1}` : "Cena";
    if (!Array.isArray(raw?.blocks) || !raw.blocks.length) errors.push(`${where}: sem blocos.`);
    const characterIds = (Array.isArray(raw?.characterIds) ? raw.characterIds : [])
      .map((c) => resolveRef(project.characters, c, "personagem", errors, where))
      .filter(Boolean);
    const backgroundId = resolveRef(project.backgrounds, raw?.backgroundId, "fundo", errors, where);
    const sceneStart = String(raw?.start ?? "background").trim().toLowerCase();
    if (!["background", "none", "previous", "keyframe"].includes(sceneStart)) errors.push(`${where}: "start" da cena deve ser "background", "previous", "keyframe" ou "none".`);
    if (sceneStart === "previous" && si === 0 && !project.scenes.length) errors.push(`${where}: "start": "previous" na primeira cena do projeto, que não tem cena anterior.`);
    const blocks = (raw?.blocks ?? []).map((b, bi) => {
      const at = `${where}, bloco ${bi + 1}`;
      const duration = Number(b?.duration);
      if (!Number.isFinite(duration)) errors.push(`${at}: "duration" ausente.`);
      else if (duration > 20) errors.push(`${at}: ${duration}s passa do limite de 20s. Divida em mais blocos.`);
      else if (duration < 2) errors.push(`${at}: ${duration}s é menos que o mínimo de 2s.`);
      else if (duration < 3) (strict ? errors : warnings).push(`${at}: ${duration}s é curto demais (mínimo de 3s). Junte com o bloco vizinho.`);
      if (project.settings?.audio && Number.isFinite(duration) && typeof b?.prompt === "string") {
        const words = spokenWords(b.prompt);
        const fits = Math.floor(duration * 2.5);
        if (words > Math.ceil(duration * 3))
          (strict ? errors : warnings).push(`${at}: ${words} palavras de fala em ${duration}s; cabem cerca de ${fits}. Divida a fala em mais blocos ou aumente a duração.`);
      }
      else if (!Number.isInteger(duration)) warnings.push(`${at}: duração arredondada para ${Math.round(duration)}s.`);
      if (typeof b?.prompt !== "string" || !b.prompt.trim()) errors.push(`${at}: "prompt" vazio.`);
      let continuity = b?.continuity ?? (bi === 0 ? "cut" : "continue");
      if (!CONTINUITY.includes(continuity)) {
        warnings.push(`${at}: continuidade "${continuity}" desconhecida; usando "continue".`);
        continuity = "continue";
      }
      let start = { kind: "scene", id: null };
      if (bi > 0 && continuity === "cut") {
        if (b?.start == null || b.start === "") {
          if (strict) errors.push(`${at}: corte sem "start". Diga de onde sai a imagem inicial: "scene", "block:N", "background:<id>" ou "none".`);
          else warnings.push(`${at}: corte sem "start"; usando a imagem inicial da cena.`);
        } else start = parseCutStart(project, b.start, bi + 1, errors, at, { reference: b.reference }) ?? start;
        if (start.kind === "keyframe" && !(typeof b?.opening === "string" && b.opening.trim()))
          (strict ? errors : warnings).push(`${at}: "start": "keyframe" sem "opening" (a descrição do quadro de abertura)${strict ? "" : "; usando o prompt"}.`);
      } else if (bi > 0 && b?.start != null && b.start !== "") {
        warnings.push(`${at}: "start" só vale em cortes; ignorado.`);
      }
      const blockCast = Array.isArray(b?.characterIds)
        ? b.characterIds.map((c) => resolveRef(project.characters, c, "personagem", errors, at)).filter(Boolean)
        : null;
      const text = (v) => (typeof v === "string" ? v.trim() : "");
      return { id: newId(), title: text(b?.title), prompt: String(b?.prompt ?? "").trim(), duration, continuity, start, note: text(b?.note), currentState: text(b?.state), opening: text(b?.opening), characterIds: blockCast };
    });
    // "block:N" vira o id do bloco N, que só existe depois de criar todos os blocos.
    const blockRef = (ref) => (ref?.kind === "block" ? { kind: "block", id: blocks[ref.number - 1].id } : ref);
    for (const b of blocks) {
      b.start = blockRef(b.start);
      if (b.start.kind === "keyframe") b.start = { ...b.start, ref: blockRef(b.start.ref) };
    }
    if (sceneStart === "keyframe" && blocks[0] && !blocks[0].opening)
      (strict ? errors : warnings).push(`${where}: "start": "keyframe" na cena sem "opening" no bloco 1${strict ? "" : "; usando o prompt"}.`);
    let start = backgroundId && sceneStart !== "none" ? { kind: "background", id: backgroundId } : { kind: "none", id: null };
    if (sceneStart === "previous") start = { kind: "previous", id: null };
    if (sceneStart === "keyframe") {
      const raw0 = String(raw?.reference ?? "background").trim();
      let ref = backgroundId ? { kind: "background", id: backgroundId } : { kind: "none", id: null };
      if (raw0 === "none") ref = { kind: "none", id: null };
      else if (raw0 === "previous") ref = { kind: "previous", id: null };
      else if (/^background:/i.test(raw0)) {
        const id = resolveRef(project.backgrounds, raw0.slice(raw0.indexOf(":") + 1).trim(), "fundo", errors, `${where} ("reference")`);
        if (id) ref = { kind: "background", id };
      }
      start = { kind: "keyframe", id: null, ref };
    }
    return normalizeScene({
      id: newId(),
      title: raw?.title,
      synopsis: raw?.synopsis,
      characterIds,
      backgroundId,
      start,
      blocks,
    });
  });
  if (errors.length) throw Object.assign(new Error(errors.join("\n")), { status: 422, details: errors });
  return { scenes, warnings };
}
