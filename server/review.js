// Supervisão com visão, usando o modelo da revisão escolhido em Configurações:
//  - review: antes de o LTX gerar um bloco, a LLM vê os quadros que o LTX realmente gerou, a imagem
//    que o bloco vai usar e os fundos, e confirma ou ajusta continuidade, abertura, estado e prompt.
//  - judge: depois do bloco, a LLM vê quadros do take, o fim do bloco anterior e as fotos dos
//    personagens e aprova ou reprova o take (a fila gera outro take quando reprova).
//  - checkKeyframe: confere a imagem de abertura gerada pelo Z-Image antes de ela virar vídeo.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CONTINUITY_RULES, parseCutStart, extractJson } from "./llm.js";
import { CONTINUITY, selectedTake } from "./store.js";
import { sceneCharacters } from "./prompts.js";
import { ask, userMessage, PROVIDERS } from "./ai.js";

// Limites de imagens por pedido (cada imagem custa tokens).
const MAX_BLOCK_FRAMES = 8;
const MAX_BACKGROUNDS = 6;
const MAX_CHARACTERS = 4;

const MEMORY_RULES = `Project notes are short lessons that Takes adds to EVERY prompt of the project (videos and opening images), right after the pre-prompt; they are listed with their ids. With "memory" you may add a note when you learned something that applies to the whole project and will prevent the same failure in other blocks: how a character must look so LTX does not get it wrong (for example "Teca is a capybara with a broad brown snout and small round ears, never a hamster or a guinea pig"), wording LTX misreads, a recurring artifact to avoid. Never add actions, states or framing of a single block. Keep each note under 30 words, in English, and do not repeat what the pre-prompt or an existing note already says. Remove a note by id when it is wrong or no longer useful. Most of the time, leave "memory" out.`;

const STYLE = `"prompt" follows the same style as the plan: English, one paragraph of 3 to 7 sentences, present tense, no lists, no block numbers; the project pre-prompt, setting description, "state" and character descriptions are added automatically.`;

const REVIEW_SYSTEM = `You are the continuity supervisor of a video made with LTX, a local text/image-to-video model, inside the Takes app. A scene is split into blocks of at most 20 seconds that LTX renders one at a time. LTX is about to render the next block. You see what LTX ACTUALLY rendered so far (the last frame of earlier blocks), which may differ from the plan: an action may not have happened, the camera may have ended closer or wider than planned, an object may be in a different state.

Decide whether the planned next block still works with what was actually rendered, and fix it if not:
- Does the previous block end in the framing and with the state the next block expects?
- Will the opening of the next block ("continue", "frame", or the "start" image of a "cut") match its shot and the current state of the place and objects? The scene background image shows the place in its ORIGINAL state.
- Does "state" describe what differs from the background now, and does the prompt start from the framing the block opens on?

Change only what is needed for continuity. Keep the block's story, action, dialogue, duration and characters. ${STYLE}

${CONTINUITY_RULES}

${MEMORY_RULES}

Reply with ONLY a JSON object, no text before or after it:
{"decision": "keep" or "change", "memory": {"add": ["new note"], "remove": ["note id"]} (optional), "continuity": "continue" | "frame" | "cut", "start": "keyframe" | "block:N" | "scene" | "background:<id>" | "none" (only when "continuity" is "cut"; N must be an earlier block that was rendered), "reference": "scene" | "block:N" | "background:<id>" | "none" (only with "keyframe"), "opening": "English description of the first frame (only with keyframe)", "state": "current state in English, or empty", "prompt": "the full prompt of the block (unchanged when keeping)", "note": "continuity note for the editor, in Brazilian Portuguese", "reason": "one or two sentences in Brazilian Portuguese explaining what you saw and what you changed, or why the plan is fine"}`;

const JUDGE_SYSTEM = `You are the quality judge of a video made with LTX, a local text/image-to-video model, inside the Takes app. LTX just rendered one block (at most 20 seconds) of a scene. You see frames of the rendered take in order (one every few seconds, then the last one), the last frame of the previous block, the opening image that was used, and reference photos of the characters.

Decide whether this take is good enough to keep, as a demanding but pragmatic film editor. LTX is imperfect: small deviations in pose, timing or detail pass. Fail the take only for problems a viewer would notice:
- The main action of the prompt did not happen or something clearly different happened.
- A character is missing, duplicated or does not look like their reference (face, hair, outfit), or an extra person appears that the prompt does not describe.
- The "state" (for example an open gate, a missing object) does not hold.
- Severe artifacts: melting or deformed faces or hands, morphing objects, garbled frames.
- The transition from the previous block breaks continuity: with "continue" or "frame" the first frame must match the previous block's last frame; with a "cut" the new shot must plausibly show the same place, moment and state.

Reply with ONLY a JSON object, no text before or after it:
{"pass": true or false, "score": integer 0 to 10 (10 = perfect, 6 = acceptable), "problems": ["each problem in Brazilian Portuguese"], "reason": "one sentence in Brazilian Portuguese"}`;

const KEYFRAME_SYSTEM = `You check opening images for a video made with LTX inside the Takes app. An image model generated the first frame of a new shot; LTX will animate it. You see the generated image, the reference photos of the characters, the last frame of the previous block and the planned shot.

Pass the image when it shows the planned framing and the place in the current "state", with the right characters looking like their references and no severe artifacts. Fail it for problems a viewer would notice (wrong state, wrong or missing characters, deformed faces, wrong framing).

Reply with ONLY a JSON object, no text before or after it:
{"pass": true or false, "problems": ["each problem in Brazilian Portuguese"], "reason": "one sentence in Brazilian Portuguese"}`;

const REVISE_SYSTEM = `You fix a block of a video made with LTX, a local text/image-to-video model, inside the Takes app. The quality judge just rejected a take of this block. LTX will render the block again. You see the judge's verdict, frames of the rejected take in order (one every few seconds, then the last one), the last frame of the previous block, the opening image that was used and reference photos of the characters.

Find why the take failed and change what will make the next take pass:
- If the action did not happen or came out wrong, rewrite the prompt so the action is simple, explicit and in chronological order; describe one main action per block; name who does what, where and how the camera frames it.
- If the place or an object is in the wrong state, fix "state" and say it in the prompt too.
- If the opening image was wrong (wrong state, wrong framing, wrong or missing characters), change the opening: for a "cut", a different "start" or a better "opening" description, or set "regenerateOpening" to true to generate the opening image again. Block 1 opens the scene: to fix its opening, set "start": "keyframe" with an "opening" that places the characters in the first frame and a "reference" ("background:<id>", "none"), or "regenerateOpening" when it already is a keyframe. Never claim a change you did not put in the JSON.
- If the take looks like plain bad luck of the generation (a glitch, a deformed hand) and the plan is right, keep everything ("decision": "keep"); the next take uses a different seed.

Keep the block's story, dialogue, duration and characters. ${STYLE}

${CONTINUITY_RULES}

${MEMORY_RULES} A rejected take is the best moment to learn: if the failure would repeat in other blocks (a character drawn as another animal, a misread word), add a note.

Reply with ONLY a JSON object, no text before or after it:
{"decision": "keep" or "change", "memory": {"add": ["new note"], "remove": ["note id"]} (optional), "continuity": "continue" | "frame" | "cut", "start": "keyframe" | "block:N" | "scene" | "background:<id>" | "none" (only when "continuity" is "cut"), "reference": "scene" | "block:N" | "background:<id>" | "none" (only with "keyframe"), "opening": "English description of the first frame (only with keyframe)", "regenerateOpening": true or false, "state": "current state in English, or empty", "prompt": "the full prompt for the next take", "note": "continuity note for the editor, in Brazilian Portuguese", "reason": "one or two sentences in Brazilian Portuguese: what went wrong and what you changed"}`;

const fail = (message) => Object.assign(new Error(message), { status: 422 });

function refLabel(scene, ref) {
  if (!ref) return "scene";
  if (ref.kind === "block") return `block:${scene.blocks.findIndex((b) => b.id === ref.id) + 1}`;
  if (ref.kind === "background" || ref.kind === "preview") return `${ref.kind}:${ref.id}`;
  return ref.kind;
}

function startLabel(scene, block) {
  const st = block.start ?? { kind: "scene" };
  return st.kind === "keyframe" ? `keyframe (reference ${refLabel(scene, st.ref)})` : refLabel(scene, st);
}

async function jpeg(file) {
  return { mediaType: "image/jpeg", data: (await fsp.readFile(file)).toString("base64") };
}

// Notas a acrescentar (até 3, curtas) e ids existentes a retirar.
function readMemory(project, memory) {
  if (!memory || typeof memory !== "object") return { add: [], remove: [] };
  const ids = new Set((project.memory ?? []).map((n) => n.id));
  const add = (Array.isArray(memory.add) ? memory.add : [])
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => t.trim().slice(0, 300))
    .slice(0, 3);
  const remove = (Array.isArray(memory.remove) ? memory.remove : []).filter((id) => ids.has(id));
  return { add, remove };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const text = (v) => (typeof v === "string" ? v.trim() : "");

export class ContinuityReviewer {
  constructor({ settings, writer, media, fetchImpl = fetch }) {
    this.settings = settings;
    this.writer = writer;
    this.media = media;
    this.fetch = fetchImpl;
  }

  // Modelo da revisão e do juiz escolhido em Configurações (ou o do roteiro), se houver chave.
  model() {
    if (this.settings.supervisor) return this.settings.supervisor();
    const m = this.settings.data.model;
    return m && (this.settings.has ? this.settings.has(m.provider) : this.settings.key(m.provider)) ? m : null;
  }

  // Monta as partes de uma mensagem: textos e imagens reduzidas a JPEG.
  parts(work, signal) {
    const parts = [];
    let n = 0;
    return {
      parts,
      text: (t) => parts.push({ text: t }),
      image: async (label, file, opts = {}) => {
        if (!file || !fs.existsSync(file)) return;
        const out = path.join(work, `ia-${process.pid}-${Date.now().toString(36)}-${n++}.jpg`);
        await this.media.still(file, out, { ...opts, signal });
        parts.push({ text: label }, { image: await jpeg(out) });
        await fsp.rm(out, { force: true });
      },
    };
  }

  plan(scene, index) {
    return scene.blocks.map((b, i) => ({
      block: i + 1,
      duration: b.duration,
      continuity: i === 0 ? "opens the scene" : b.continuity,
      ...(i > 0 && b.continuity === "cut" ? { start: startLabel(scene, b) } : {}),
      ...(b.opening ? { opening: b.opening } : {}),
      state: b.currentState || "",
      prompt: b.prompt,
      note: b.note || "",
      rendered: Boolean(selectedTake(b)),
      ...(i === index ? { next: true } : {}),
    }));
  }

  projectText(project, scene) {
    return [
      `Project pre-prompt: ${project.prePrompt || "(none)"}`,
      `Project notes: ${JSON.stringify((project.memory ?? []).map((n) => ({ id: n.id, text: n.text })))}`,
      `Characters: ${JSON.stringify(project.characters.map((c) => ({ id: c.id, name: c.name, appearance: c.appearance, wardrobe: c.wardrobe })))}`,
      `Backgrounds: ${JSON.stringify(project.backgrounds.map((b) => ({ id: b.id, name: b.name, description: b.description })))}`,
      `Scene "${scene.title}" background: ${scene.backgroundId ?? "(none)"}. Synopsis: ${scene.synopsis || "(none)"}`,
    ].join("\n");
  }

  // Quadros do take a cada `frameSeconds` (2 s por padrão) e o último: um take de 20 s vai com 11
  // imagens, para o juiz ver a ação inteira e não só o começo, o meio e o fim.
  async takeFrames(m, take, info, label) {
    const step = Number(this.settings.data?.frameSeconds) || 2;
    const times = [];
    for (let t = 0; t < info.duration - step / 2 && times.length < 19; t += step) times.push(t);
    for (const t of times) await m.image(`${label}, frame at ${t.toFixed(1)} s of ${info.duration.toFixed(1)} s:`, take.file, { time: t });
    await m.image(`${label}, last frame (${info.duration.toFixed(1)} s):`, take.file, { last: true });
  }

  // Foto e ficha de corpo inteiro de quem aparece no bloco.
  async characterImages(m, project, scene, block) {
    for (const c of sceneCharacters(project, scene, block).slice(0, MAX_CHARACTERS)) {
      await m.image(`Reference photo of ${c.name}:`, c.photo);
      const body = (c.refs ?? []).find((r) => r.view === "body");
      if (body) await m.image(`Full-body reference of ${c.name}:`, body.file);
    }
  }

  // Chama a LLM e valida a resposta; uma resposta inválida volta para ela corrigir uma vez.
  async askJson(system, parts, parse, signal) {
    const model = this.model();
    if (!model) throw fail("escolha um modelo em Configurações");
    const resolved = await this.writer.resolveModel(model.provider, model.id);
    const key = this.settings.key(model.provider);
    const messages = [userMessage(model.provider, parts)];
    for (let attempt = 1; ; attempt++) {
      const reply = await ask(model.provider, {
        key,
        model: resolved,
        system,
        messages,
        signal,
        fetchImpl: this.fetch,
        effort: this.settings.data.reviewEffort ?? "medium",
        fast: Boolean(this.settings.data.reviewFast),
      });
      try {
        return { ...parse(extractJson(reply)), model: `${PROVIDERS[model.provider].name} · ${resolved.name || resolved.id}` };
      } catch (error) {
        if (attempt >= 2) throw fail(`resposta inválida (${error.message})`);
        messages.push({ role: "assistant", content: reply }, userMessage(model.provider, [{ text: `Your reply could not be used: ${error.message} Reply again with only the corrected JSON.` }]));
      }
    }
  }

  // ---------- antes do bloco ----------

  async request(project, scene, index, work, { startImage, signal }) {
    const block = scene.blocks[index];
    const m = this.parts(work, signal);
    m.text([this.projectText(project, scene), `Plan of the scene (the block to review is block ${index + 1}, marked "next"):`, JSON.stringify(this.plan(scene, index), null, 2)].join("\n"));
    const rendered = scene.blocks
      .map((b, i) => ({ i, take: selectedTake(b) }))
      .filter(({ i, take }) => i < index && take && fs.existsSync(take.file))
      .slice(-MAX_BLOCK_FRAMES);
    for (const { i, take } of rendered) await m.image(`Last frame LTX actually rendered for block ${i + 1}:`, take.file, { last: true });
    if (block.continuity === "cut" && startImage && !["block", "none", "background"].includes(block.start?.kind))
      await m.image(`Opening image block ${index + 1} would use as planned ("start": "${startLabel(scene, block)}"):`, startImage);
    for (const b of project.backgrounds.filter((x) => x.image).slice(0, MAX_BACKGROUNDS)) await m.image(`Background ${b.id} ("${b.name}"), ORIGINAL state:`, b.image);
    m.text(`Review block ${index + 1} now and reply with the JSON.`);
    return m.parts;
  }

  // Valida a resposta da revisão. Devolve { changed, block: { continuity, start, prompt, note, currentState, opening }, reason }.
  parse(project, scene, index, data) {
    const errors = [];
    const block = scene.blocks[index];
    const continuity = data.continuity ?? block.continuity;
    if (!CONTINUITY.includes(continuity)) errors.push(`"continuity" "${continuity}" inválido.`);
    if (!text(data.prompt)) errors.push(`"prompt" vazio.`);
    let start = block.start ?? { kind: "scene", id: null };
    const toId = (ref) => {
      if (ref?.kind !== "block") return ref;
      const source = scene.blocks[ref.number - 1];
      if (!selectedTake(source)) errors.push(`"block:${ref.number}" aponta para um bloco que ainda não foi gerado.`);
      return { kind: "block", id: source.id };
    };
    if (continuity === "cut" && data.start != null && data.start !== "") {
      const parsed = parseCutStart(project, data.start, index + 1, errors, `Bloco ${index + 1}`, { reference: data.reference });
      if (parsed?.kind === "keyframe") {
        // Mantém a imagem já gerada se a abertura não mudou.
        const ref = toId(parsed.ref);
        const opening = text(data.opening) || block.opening;
        if (!opening) errors.push(`"start": "keyframe" sem "opening".`);
        const kept = block.start?.kind === "keyframe" && same(block.start.ref, ref) && opening === block.opening;
        start = { kind: "keyframe", id: kept ? block.start.id : null, ref };
      } else if (parsed) start = toId(parsed);
    }
    if (errors.length) throw Object.assign(fail(errors.join(" ")), { details: errors });
    const next = {
      continuity,
      start: continuity === "cut" ? start : block.start ?? { kind: "scene", id: null },
      prompt: text(data.prompt),
      note: typeof data.note === "string" ? data.note.trim() : block.note || "",
      currentState: typeof data.state === "string" ? data.state.trim() : block.currentState || "",
      opening: start.kind === "keyframe" ? text(data.opening) || block.opening || "" : block.opening || "",
    };
    const memory = readMemory(project, data.memory);
    const changed =
      next.continuity !== block.continuity ||
      next.prompt !== text(block.prompt) ||
      next.currentState !== (block.currentState || "") ||
      next.opening !== (block.opening || "") ||
      (continuity === "cut" && !same(next.start, block.start ?? { kind: "scene", id: null }));
    return { changed, block: next, reason: text(data.reason), memory };
  }

  async review({ project, scene, index, work, startImage = null, signal }) {
    const parts = await this.request(project, scene, index, work, { startImage, signal });
    return this.askJson(REVIEW_SYSTEM, parts, (data) => this.parse(project, scene, index, data), signal);
  }

  // ---------- depois de um take reprovado ----------

  // Ajusta o bloco antes do retake, a partir do que o juiz apontou. Devolve o mesmo formato da
  // revisão, mais `regenerateOpening` (gerar de novo a imagem de abertura).
  async revise({ project, scene, index, take, verdict, work, signal }) {
    const block = scene.blocks[index];
    const info = await this.media.probe(take.file);
    const m = this.parts(work, signal);
    m.text(
      [
        this.projectText(project, scene),
        `Plan of the scene (the block to fix is block ${index + 1}, marked "next"):`,
        JSON.stringify(this.plan(scene, index), null, 2),
        `The judge rejected the take of block ${index + 1} with score ${verdict.score}/10. Reason: ${verdict.reason || "(none)"}`,
        `Problems: ${(verdict.problems ?? []).join(" | ") || "(none listed)"}`,
      ].join("\n"),
    );
    const prev = index > 0 ? selectedTake(scene.blocks[index - 1]) : null;
    if (prev) await m.image(`Last frame of the previous block (${index}):`, prev.file, { last: true });
    if (take.startImage) await m.image("Opening image used for the rejected take:", take.startImage);
    await this.takeFrames(m, take, info, "Rejected take");
    await this.characterImages(m, project, scene, block);
    m.text(`Fix block ${index + 1} for the next take now and reply with the JSON.`);
    return this.askJson(
      REVISE_SYSTEM,
      m.parts,
      (data) => {
        // O 1º bloco abre a cena: a ligação dele é fixa e a abertura é a da cena.
        const fixed = index === 0 ? { ...data, continuity: block.continuity, start: null } : data;
        const r = this.parse(project, scene, index, fixed);
        // No 1º bloco a descrição do quadro de abertura vale para a abertura da cena.
        if (index === 0 && typeof data.opening === "string" && data.opening.trim()) {
          r.block.opening = data.opening.trim();
          if (r.block.opening !== (block.opening || "")) r.changed = true;
        }
        let sceneStart = null;
        if (index === 0 && String(data.start ?? "").trim().toLowerCase() === "keyframe") {
          const errors = [];
          const ref = data.reference
            ? parseCutStart(project, String(data.reference).replace(/^scene$/i, "none"), 1, errors, "Bloco 1 (\"reference\")", { keyframe: false })
            : scene.backgroundId
              ? { kind: "background", id: scene.backgroundId }
              : { kind: "none", id: null };
          if (errors.length) throw Object.assign(fail(errors.join(" ")), { details: errors });
          if (!r.block.opening) throw fail('"start": "keyframe" sem "opening".');
          const same = scene.start?.kind === "keyframe" && JSON.stringify(scene.start.ref) === JSON.stringify(ref) && r.block.opening === block.opening;
          if (!same) sceneStart = { kind: "keyframe", id: null, ref };
        }
        const keyframe = index === 0 ? (sceneStart ?? scene.start)?.kind === "keyframe" : r.block.start?.kind === "keyframe";
        const regenerateOpening = Boolean(data.regenerateOpening) && keyframe;
        return { ...r, sceneStart, regenerateOpening, changed: r.changed || regenerateOpening || Boolean(sceneStart) };
      },
      signal,
    );
  }

  // ---------- depois do bloco ----------

  async judge({ project, scene, index, take, work, signal }) {
    const block = scene.blocks[index];
    const info = await this.media.probe(take.file);
    const m = this.parts(work, signal);
    const mode = index === 0 ? "opens the scene" : block.continuity;
    m.text(
      [
        this.projectText(project, scene),
        `Block ${index + 1} of ${scene.blocks.length}, ${block.duration} s, continuity: ${mode}${index > 0 && block.continuity === "cut" ? ` (start: ${startLabel(scene, block)})` : ""}.`,
        `State that must hold: ${block.currentState || "(nothing differs from the background)"}`,
        `Prompt of the block: ${block.prompt}`,
        index > 0 ? `Previous block prompt: ${scene.blocks[index - 1].prompt}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const prev = index > 0 ? selectedTake(scene.blocks[index - 1]) : null;
    if (prev) await m.image(`Last frame of the previous block (${index}):`, prev.file, { last: true });
    if (take.startImage) await m.image("Opening image used for this take:", take.startImage);
    await this.takeFrames(m, take, info, "Rendered take");
    await this.characterImages(m, project, scene, block);
    m.text("Judge the take now and reply with the JSON.");
    return this.askJson(
      JUDGE_SYSTEM,
      m.parts,
      (data) => {
        if (typeof data.pass !== "boolean") throw fail('"pass" precisa ser true ou false.');
        const score = Math.max(0, Math.min(10, Math.round(Number(data.score))));
        return {
          pass: data.pass,
          score: Number.isFinite(score) ? score : data.pass ? 7 : 3,
          problems: Array.isArray(data.problems) ? data.problems.filter((p) => typeof p === "string").map((p) => p.trim()) : [],
          reason: text(data.reason),
        };
      },
      signal,
    );
  }

  async checkKeyframe({ project, scene, index, file, work, signal }) {
    const block = scene.blocks[index];
    const m = this.parts(work, signal);
    m.text(
      [
        this.projectText(project, scene),
        `Planned opening of block ${index + 1}: ${block.opening || block.prompt}`,
        `State that must show: ${block.currentState || "(nothing differs from the background)"}`,
      ].join("\n"),
    );
    const prev = index > 0 ? selectedTake(scene.blocks[index - 1]) : null;
    if (prev) await m.image(`Last frame of the previous block (${index}):`, prev.file, { last: true });
    await m.image("Generated opening image:", file);
    await this.characterImages(m, project, scene, block);
    m.text("Check the opening image now and reply with the JSON.");
    return this.askJson(
      KEYFRAME_SYSTEM,
      m.parts,
      (data) => {
        if (typeof data.pass !== "boolean") throw fail('"pass" precisa ser true ou false.');
        return { pass: data.pass, problems: Array.isArray(data.problems) ? data.problems.filter((p) => typeof p === "string") : [], reason: text(data.reason) };
      },
      signal,
    );
  }
}
