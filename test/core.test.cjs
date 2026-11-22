const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  Store,
  normalizeProject,
  splitScenes,
  buildPrompt,
} = require("../src/core.cjs");
const { byteRange, playlist, mediaResponse } = require("../src/media.cjs");
function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aivid-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("projeto preserva imagens e duração das cenas ao salvar, sem aceitar caminhos do formulário", (t) => {
  const store = new Store(temp(t));
  let p = store.upsert({
    name: "História",
    scenes: [{ name: "Abertura", prompt: "Teca sorri", duration: 8 }],
  });
  p.characters.push({
    id: "teca",
    name: "Teca",
    description: "Capivara de jardineira verde",
    image: "/private/reference.png",
  });
  p.scenes[0].image = "/private/scene.png";
  p.outputDir = "/chosen/output";
  const id = p.scenes[0].id;
  p = store.upsert({
    ...p,
    characters: [],
    outputDir: "/forged",
    scenes: [
      {
        ...p.scenes[0],
        image: "/forged.png",
        characterIds: ["teca", "invalid"],
        prompt: "Teca aponta",
      },
    ],
  });
  assert.equal(p.scenes[0].id, id);
  assert.equal(p.scenes[0].image, "/private/scene.png");
  assert.equal(p.outputDir, "/chosen/output");
  assert.equal(p.characters.length, 1);
  assert.deepEqual(p.scenes[0].characterIds, ["teca"]);
  assert.equal(p.scenes[0].duration, 8);
  const restored = new Store(store.root);
  assert.equal(restored.project(p.id).scenes[0].prompt, "Teca aponta");
});
test("valida parâmetros e prompts vazios", () => {
  assert.throws(() => normalizeProject({ name: " " }));
  assert.throws(() =>
    normalizeProject({ name: "A", settings: { duration: 21 } }),
  );
  assert.throws(() => normalizeProject({ name: "A", settings: { seed: -1 } }));
  assert.throws(() => splitScenes(" "));
  assert.deepEqual(splitScenes("Primeira\n---\nSegunda"), [
    "Primeira",
    "Segunda",
  ]);
});
test("prompt usa somente personagens selecionados e mantém contexto", () => {
  const p = {
    description: "Vila de papelão",
    characters: [
      { id: "1", name: "Teca", description: "capivara verde" },
      { id: "2", name: "Pingo", description: "beija-flor" },
    ],
  };
  const result = buildPrompt(p, "Teca sorri", ["1"]);
  assert.match(result, /Vila de papelão/);
  assert.match(result, /Teca: capivara verde/);
  assert.doesNotMatch(result, /Pingo/);
  assert.match(result, /No on-screen text/);
});
test("recuperação após fechamento não repete trabalhos incompletos", (t) => {
  const store = new Store(temp(t));
  store.data.jobs = [
    { id: "1", status: "running" },
    { id: "2", status: "queued" },
    { id: "3", status: "complete" },
  ];
  store.save();
  assert.deepEqual(
    new Store(store.root).data.jobs.map((j) => j.status),
    ["interrupted", "interrupted", "complete"],
  );
});
test("requisições de faixa do player suportam busca e rejeitam faixas inválidas", () => {
  assert.deepEqual(byteRange("bytes=2-6", 10), { start: 2, end: 6 });
  assert.deepEqual(byteRange("bytes=5-", 10), { start: 5, end: 9 });
  assert.deepEqual(byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(byteRange("bytes=0-999", 10), { start: 0, end: 9 });
  for (const h of [
    "bytes=10-",
    "bytes=7-2",
    "bytes=-0",
    "bytes=1-2,5-6",
    "bad",
  ])
    assert.equal(byteRange(h, 10), false);
});
test("player serve somente os bytes pedidos sem transcodificar o clipe", async (t) => {
  const p = path.join(temp(t), "clip.mp4");
  fs.writeFileSync(p, "0123456789");
  const r = mediaResponse(
    p,
    new Request("http://local/clip", { headers: { range: "bytes=3-5" } }),
  );
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 3-5/10");
  assert.equal(await r.text(), "345");
});
test("playlist usa ordem atual das cenas e última versão gerada de cada uma", (t) => {
  const root = temp(t);
  const a = path.join(root, "a.mp4"),
    b = path.join(root, "b.mp4");
  fs.writeFileSync(a, "a");
  fs.writeFileSync(b, "b");
  const project = {
    id: "p",
    scenes: [
      { id: "s2", name: "Depois" },
      { id: "s1", name: "Antes" },
      { id: "s3", name: "Falta" },
    ],
  };
  const jobs = [
    { projectId: "p", scenes: [{ id: "s1" }, { id: "s2" }], files: [a, a] },
    { projectId: "p", scenes: [{ id: "s1" }], files: [b] },
  ];
  const rows = playlist(project, jobs);
  assert.deepEqual(
    rows.map((r) => r.title),
    ["Depois", "Antes", "Falta"],
  );
  assert.equal(rows[1].file, b);
  assert.equal(rows[2].file, null);
});
