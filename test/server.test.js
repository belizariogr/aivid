import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createApp } from "../server/index.js";

const fakeLtx = { status: async () => ({ connected: false, error: "off" }), ensureLocal: async () => {}, assertIdle: async () => {} };

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

    const brief = await fetch(`${s.base}/api/projects/${p.id}/llm-brief`);
    assert.match(brief.headers.get("content-disposition"), /curta\.takes-llm\.json/);
    const briefData = await brief.json();
    assert.equal(briefData.project.characters[0].id, cid);

    const script = JSON.stringify({ format: "takes.scene-script", version: 1, scene: { title: "Chegada", characterIds: ["Ana"], blocks: [{ duration: 10, prompt: "Ana walks in." }, { duration: 20, prompt: "She waits." }] } });
    const check = await (await s.call("POST", `/api/projects/${p.id}/import-script`, { text: script, validateOnly: true })).json();
    assert.equal(check.scenes[0].blocks.length, 2);
    const imported = await (await s.call("POST", `/api/projects/${p.id}/import-script`, { text: script })).json();
    assert.equal(imported.project.scenes[0].title, "Chegada");
    assert.deepEqual(imported.project.scenes[0].characterIds, [cid]);
    assert.equal(imported.project.scenes[0].blocks[0].state, "empty");

    const bad = await s.call("POST", `/api/projects/${p.id}/import-script`, { text: '{"scene":{"blocks":[{"duration":30,"prompt":"x"}]}}' });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /20s/);

    const gen = await s.call("POST", `/api/projects/${p.id}/scenes/${imported.sceneIds[0]}/export`, {});
    assert.equal(gen.status, 409);
  } finally {
    s.close();
  }
});
