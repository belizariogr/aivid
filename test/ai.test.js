import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/index.js";

const fakeLtx = { status: async () => ({ connected: false, error: "off" }), ensureLocal: async () => {} };

const sseBody = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const stream = (text) =>
  new Response(
    new ReadableStream({
      start(c) {
        // Quebra no meio dos eventos para testar a montagem do buffer.
        for (let i = 0; i < text.length; i += 37) c.enqueue(new TextEncoder().encode(text.slice(i, i + 37)));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const anthropicText = (text) =>
  stream(
    sseBody([
      { type: "message_start", message: { id: "m" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ...text.match(/[\s\S]{1,25}/g).map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]),
  );

function fakeApis(replies) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.startsWith("https://api.anthropic.com/v1/models"))
      return Response.json({
        data: [
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_tokens: 128000, capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } } },
          { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", max_tokens: 64000, capabilities: { thinking: { types: { adaptive: { supported: false } } }, effort: { high: { supported: false } } } },
        ],
      });
    if (url === "https://api.openai.com/v1/models")
      return Response.json({ data: [{ id: "gpt-5.1-codex", created: 3 }, { id: "text-embedding-3-large", created: 2 }, { id: "gpt-4o-mini-tts", created: 2 }, { id: "gpt-5.1", created: 4 }] });
    return replies.shift()();
  };
  return { calls, fetchImpl };
}

async function start(fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "takes-ai-"));
  const app = createApp({ root, ltx: fakeLtx, fetchImpl });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "X-Takes": "1", "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { root, call, close: () => app.server.close() };
}

async function finished(s, projectId) {
  for (let i = 0; i < 200; i++) {
    const { data } = await s.call("GET", `/api/projects/${projectId}/ai-script`);
    if (data[0] && data[0].status !== "running") return data[0];
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("a geração não terminou");
}

const script = (scenes) => JSON.stringify({ format: "takes.scene-script", version: 1, scenes });

test("stores API keys privately and lists text models of each provider", async () => {
  const { fetchImpl } = fakeApis([]);
  const s = await start(fetchImpl);
  try {
    const saved = await s.call("PUT", "/api/ai", { keys: { anthropic: " sk-ant-123456 ", openai: "sk-openai-9876" } });
    assert.deepEqual(saved.data.providers.map((p) => [p.id, p.configured, p.hint]), [["anthropic", true, "…3456"], ["openai", true, "…9876"]]);
    assert.ok(!JSON.stringify(saved.data).includes("sk-ant"));
    const file = path.join(s.root, "ai.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).keys.anthropic, "sk-ant-123456");

    const { data } = await s.call("GET", "/api/ai/models");
    assert.deepEqual(data.models.map((m) => m.id), ["claude-opus-5-5", "claude-haiku-4-5", "gpt-5.1", "gpt-5.1-codex"]);
    assert.deepEqual(data.errors, []);

    const removed = await s.call("PUT", "/api/ai", { keys: { openai: "" } });
    assert.equal(removed.data.providers[1].configured, false);
  } finally {
    s.close();
  }
});

test("generates the full script with Claude, repairing an invalid first answer", async () => {
  const bad = script([{ title: "Chegada", blocks: [{ duration: 30, prompt: "Ana walks in." }] }]);
  const good = script([
    { title: "Chegada", characterIds: ["Ana"], blocks: [{ duration: 10, continuity: "cut", prompt: "Ana walks in." }, { duration: 8, prompt: "She sits." }] },
    { title: "Saída", blocks: [{ duration: 6, prompt: "Ana leaves." }] },
  ]);
  const { calls, fetchImpl } = fakeApis([() => anthropicText("Aqui está:\n```json\n" + bad + "\n```"), () => anthropicText(good)]);
  const s = await start(fetchImpl);
  try {
    await s.call("PUT", "/api/ai", { keys: { anthropic: "sk-ant-1" }, model: { provider: "anthropic", id: "claude-opus-5-5" }, effort: "xhigh", defaults: { resolution: "1080p", judge: true } });
    const p = (await s.call("POST", "/api/projects", { name: "Curta" })).data;
    assert.equal(p.settings.resolution, "1080p", "projeto novo usa os padrões das Configurações");
    assert.equal(p.settings.judge, true);
    await s.call("POST", `/api/projects/${p.id}/characters`, { name: "Ana" });
    const started = await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "ANA entra no café. Depois sai.", seconds: 30 });
    assert.equal(started.status, 200);
    const task = await finished(s, p.id);
    assert.equal(task.status, "complete", task.error);
    assert.equal(task.attempt, 2);

    const sent = calls.filter((c) => c.url.endsWith("/v1/messages"));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].opts.headers["x-api-key"], "sk-ant-1");
    assert.equal(sent[0].opts.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(sent[0].body.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(sent[0].body.output_config.effort, "xhigh");
    assert.match(sent[0].body.system, /ANA|Ana/);
    assert.match(sent[0].body.messages[0].content, /<script>\nANA entra no café/);
    assert.match(sent[0].body.messages[0].content, /about 30 seconds/);
    assert.equal(sent[1].body.messages[1].role, "assistant");
    assert.match(sent[1].body.messages[2].content, /20s/);

    // Importa sozinho quando a resposta passa na validação.
    assert.equal(task.imported.scenes, 2);
    assert.equal(task.imported.mode, "append");
    const project = (await s.call("GET", `/api/projects/${p.id}`)).data;
    assert.deepEqual(project.scenes.map((x) => x.title), ["Chegada", "Saída"]);
    assert.deepEqual(task.imported.sceneIds, project.scenes.map((x) => x.id));
    const settings = await s.call("GET", "/api/ai");
    assert.deepEqual(settings.data.model, { provider: "anthropic", id: "claude-opus-5-5" });
    assert.equal(settings.data.effort, "xhigh");
  } finally {
    s.close();
  }
});

test("generates with OpenAI and reports model errors", async () => {
  const good = script([{ title: "Única", blocks: [{ duration: 12, prompt: "A quiet street at night." }] }]);
  const openaiText = (text) =>
    stream(sseBody([{ type: "response.created" }, ...text.match(/[\s\S]{1,30}/g).map((d) => ({ type: "response.output_text.delta", delta: d })), { type: "response.completed", response: {} }]));
  const { calls, fetchImpl } = fakeApis([() => openaiText(good), () => Response.json({ error: { message: "Incorrect API key" } }, { status: 401 })]);
  const s = await start(fetchImpl);
  try {
    const p = (await s.call("POST", "/api/projects", { name: "Rua" })).data;
    const noModel = await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "x" });
    assert.equal(noModel.status, 400);
    assert.match(noModel.data.error, /Configurações/);
    await s.call("PUT", "/api/ai", { keys: { openai: "sk-openai-1" }, model: { provider: "openai", id: "gpt-5.1-codex" } });
    await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "Uma rua vazia.", mode: "replace" });
    const task = await finished(s, p.id);
    assert.equal(task.status, "complete", task.error);
    const sent = calls.find((c) => c.url.endsWith("/v1/responses"));
    assert.equal(sent.opts.headers.authorization, "Bearer sk-openai-1");
    assert.equal(sent.body.model, "gpt-5.1-codex");
    assert.equal(sent.body.input[0].role, "user");
    assert.match(sent.body.instructions, /takes\.scene-script/);
    assert.equal(task.imported.mode, "replace");

    await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "Outra rua." });
    const failed = await finished(s, p.id);
    assert.equal(failed.status, "error");
    assert.match(failed.error, /chave de API recusada/);

    // Um modelo sem chave não fica salvo.
    const view = (await s.call("PUT", "/api/ai", { model: { provider: "anthropic", id: "claude-opus-5-5" } })).data;
    assert.equal(view.model, null);
  } finally {
    s.close();
  }
});

test("the continuity reviewer sends the rendered frames and validates the reply", async () => {
  const { ContinuityReviewer } = await import("../server/review.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takes-review-"));
  const file = (name) => (fs.writeFileSync(path.join(dir, name), "x"), path.join(dir, name));
  const project = {
    prePrompt: "Cardboard",
    characters: [{ id: "teca", name: "Teca" }],
    backgrounds: [{ id: "praca", name: "Praça", description: "square with a closed gate", image: file("praca.png") }],
  };
  const take = (id) => ({ id, file: file(`${id}.mp4`) });
  const scene = {
    title: "Portão",
    backgroundId: "praca",
    blocks: [
      { id: "b1", prompt: "Wide, Teca opens the gate", duration: 6, continuity: "cut", takes: [take("t1")], selectedTakeId: "t1" },
      { id: "b2", prompt: "Close-up of Teca", duration: 4, continuity: "continue", takes: [take("t2")], selectedTakeId: "t2" },
      { id: "b3", prompt: "Wide shot of the square", duration: 5, continuity: "cut", start: { kind: "scene" }, takes: [], selectedTakeId: null },
    ],
  };
  const replies = [
    "not json",
    JSON.stringify({ decision: "change", continuity: "cut", start: "block:1", prompt: "Wide shot; the gate stands wide open.", note: "Portão aberto.", reason: "A imagem da cena mostra o portão fechado." }),
  ];
  const bodies = [];
  const fetchImpl = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return anthropicText(replies.shift());
  };
  const stills = [];
  const media = { still: async (input, output, o) => (stills.push([path.basename(input), Boolean(o.last)]), fs.writeFileSync(output, "jpg"), output) };
  const settings = { data: { model: { provider: "anthropic", id: "claude-opus-5-5" } }, key: () => "sk-test" };
  const writer = { resolveModel: async (provider, id) => ({ provider, id, name: "Claude Opus 5.5", effort: true, adaptive: true }) };
  const reviewer = new ContinuityReviewer({ settings, writer, media, fetchImpl });

  const r = await reviewer.review({ project, scene, index: 2, work: dir, startImage: project.backgrounds[0].image });
  assert.equal(r.changed, true);
  assert.deepEqual(r.block.start, { kind: "block", id: "b1" });
  assert.equal(r.block.prompt, "Wide shot; the gate stands wide open.");
  assert.match(r.model, /Opus 5.5/);
  // Últimos quadros reais dos blocos 1 e 2, a imagem planejada (a da cena) e o fundo.
  assert.deepEqual(stills, [["t1.mp4", true], ["t2.mp4", true], ["praca.png", false], ["praca.png", false]]);
  const content = bodies[0].messages[0].content;
  assert.equal(content.filter((c) => c.type === "image").length, 4);
  assert.equal(content.find((c) => c.type === "image").source.media_type, "image/jpeg");
  assert.match(content[0].text, /"next": true/);
  assert.equal(bodies[0].output_config.effort, "medium");
  assert.match(bodies[0].system, /continuity supervisor/);
  // A resposta inválida volta para a LLM corrigir uma vez.
  assert.equal(bodies[1].messages.length, 3);

  // Apontar para um bloco que ainda não foi gerado é recusado.
  replies.push(JSON.stringify({ continuity: "cut", start: "block:3", prompt: "x" }), JSON.stringify({ continuity: "cut", start: "block:3", prompt: "x" }));
  await assert.rejects(reviewer.review({ project, scene, index: 2, work: dir }), /resposta inválida/);
});

test("the judge sees the take, the previous block and the character references", async () => {
  const { ContinuityReviewer } = await import("../server/review.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takes-judge-"));
  const file = (name) => (fs.writeFileSync(path.join(dir, name), "x"), path.join(dir, name));
  const project = {
    prePrompt: "",
    characters: [{ id: "teca", name: "Teca", photo: file("teca.png"), refs: [{ view: "body", file: file("teca-body.png") }] }],
    backgrounds: [],
  };
  const scene = {
    title: "Portão",
    characterIds: ["teca"],
    blocks: [
      { id: "b1", prompt: "Teca opens the gate", duration: 6, continuity: "cut", takes: [{ id: "t1", file: file("t1.mp4") }], selectedTakeId: "t1" },
      { id: "b2", prompt: "Teca walks in", currentState: "The gate is open.", duration: 4, continuity: "continue", characterIds: null, takes: [{ id: "t2", file: file("t2.mp4") }], selectedTakeId: "t2" },
    ],
  };
  const replies = [JSON.stringify({ pass: false, score: 4, problems: ["O portão aparece fechado."], reason: "Estado errado." })];
  const bodies = [];
  const fetchImpl = async (url, opts) => (bodies.push(JSON.parse(opts.body)), anthropicText(replies.shift()));
  const stills = [];
  const media = {
    probe: async () => ({ duration: 4, fps: 24, frames: 96 }),
    still: async (input, output, o) => (stills.push([path.basename(input), o.last ? "last" : o.time ?? "image"]), fs.writeFileSync(output, "jpg"), output),
  };
  const reviewer = new ContinuityReviewer({
    settings: { data: { model: { provider: "anthropic", id: "claude-opus-5-5" } }, key: () => "k" },
    writer: { resolveModel: async (provider, id) => ({ provider, id, name: "Opus" }) },
    media,
    fetchImpl,
  });
  const v = await reviewer.judge({ project, scene, index: 1, take: scene.blocks[1].takes[0], work: dir });
  assert.deepEqual([v.pass, v.score, v.problems], [false, 4, ["O portão aparece fechado."]]);
  assert.deepEqual(stills, [["t1.mp4", "last"], ["t2.mp4", 0], ["t2.mp4", 2], ["t2.mp4", "last"], ["teca.png", "image"], ["teca-body.png", "image"]]);
  assert.match(bodies[0].messages[0].content[0].text, /State that must hold: The gate is open\./);
  assert.match(bodies[0].system, /quality judge/);
});

test("the stream reports that the model received the script and is thinking", async () => {
  const { ask } = await import("../server/ai.js");
  const body = sseBody([
    { type: "message_start", message: { id: "m" } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Dividindo o roteiro em cenas." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "{}" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]);
  const seen = [];
  const text = await ask("anthropic", {
    key: "k",
    model: { id: "claude-opus-5-5", adaptive: true },
    system: "s",
    messages: [],
    fetchImpl: async () => stream(body),
    onText: (t, kind, thought) => seen.push([kind, thought ?? null, t]),
  });
  assert.equal(text, "{}");
  assert.deepEqual(seen, [
    ["received", null, ""],
    ["thinking", "", ""],
    ["thinking", "Dividindo o roteiro em cenas.", ""],
    ["thinking", "", ""],
    ["writing", null, "{}"],
  ]);
});

test("the reviser gets the judge's problems and the rejected frames", async () => {
  const { ContinuityReviewer } = await import("../server/review.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takes-revise-"));
  const file = (name) => (fs.writeFileSync(path.join(dir, name), "x"), path.join(dir, name));
  const project = { prePrompt: "", characters: [], backgrounds: [] };
  const scene = {
    title: "Portão",
    characterIds: [],
    start: { kind: "keyframe", id: "k", ref: { kind: "none", id: null } },
    blocks: [{ id: "a", prompt: "Teca and the gate", opening: "wide", duration: 6, continuity: "cut", takes: [{ id: "t1", file: file("t1.mp4"), startImage: file("open.png") }], selectedTakeId: "t1" }],
  };
  const bodies = [];
  const fetchImpl = async (url, opts) => (bodies.push(JSON.parse(opts.body)), anthropicText(JSON.stringify({ decision: "change", prompt: "Teca pushes the gate open.", state: "The gate stands open.", regenerateOpening: true, reason: "Ação ambígua." })));
  const media = { probe: async () => ({ duration: 6 }), still: async (i, o) => (fs.writeFileSync(o, "jpg"), o) };
  const reviewer = new ContinuityReviewer({
    settings: { data: { model: { provider: "anthropic", id: "claude-opus-5-5" } }, key: () => "k" },
    writer: { resolveModel: async (provider, id) => ({ provider, id, name: "Opus" }) },
    media,
    fetchImpl,
  });
  const r = await reviewer.revise({ project, scene, index: 0, take: scene.blocks[0].takes[0], verdict: { score: 3, reason: "não abriu", problems: ["O portão segue fechado."] }, work: dir });
  assert.equal(r.changed, true);
  assert.equal(r.regenerateOpening, true, "a cena abre com imagem gerada");
  assert.equal(r.block.prompt, "Teca pushes the gate open.");
  assert.equal(r.block.currentState, "The gate stands open.");
  assert.equal(r.block.continuity, "cut", "o 1º bloco mantém a ligação");
  const text = bodies[0].messages[0].content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.match(text, /O portão segue fechado/);
  assert.match(text, /Rejected take, middle frame/);
  assert.match(bodies[0].system, /quality judge just rejected/);
});

test("the reviser can give the first block of a scene a generated opening", async () => {
  const { ContinuityReviewer } = await import("../server/review.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takes-revise-"));
  const file = (name) => (fs.writeFileSync(path.join(dir, name), "x"), path.join(dir, name));
  const project = { prePrompt: "", characters: [], backgrounds: [{ id: "praca", name: "Praça", description: "square", image: file("bg.png") }] };
  const scene = {
    title: "Portão",
    backgroundId: "praca",
    characterIds: [],
    start: { kind: "background", id: "praca" },
    blocks: [{ id: "a", prompt: "Teca and the gate", duration: 6, continuity: "cut", takes: [{ id: "t1", file: file("t1.mp4") }], selectedTakeId: "t1" }],
  };
  const fetchImpl = async () => anthropicText(JSON.stringify({ decision: "change", start: "keyframe", opening: "Wide shot: Teca stands by the gate, Pingo above her.", prompt: "Teca waves.", reason: "Abertura sem personagens." }));
  const reviewer = new ContinuityReviewer({
    settings: { data: { model: { provider: "anthropic", id: "claude-opus-5-5" } }, key: () => "k" },
    writer: { resolveModel: async (provider, id) => ({ provider, id, name: "Opus" }) },
    media: { probe: async () => ({ duration: 6 }), still: async (i, o) => (fs.writeFileSync(o, "jpg"), o) },
    fetchImpl,
  });
  const r = await reviewer.revise({ project, scene, index: 0, take: scene.blocks[0].takes[0], verdict: { score: 3, problems: [] }, work: dir });
  assert.deepEqual(r.sceneStart, { kind: "keyframe", id: null, ref: { kind: "background", id: "praca" } });
  assert.equal(r.block.opening, "Wide shot: Teca stands by the gate, Pingo above her.");
  assert.equal(r.changed, true);
});
