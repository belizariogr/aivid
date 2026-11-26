import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "../server/index.js";

const fakeLtx = { status: async () => ({ connected: false, error: "off" }), ensureLocal: async () => {} };

async function start() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-srv-"));
  const app = createApp({ root, ltx: fakeLtx });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, url, body, headers = {}) =>
    fetch(base + url, { method, headers: { "X-Takes": "1", "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) });
  return { app, base, call, root, close: () => app.server.close() };
}

test("rejects writes without the app header and foreign hosts", async () => {
  const s = await start();
  try {
    const noHeader = await fetch(s.base + "/api/projects", { method: "POST", body: "{}" });
    assert.equal(noHeader.status, 403);
    const foreign = await new Promise((resolve) =>
      http.get(s.base + "/api/projects", { headers: { Host: "evil.example" } }, (res) => (res.resume(), resolve(res.statusCode))),
    );
    assert.equal(foreign, 403);
  } finally {
    s.close();
  }
});

test("project lifecycle, photo upload, script import and media guard", async () => {
  const s = await start();
  try {
    const p = await (await s.call("POST", "/api/projects", { name: "Curta" })).json();
    let proj = await (await s.call("POST", `/api/projects/${p.id}/characters`, { name: "Ana", appearance: "tall" })).json();
    const cid = proj.characters[0].id;
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    proj = await (await s.call("POST", `/api/projects/${p.id}/characters/${cid}/photo`, { dataUrl: png })).json();
    assert.ok(proj.characters[0].photo.startsWith(s.root));
    const img = await fetch(`${s.base}/media?path=${encodeURIComponent(proj.characters[0].photo)}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    const outside = await fetch(`${s.base}/media?path=${encodeURIComponent("/etc/hosts")}`);
    assert.equal(outside.status, 404);

    const script = JSON.stringify({ format: "takes.scene-script", version: 1, scene: { title: "Chegada", characterIds: ["Ana"], blocks: [{ duration: 10, prompt: "Ana walks in." }, { duration: 20, prompt: "She waits." }] } });
    const check = await (await s.call("POST", `/api/projects/${p.id}/import-script`, { text: script, validateOnly: true })).json();
    assert.equal(check.scenes[0].blocks.length, 2);
    const imported = await (await s.call("POST", `/api/projects/${p.id}/import-script`, { text: script })).json();
    assert.equal(imported.project.scenes[0].title, "Chegada");
    assert.deepEqual(imported.project.scenes[0].characterIds, [cid]);
    assert.equal(imported.project.scenes[0].blocks[0].state, "empty");

    // Substituir todas as cenas troca a lista inteira.
    const replaced = await (await s.call("POST", `/api/projects/${p.id}/import-script`, { text: script, mode: "replace" })).json();
    assert.equal(replaced.project.scenes.length, 1);

    const bad = await s.call("POST", `/api/projects/${p.id}/import-script`, { text: '{"scene":{"blocks":[{"duration":30,"prompt":"x"}]}}' });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /20s/);

    const gen = await s.call("POST", `/api/projects/${p.id}/scenes/${replaced.sceneIds[0]}/export`, {});
    assert.equal(gen.status, 409);
  } finally {
    s.close();
  }
});

test("queues every scene of the project at once", async () => {
  const s = await start();
  try {
    const p = await (await s.call("POST", "/api/projects", { name: "Longa" })).json();
    const none = await s.call("POST", `/api/projects/${p.id}/generate-all`, {});
    assert.equal(none.status, 409);
    const script = JSON.stringify({
      scenes: [
        { title: "Um", blocks: [{ duration: 5, prompt: "A." }, { duration: 5, prompt: "B." }] },
        { title: "Dois", blocks: [{ duration: 8, prompt: "C." }] },
      ],
    });
    await s.call("POST", `/api/projects/${p.id}/import-script`, { text: script });
    const r = await (await s.call("POST", `/api/projects/${p.id}/generate-all`, {})).json();
    assert.deepEqual(r.added.map((j) => j.title), ["Rascunho · Um — blocos 1–2", "Rascunho · Dois — bloco 1"]);
    assert.deepEqual(r.added.map((j) => j.blockIds.length), [2, 1]);
  } finally {
    s.close();
  }
});

test("clones a project with its assets and clears all scenes", async () => {
  const s = await start();
  try {
    const p = await (await s.call("POST", "/api/projects", { name: "Original" })).json();
    let proj = await (await s.call("POST", `/api/projects/${p.id}/characters`, { name: "Ana" })).json();
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    proj = await (await s.call("POST", `/api/projects/${p.id}/characters/${proj.characters[0].id}/photo`, { dataUrl: png })).json();
    await s.call("PUT", `/api/projects/${p.id}`, { outputDir: "/tmp/original" });
    await s.call("POST", `/api/projects/${p.id}/import-script`, { text: JSON.stringify({ scene: { title: "Um", blocks: [{ duration: 5, prompt: "A." }] } }) });
    const original = await (await fetch(`${s.base}/api/projects/${p.id}`)).json();

    const copy = await (await s.call("POST", `/api/projects/${p.id}/clone`, { name: "Cópia" })).json();
    assert.equal(copy.name, "Cópia");
    assert.notEqual(copy.id, p.id);
    assert.equal(copy.outputDir, "");
    assert.ok(copy.characters[0].photo.includes(copy.id));
    assert.ok(fs.existsSync(copy.characters[0].photo));
    assert.equal(copy.scenes[0].title, "Um");
    assert.notEqual(copy.scenes[0].id, original.scenes[0].id);
    assert.deepEqual(copy.scenes[0].blocks[0].takes, []);

    const cleared = await (await s.call("DELETE", `/api/projects/${copy.id}/scenes`)).json();
    assert.deepEqual(cleared.scenes, []);
    assert.equal(cleared.characters.length, 1);
    const still = await (await fetch(`${s.base}/api/projects/${p.id}`)).json();
    assert.equal(still.scenes.length, 1);
    assert.ok(fs.existsSync(still.characters[0].photo));
  } finally {
    s.close();
  }
});

test("saves a frame of a take as a preview and undoes a continuity review", async () => {
  const media = await import("../server/media.js");
  const ffmpeg = await media.findBinary("ffmpeg").catch(() => null);
  if (!ffmpeg) return;
  const { execFileSync } = await import("node:child_process");
  const s = await start();
  try {
    const p = await (await s.call("POST", "/api/projects", { name: "Quadros" })).json();
    const out = path.join(s.root, "out");
    const video = path.join(s.root, "b1.mp4");
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=160x90:r=24", "-t", "2", "-pix_fmt", "yuv420p", video]);
    await s.call("PUT", `/api/projects/${p.id}`, { outputDir: out, scenes: [{ id: "s", title: "Cena", blocks: [{ id: "b1", prompt: "a" }, { id: "b2", prompt: "b", continuity: "cut" }] }] });
    s.app.store.update(p.id, (x) => {
      const [b1, b2] = x.scenes[0].blocks;
      b1.takes.push({ id: "t1", file: video, mode: "start" });
      b1.selectedTakeId = "t1";
      Object.assign(b2, { prompt: "reviewed", start: { kind: "none", id: null }, review: { at: "2026-11-25T00:00:00Z", changed: true, reason: "r", before: { continuity: "cut", start: { kind: "scene", id: null }, prompt: "b", note: "" } } });
    });

    const r = await (await s.call("POST", `/api/projects/${p.id}/scenes/s/blocks/b1/frame`, { time: 1.2 })).json();
    const preview = r.project.previews.find((x) => x.id === r.previewId);
    assert.ok(fs.existsSync(preview.file) && preview.file.startsWith(path.join(out, "previas")));
    assert.deepEqual(preview.fromBlock, { blockId: "b1", takeId: "t1", time: 1.2 });
    // No fim do vídeo usa o último quadro em vez de passar do fim.
    assert.equal((await s.call("POST", `/api/projects/${p.id}/scenes/s/blocks/b1/frame`, { time: 2 })).status, 200);
    assert.equal((await s.call("POST", `/api/projects/${p.id}/scenes/s/blocks/b2/frame`, { time: 0 })).status, 404);

    const undone = await (await s.call("POST", `/api/projects/${p.id}/scenes/s/blocks/b2/review/undo`)).json();
    const b2 = undone.scenes[0].blocks[1];
    assert.equal(b2.prompt, "b");
    assert.deepEqual(b2.start, { kind: "scene", id: null });
    assert.equal(b2.review.undone, true);
    assert.equal((await s.call("POST", `/api/projects/${p.id}/scenes/s/blocks/b2/review/undo`)).status, 409);
  } finally {
    s.close();
  }
});

test("the block status the UI receives never overwrites the block's current state", async () => {
  const s = await start();
  try {
    const p = await (await s.call("POST", "/api/projects", { name: "Estado" })).json();
    await s.call("PUT", `/api/projects/${p.id}`, { scenes: [{ id: "s", title: "C", blocks: [{ id: "b", prompt: "a", currentState: "The gate stands open." }] }] });
    // A interface devolve o projeto como recebeu, com `state` = status do bloco.
    const seen = await (await fetch(`${s.base}/api/projects/${p.id}`)).json();
    assert.equal(seen.scenes[0].blocks[0].state, "empty");
    const saved = await (await s.call("PUT", `/api/projects/${p.id}`, { scenes: seen.scenes })).json();
    assert.equal(saved.scenes[0].blocks[0].currentState, "The gate stands open.");
    assert.equal(saved.scenes[0].blocks[0].state, "empty");
  } finally {
    s.close();
  }
});

test("projects saved with the old state field are migrated on load", async () => {
  const { Store } = await import("../server/store.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-mig-"));
  const dir = path.join(root, "projects", "p1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id: "p1", name: "Velho", updatedAt: "x", settings: {}, characters: [], backgrounds: [], previews: [], scenes: [{ id: "s", blocks: [{ id: "a", state: "The gate is open." }, { id: "b", state: "empty" }] }] }));
  const blocks = new Store(root).get("p1").scenes[0].blocks;
  assert.deepEqual(blocks.map((b) => [b.currentState, "state" in b]), [["The gate is open.", false], [undefined, false]]);
});

test("old projects get the new settings with their defaults", async () => {
  const { Store } = await import("../server/store.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-mig-"));
  const dir = path.join(root, "projects", "p1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id: "p1", name: "Velho", updatedAt: "x", settings: { resolution: "720p", judge: true }, characters: [], backgrounds: [], previews: [], scenes: [] }));
  const p = new Store(root).get("p1");
  assert.equal(p.settings.draftResolution, "360p");
  assert.equal(p.settings.resolution, "720p");
  assert.equal(p.settings.judge, true);
  assert.equal(p.settings.learn, true);
  assert.deepEqual(p.memory, []);
});
