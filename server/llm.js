// Arquivo de projeto para LLMs e importação do roteiro gerado.
import { normalizeScene, newId, CONTINUITY } from "./store.js";

export const BRIEF_FORMAT = "takes.llm-brief";
export const SCRIPT_FORMAT = "takes.scene-script";

const LLM_INSTRUCTIONS = `You are a screenwriter and prompt writer for LTX, a local text/image-to-video model.
Write the complete script of ONE scene for the video project described in "project", split into consecutive blocks.

Hard rules:
1. Each block is at most 20 seconds and at least 2 seconds ("duration", integer seconds). LTX cannot render longer clips, so long actions must be split across several blocks.
2. Blocks play back to back and must feel like one continuous scene. Block 1 opens the scene. For each later block choose "continuity":
   - "continue": the camera keeps rolling; the block continues the motion of the previous one (default; use it for the same shot).
   - "frame": starts from the last frame of the previous block; use it for a calm change of action in the same shot.
   - "cut": a hard cut to a new shot, angle or place.
3. "prompt" is what LTX will render for that block, written in English as one paragraph of 3 to 7 sentences, present tense, in chronological order: who is in frame, what they do, how they move, the camera (framing, lens, movement), the lighting and the mood. Describe only what is visible or audible during that block. No lists, no markdown, no scene numbers, no "Block 2" references.
4. The project pre-prompt (style, look, rules) is added automatically before every prompt, and the appearance and wardrobe of each listed character are added automatically too. Do not repeat them; refer to characters by name and describe only what changes (expression, pose, action).
5. Use only characters and backgrounds that exist in "project" and refer to them by their "id" in "characterIds" and "backgroundId". "characterIds" in a block lists who appears in that block; omit it to use the scene cast.
6. Keep continuity explicit: the end of a block's prompt should leave characters where the next block picks them up.
7. Respect the requested total length of the scene when the user gives one; the sum of block durations is the scene length.
8. Reply with ONLY a JSON object that matches "responseFormat.example" exactly (same keys), with no comments and no text before or after it.`;

export function buildBrief(project) {
  return {
    format: BRIEF_FORMAT,
    version: 1,
    generatedAt: new Date().toISOString(),
    instructions: LLM_INSTRUCTIONS,
    limits: { minBlockSeconds: 2, maxBlockSeconds: 20, continuity: CONTINUITY },
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
          characterIds: project.characters.slice(0, 2).map((c) => c.id),
          blocks: [
            { duration: 8, continuity: "cut", characterIds: project.characters.slice(0, 1).map((c) => c.id), prompt: "English paragraph describing the opening shot." },
            { duration: 6, continuity: "continue", prompt: "English paragraph continuing the same shot." },
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
2. Each block is at most 20 seconds and at least 2 seconds ("duration", integer seconds). LTX cannot render longer clips, so long actions must be split across several blocks.
3. Blocks of a scene play back to back and must feel continuous. Block 1 of each scene opens it. For each later block choose "continuity":
   - "continue": the camera keeps rolling; the block continues the motion of the previous one (default; use it for the same shot).
   - "frame": starts from the last frame of the previous block; use it for a calm change of action in the same shot.
   - "cut": a hard cut to a new shot or angle inside the scene.
4. "prompt" is what LTX will render for that block, written in English as one paragraph of 3 to 7 sentences, present tense, in chronological order: who is in frame, what they do, how they move, the camera (framing, lens, movement), the lighting and the mood. Describe only what is visible or audible during that block. No lists, no markdown, no scene numbers, no "Block 2" references.
5. Dialogue: when "project.video.audio" is true, put the spoken lines in the prompt of the block where they are said, in quotes, with who says them and how (keep the script's language for the line itself). When audio is false, show the conversation visually instead of quoting it.
6. The project pre-prompt (style, look, rules) is added automatically before every prompt, and the appearance and wardrobe of each listed character are added automatically too. Do not repeat them; refer to characters by name and describe only what changes (expression, pose, action).
7. Use only characters and backgrounds that exist in "project" and refer to them by their "id" in "characterIds" and "backgroundId". "characterIds" in a block lists who appears in that block; omit it to use the scene cast. A person in the script who is not a project character is described in the prompt text and not listed in "characterIds". Use "backgroundId": null when no background fits.
8. Keep continuity explicit: the end of a block's prompt should leave characters where the next block picks them up.
9. When the user gives a total length, the sum of all block durations of all scenes should be close to it. Otherwise pace the blocks to the script (an action or a line usually takes 4 to 10 seconds).
10. "title" and "synopsis" of each scene are written in the language of the script.
11. Reply with ONLY a JSON object that matches "responseFormat.example" exactly (same keys), with no comments and no text before or after it.`;

// Instruções e mensagem para gerar o roteiro completo pela API de um provedor.
export function fullScriptRequest(project, { script = "", seconds = null } = {}) {
  const brief = buildBrief(project);
  const [first, second] = brief.responseFormat.example.scene.blocks;
  const example = brief.responseFormat.example.scene;
  delete brief.instructions;
  brief.responseFormat = {
    description: "Return exactly this structure, with one entry in \"scenes\" per scene of the script. Every block needs duration and prompt.",
    example: {
      format: SCRIPT_FORMAT,
      version: 1,
      scenes: [
        { ...example, title: "First scene title", blocks: [first, second] },
        { ...example, title: "Second scene title", blocks: [{ ...first, prompt: "English paragraph describing the opening shot of the next scene." }] },
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

// Texto que o usuário cola no chat da LLM junto com o arquivo.
export function userPrompt(project, { request = "", seconds = null, fileName = "projeto.json", inline = false, brief = null }) {
  const lines = [
    `Anexei o arquivo "${fileName}" com o projeto de vídeo "${project.name}".`,
    `Siga as instruções do campo "instructions" e escreva o roteiro completo de UMA cena, dividido em blocos de no máximo 20 segundos.`,
    `Responda somente com o JSON no formato de "responseFormat.example" (format "${SCRIPT_FORMAT}"), sem texto antes ou depois.`,
    "",
    `Cena: ${request.trim() || "[descreva aqui o que acontece na cena]"}`,
  ];
  if (seconds) lines.push(`Duração total desejada: cerca de ${seconds} segundos.`);
  if (inline && brief) {
    lines[0] = `Abaixo está o arquivo JSON com o projeto de vídeo "${project.name}".`;
    lines.push("", "```json", JSON.stringify(brief, null, 2), "```");
  }
  return lines.join("\n");
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

// Valida e converte o roteiro em cena(s) do projeto. Lança erro com a lista de problemas.
export function parseScript(project, input) {
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
    const blocks = (raw?.blocks ?? []).map((b, bi) => {
      const at = `${where}, bloco ${bi + 1}`;
      const duration = Number(b?.duration);
      if (!Number.isFinite(duration)) errors.push(`${at}: "duration" ausente.`);
      else if (duration > 20) errors.push(`${at}: ${duration}s passa do limite de 20s. Divida em mais blocos.`);
      else if (duration < 2) errors.push(`${at}: ${duration}s é menos que o mínimo de 2s.`);
      else if (!Number.isInteger(duration)) warnings.push(`${at}: duração arredondada para ${Math.round(duration)}s.`);
      if (typeof b?.prompt !== "string" || !b.prompt.trim()) errors.push(`${at}: "prompt" vazio.`);
      let continuity = b?.continuity ?? (bi === 0 ? "cut" : "continue");
      if (!CONTINUITY.includes(continuity)) {
        warnings.push(`${at}: continuidade "${continuity}" desconhecida; usando "continue".`);
        continuity = "continue";
      }
      const blockCast = Array.isArray(b?.characterIds)
        ? b.characterIds.map((c) => resolveRef(project.characters, c, "personagem", errors, at)).filter(Boolean)
        : null;
      return { id: newId(), title: typeof b?.title === "string" ? b.title : "", prompt: String(b?.prompt ?? "").trim(), duration, continuity, characterIds: blockCast };
    });
    return normalizeScene({
      id: newId(),
      title: raw?.title,
      synopsis: raw?.synopsis,
      characterIds,
      backgroundId,
      start: backgroundId ? { kind: "background", id: backgroundId } : { kind: "none", id: null },
      blocks,
    });
  });
  if (errors.length) throw Object.assign(new Error(errors.join("\n")), { status: 422, details: errors });
  return { scenes, warnings };
}
