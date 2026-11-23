import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, mergeEdit, newProject, blockState, normalizeSettings } from "../server/store.js";
import { parseScript, extractJson, buildBrief, userPrompt, SCRIPT_FORMAT } from "../server/llm.js";
import { videoPrompt, imageSize } from "../server/prompts.js";
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

test("brief and user prompt describe the project", () => {
  const p = sample();
  const brief = buildBrief(p);
  assert.equal(brief.project.characters[0].name, "Ana");
  assert.equal(brief.project.characters[0].photo, undefined);
  assert.equal(brief.responseFormat.example.format, SCRIPT_FORMAT);
  const text = userPrompt(p, { request: "Ana espera", seconds: 60, fileName: "t.json" });
  assert.match(text, /t\.json/);
  assert.match(text, /60 segundos/);
  const inline = userPrompt(p, { request: "x", inline: true, brief });
  assert.match(inline, /```json/);
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
