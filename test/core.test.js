import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, mergeEdit, newProject, blockState, normalizeSettings } from "../server/store.js";
import { parseScript, extractJson, buildBrief, fullScriptRequest, SCRIPT_FORMAT } from "../server/llm.js";
import { videoPrompt, imageSize, blockBackground } from "../server/prompts.js";
import { renderDuration } from "../server/ltx.js";
import { latentFrames } from "../server/media.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "takes-test-"));

function sample() {
  const p = newProject("Teste");
  p.prePrompt = "Cinematic film look";
  p.characters.push({ id: "ana", name: "Ana", role: "lead", appearance: "30-year-old woman, short black hair", wardrobe: "red raincoat", personality: "", voice: "", notes: "", photo: "/x/ana.png" });
  p.backgrounds.push({ id: "cafe", name: "Café", description: "a small rainy-day café", image: "/x/cafe.png" });
  return p;
}

test("mergeEdit keeps server-owned data (photos, takes)", () => {
  const p = sample();
  p.scenes.push({ id: "s1", title: "S", synopsis: "", characterIds: [], backgroundId: null, start: { kind: "none", id: null }, exports: [], blocks: [{ id: "b1", prompt: "a", duration: 5, continuity: "cut", characterIds: null, takes: [{ id: "t1", file: "/f.mp4" }], selectedTakeId: "t1" }] });
  const next = mergeEdit(p, {
    characters: [{ id: "ana", name: "Ana B", photo: "/evil.png" }],
    scenes: [{ id: "s1", title: "Nova", blocks: [{ id: "b1", prompt: "b", duration: 99, takes: [], selectedTakeId: "nope" }, { prompt: "novo" }] }],
  });
  assert.equal(next.characters[0].name, "Ana B");
  assert.equal(next.characters[0].photo, "/x/ana.png");
  const [b1, b2] = next.scenes[0].blocks;
  assert.equal(b1.prompt, "b");
  assert.equal(b1.duration, 20);
  assert.deepEqual(b1.takes, [{ id: "t1", file: "/f.mp4" }]);
  assert.equal(b1.selectedTakeId, "t1");
  assert.ok(b2.id);
  assert.deepEqual(b2.takes, []);
});

test("settings are validated", () => {
  const s = normalizeSettings({ resolution: "8k", fps: "25", seed: "12", contextSeconds: 30 });
  assert.equal(s.resolution, "720p");
  assert.equal(s.fps, 25);
  assert.equal(s.seed, 12);
  assert.equal(s.contextSeconds, 5);
});

test("store persists and reloads projects", () => {
  const root = tmp();
  const store = new Store(root);
  const p = store.create("Meu filme");
  store.edit(p.id, { prePrompt: "noir" });
  const again = new Store(root);
  assert.equal(again.get(p.id).prePrompt, "noir");
  again.remove(p.id);
  assert.throws(() => again.get(p.id));
});

test("blockState detects stale continuation", () => {
  const dir = tmp();
  const f = path.join(dir, "a.mp4");
  fs.writeFileSync(f, "x");
  const scene = {
    blocks: [
      { takes: [{ id: "a1", file: f, mode: "start" }, { id: "a2", file: f, mode: "start" }], selectedTakeId: "a2" },
      { takes: [{ id: "b1", file: f, mode: "continue", basedOn: "a1" }], selectedTakeId: "b1" },
      { takes: [{ id: "c1", file: f, mode: "cut", basedOn: null }], selectedTakeId: "c1" },
      { takes: [], selectedTakeId: null },
    ],
  };
  assert.equal(blockState(scene, 0), "ready");
  assert.equal(blockState(scene, 1), "stale");
  assert.equal(blockState(scene, 2), "ready");
  assert.equal(blockState(scene, 3), "empty");
});

test("parseScript resolves names, validates limits and accepts fenced JSON", () => {
  const p = sample();
  const text = "Aqui está:\n```json\n" + JSON.stringify({
    format: SCRIPT_FORMAT,
    scene: { title: "Chuva", characterIds: ["Ana"], backgroundId: "Café", blocks: [{ duration: 8, prompt: "Ana enters." }, { duration: 6.4, continuity: "frame", prompt: "She sits." }] },
  }) + "\n```";
  const { scenes, warnings } = parseScript(p, text);
  assert.equal(scenes.length, 1);
  assert.deepEqual(scenes[0].characterIds, ["ana"]);
  assert.equal(scenes[0].backgroundId, "cafe");
  assert.deepEqual(scenes[0].start, { kind: "background", id: "cafe" });
  assert.equal(scenes[0].blocks[0].continuity, "cut");
  assert.equal(scenes[0].blocks[1].duration, 6);
  assert.equal(warnings.length, 1);

  assert.throws(
    () => parseScript(p, { scene: { blocks: [{ duration: 25, prompt: "x" }, { duration: 5, prompt: "" }], characterIds: ["Zé"] } }),
    (e) => /20s/.test(e.message) && /prompt/.test(e.message) && /Zé/.test(e.message),
  );
  assert.throws(() => extractJson("sem json"), /JSON/);
});

test("parseScript reads the opening image of each cut and validates it", () => {
  const p = sample();
  p.backgrounds.push({ id: "cafe-open", name: "Café aberto", description: "the café with its door wide open", image: "/x/open.png" });
  const blocks = [
    { duration: 6, prompt: "Wide shot of Ana at the door.", note: "" },
    { duration: 5, continuity: "continue", prompt: "Push in to a close-up of Ana opening the door.", note: "Termina em close." },
    { duration: 4, continuity: "cut", start: "block:1", prompt: "Back to the wide shot; the door stands open.", note: "Volta ao plano aberto." },
    { duration: 4, continuity: "cut", start: "background:Café aberto", prompt: "Reverse angle." },
    { duration: 4, continuity: "cut", start: "none", prompt: "Street outside." },
    { duration: 4, continuity: "frame", start: "scene", prompt: "She waits." },
  ];
  const { scenes, warnings } = parseScript(p, { scene: { title: "Porta", backgroundId: "cafe", start: "none", blocks } }, { strict: true });
  const [scene] = scenes;
  assert.deepEqual(scene.start, { kind: "none", id: null });
  assert.deepEqual(scene.blocks[2].start, { kind: "block", id: scene.blocks[0].id });
  assert.deepEqual(scene.blocks[3].start, { kind: "background", id: "cafe-open" });
  assert.deepEqual(scene.blocks[4].start, { kind: "none", id: null });
  assert.deepEqual(scene.blocks[5].start, { kind: "scene", id: null });
  assert.equal(scene.blocks[1].note, "Termina em close.");
  assert.equal(warnings.length, 1, "start em bloco que não é corte gera aviso");

  // Erros que voltam para a LLM corrigir: corte sem start (modo estrito), bloco posterior, fundo inexistente.
  const bad = { scene: { blocks: [blocks[0], { duration: 4, continuity: "cut", prompt: "x" }, { duration: 4, continuity: "cut", start: "block:3", prompt: "y" }, { duration: 4, continuity: "cut", start: "background:Praia", prompt: "z" }] } };
  assert.throws(
    () => parseScript(p, bad, { strict: true }),
    (e) => e.details.length === 3 && /sem "start"/.test(e.message) && /bloco anterior/.test(e.message) && /Praia/.test(e.message),
  );
  // Sem modo estrito, corte sem start usa a imagem da cena com aviso.
  const loose = parseScript(p, { scene: { blocks: [blocks[0], { duration: 4, continuity: "cut", prompt: "x" }] } });
  assert.deepEqual(loose.scenes[0].blocks[1].start, { kind: "scene", id: null });
  assert.match(loose.warnings[0], /sem "start"/);
});

test("parseScript reads generated openings, state, scene starts and checks dialogue and pacing", () => {
  const p = sample();
  p.settings.audio = true;
  p.scenes.push({ id: "old", title: "Antes", blocks: [] });
  const script = {
    scenes: [
      {
        title: "Volta",
        backgroundId: "cafe",
        start: "previous",
        blocks: [
          { duration: 6, state: "The door stands open.", prompt: 'Ana says "Voltei, finalmente."' },
          { duration: 5, continuity: "cut", start: "keyframe", reference: "block:1", opening: "Close-up of Ana by the open door.", prompt: "Close-up." },
        ],
      },
      { title: "Gerada", backgroundId: "cafe", start: "keyframe", reference: "none", blocks: [{ duration: 5, opening: "Wide shot of the café.", prompt: "Wide." }] },
    ],
  };
  const { scenes } = parseScript(p, script, { strict: true });
  assert.deepEqual(scenes[0].start, { kind: "previous", id: null });
  assert.equal(scenes[0].blocks[0].currentState, "The door stands open.");
  assert.deepEqual(scenes[0].blocks[1].start, { kind: "keyframe", id: null, ref: { kind: "block", id: scenes[0].blocks[0].id } });
  assert.equal(scenes[0].blocks[1].opening, "Close-up of Ana by the open door.");
  assert.deepEqual(scenes[1].start, { kind: "keyframe", id: null, ref: { kind: "none", id: null } });

  const long = 'Ana says "' + Array.from({ length: 20 }, () => "palavra").join(" ") + '"';
  const bad = { scene: { blocks: [{ duration: 4, prompt: long }, { duration: 2, continuity: "continue", prompt: "x" }, { duration: 5, continuity: "cut", start: "keyframe", prompt: "y" }] } };
  assert.throws(
    () => parseScript(p, bad, { strict: true }),
    (e) => e.details.length === 3 && /20 palavras de fala em 4s/.test(e.message) && /curto demais/.test(e.message) && /sem "opening"/.test(e.message),
  );
  const loose = parseScript(p, bad);
  assert.equal(loose.warnings.length, 3);
  const first = newProject("Vazio");
  assert.throws(() => parseScript(first, { scene: { start: "previous", blocks: [{ duration: 5, prompt: "a" }] } }), /primeira cena/);
});

test("the script instructions explain how blocks carry state and framing", () => {
  const { system } = fullScriptRequest(sample(), { script: "x" });
  assert.match(system, /no memory between blocks/);
  assert.match(system, /"block:N"/);
  assert.match(system, /close-up/);
  assert.match(system, /"note"/);
  assert.match(system, /"start": "block:1"/);
  assert.match(system, /"keyframe"/);
  assert.match(system, /"previous"/);
  assert.match(system, /2\.5 spoken words per second/);
});

test("a cut that opens from another background changes the setting from then on", () => {
  const p = sample();
  p.backgrounds.push({ id: "open", name: "Aberto", description: "the café with its door wide open", image: "/x/open.png" });
  const scene = {
    backgroundId: "cafe",
    characterIds: [],
    blocks: [
      { id: "a", continuity: "cut", prompt: "a" },
      { id: "b", continuity: "cut", start: { kind: "background", id: "open" }, prompt: "b" },
      { id: "c", continuity: "continue", prompt: "c" },
      { id: "d", continuity: "cut", start: { kind: "block", id: "c" }, prompt: "d" },
      { id: "e", continuity: "cut", start: { kind: "scene" }, prompt: "e" },
    ],
  };
  assert.deepEqual(scene.blocks.map((b) => blockBackground(p, scene, b).id), ["cafe", "open", "open", "open", "cafe"]);
  assert.match(videoPrompt(p, scene, scene.blocks[2], { mode: "continue" }), /door wide open/);
});

test("the brief describes the project", () => {
  const p = sample();
  const brief = buildBrief(p);
  assert.equal(brief.project.characters[0].name, "Ana");
  assert.equal(brief.project.characters[0].photo, undefined);
  assert.equal(brief.responseFormat.example.format, SCRIPT_FORMAT);
  const { system, user } = fullScriptRequest(p, { script: "Ana espera.", seconds: 60 });
  assert.match(system, /same language as the script/);
  assert.match(user, /about 60 seconds/);
});

test("video prompt stacks pre-prompt, setting, cast and action", () => {
  const p = sample();
  const scene = { characterIds: ["ana"], backgroundId: "cafe" };
  const text = videoPrompt(p, scene, { prompt: "Ana sips coffee", characterIds: null }, { mode: "continue" });
  assert.ok(text.startsWith("Cinematic film look"));
  assert.match(text, /Setting: a small rainy-day café\./);
  assert.match(text, /Ana \(lead\): 30-year-old woman, short black hair\. Wearing red raincoat\./);
  assert.match(text, /Ana sips coffee/);
  assert.match(text, /no cut/);
  const solo = videoPrompt(p, scene, { prompt: "Empty room", characterIds: [] }, { mode: "start" });
  assert.doesNotMatch(solo, /Characters/);
});

test("frame and duration math", () => {
  assert.equal(latentFrames(48), 49);
  assert.equal(latentFrames(49), 49);
  assert.equal(latentFrames(48, 30), 25);
  assert.equal(latentFrames(3), 9);
  assert.equal(renderDuration(7), 8);
  assert.equal(renderDuration(13), 20);
  assert.equal(renderDuration(5), 5);
  assert.deepEqual(imageSize("16:9"), { width: 1344, height: 768 });
  assert.deepEqual(imageSize("9:16"), { width: 768, height: 1344 });
});

test("storyboard frame times: one every few seconds, at most 10, shared start in the same shot", async () => {
  const { frameTimes } = await import("../server/store.js");
  assert.deepEqual(frameTimes({ duration: 8, continuity: "cut" }, 0, 2).map((f) => f.at), [0, 2, 4, 6, 8]);
  const long = frameTimes({ duration: 20, continuity: "cut" }, 0, 2);
  assert.equal(long.length, 10);
  assert.deepEqual([long[0].at, long.at(-1).at], [0, 20]);
  assert.deepEqual(frameTimes({ duration: 6, continuity: "continue" }, 1, 2).map((f) => [f.at, f.shared]), [[0, true], [2, false], [4, false], [6, false]]);
  assert.equal(frameTimes({ duration: 6, continuity: "cut" }, 1, 2)[0].shared, false);
});
