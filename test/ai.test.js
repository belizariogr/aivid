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
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_tokens: 128000, capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { high: { supported: true } } } },
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
    await s.call("PUT", "/api/ai", { keys: { anthropic: "sk-ant-1" } });
    const p = (await s.call("POST", "/api/projects", { name: "Curta" })).data;
    await s.call("POST", `/api/projects/${p.id}/characters`, { name: "Ana" });
    const started = await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "ANA entra no café. Depois sai.", seconds: 30, provider: "anthropic", model: "claude-opus-5-5" });
    assert.equal(started.status, 200);
    const task = await finished(s, p.id);
    assert.equal(task.status, "complete", task.error);
    assert.equal(task.attempt, 2);

    const sent = calls.filter((c) => c.url.endsWith("/v1/messages"));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].opts.headers["x-api-key"], "sk-ant-1");
    assert.equal(sent[0].opts.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert.equal(sent[0].body.stream, true);
    assert.deepEqual(sent[0].body.thinking, { type: "adaptive" });
    assert.equal(sent[0].body.output_config.effort, "high");
    assert.match(sent[0].body.system, /ANA|Ana/);
    assert.match(sent[0].body.messages[0].content, /<script>\nANA entra no café/);
    assert.match(sent[0].body.messages[0].content, /about 30 seconds/);
    assert.equal(sent[1].body.messages[1].role, "assistant");
    assert.match(sent[1].body.messages[2].content, /20s/);

    const imported = await s.call("POST", `/api/projects/${p.id}/import-script`, { text: task.text });
    assert.deepEqual(imported.data.project.scenes.map((x) => x.title), ["Chegada", "Saída"]);
    const settings = await s.call("GET", "/api/ai");
    assert.deepEqual(settings.data.model, { provider: "anthropic", id: "claude-opus-5-5" });
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
    await s.call("PUT", "/api/ai", { keys: { openai: "sk-openai-1" } });
    const p = (await s.call("POST", "/api/projects", { name: "Rua" })).data;
    await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "Uma rua vazia.", provider: "openai", model: "gpt-5.1-codex" });
    const task = await finished(s, p.id);
    assert.equal(task.status, "complete", task.error);
    const sent = calls.find((c) => c.url.endsWith("/v1/responses"));
    assert.equal(sent.opts.headers.authorization, "Bearer sk-openai-1");
    assert.equal(sent.body.model, "gpt-5.1-codex");
    assert.equal(sent.body.input[0].role, "user");
    assert.match(sent.body.instructions, /takes\.scene-script/);

    await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "Outra rua.", provider: "openai", model: "gpt-5.1" });
    const failed = await finished(s, p.id);
    assert.equal(failed.status, "error");
    assert.match(failed.error, /chave de API recusada/);

    const noKey = await s.call("POST", `/api/projects/${p.id}/ai-script`, { script: "x", provider: "anthropic", model: "claude-opus-5-5" });
    assert.equal(noKey.status, 400);
    assert.match(noKey.data.error, /Cadastre a chave/);
  } finally {
    s.close();
  }
});
