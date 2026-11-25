// Roteiro automático por API: chaves dos provedores, modelos disponíveis e geração em segundo plano.
import fs from "node:fs";
import { newId } from "./store.js";
import { fullScriptRequest, repairRequest, parseScript, extractJson } from "./llm.js";

export const PROVIDERS = {
  anthropic: { name: "Claude (Anthropic)", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { name: "OpenAI (ChatGPT / Codex)", keyUrl: "https://platform.openai.com/api-keys" },
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2026-10-21";
// Modelos com recusa por classificador de segurança: o próprio servidor da Anthropic refaz
// a resposta em outro modelo em vez de só recusar.
const ANTHROPIC_FALLBACK = new Set(["claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const OPENAI_URL = "https://api.openai.com/v1";
// A lista da OpenAI traz também modelos de imagem, áudio e embeddings; ficam só os de texto.
const OPENAI_TEXT = /^(gpt-|o\d|chatgpt-|codex)/;
const OPENAI_SKIP = /(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct|gpt-3\.5)/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export class AiSettings {
  constructor(file) {
    this.file = file;
    this.data = { keys: {}, model: null };
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      this.data = { keys: raw.keys && typeof raw.keys === "object" ? raw.keys : {}, model: raw.model ?? null };
    } catch {
      /* ainda não configurado */
    }
  }

  key(provider) {
    return typeof this.data.keys[provider] === "string" ? this.data.keys[provider] : "";
  }

  // Nunca devolve a chave para a interface, só os últimos caracteres.
  view() {
    return {
      providers: Object.entries(PROVIDERS).map(([id, p]) => {
        const key = this.key(id);
        return { id, name: p.name, keyUrl: p.keyUrl, configured: Boolean(key), hint: key ? `…${key.slice(-4)}` : "" };
      }),
      model: this.data.model,
    };
  }

  update({ keys, model } = {}) {
    if (keys && typeof keys === "object") {
      for (const [id, value] of Object.entries(keys)) {
        if (!PROVIDERS[id] || typeof value !== "string") continue;
        const key = value.trim();
        if (key) this.data.keys[id] = key;
        else delete this.data.keys[id];
      }
    }
    if (model !== undefined) {
      this.data.model = model && PROVIDERS[model.provider] && typeof model.id === "string" ? { provider: model.provider, id: model.id } : null;
    }
    if (this.data.model && !this.key(this.data.model.provider)) this.data.model = null;
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.view();
  }
}

async function apiError(res, provider) {
  const data = await res.json().catch(() => ({}));
  const detail = data?.error?.message || data?.message || res.statusText;
  const name = PROVIDERS[provider].name;
  if (res.status === 401 || res.status === 403) return fail(`${name}: chave de API recusada (${detail}).`, 401);
  if (res.status === 429) return fail(`${name}: limite de uso atingido. Tente de novo em alguns minutos (${detail}).`, 429);
  return fail(`${name}: erro ${res.status} (${detail}).`, 502);
}

// Lê um corpo text/event-stream e devolve o JSON de cada evento.
async function* sse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

const anthropicHeaders = (key) => ({ "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" });

async function anthropicModels(key, fetchImpl) {
  const res = await fetchImpl(`${ANTHROPIC_URL}/models?limit=1000`, { headers: anthropicHeaders(key) });
  if (!res.ok) throw await apiError(res, "anthropic");
  const { data = [] } = await res.json();
  return data.map((m) => ({
    provider: "anthropic",
    id: m.id,
    name: m.display_name || m.id,
    maxTokens: Number(m.max_tokens) || null,
    adaptive: Boolean(m.capabilities?.thinking?.types?.adaptive?.supported),
    effort: Boolean(m.capabilities?.effort?.high?.supported),
  }));
}

async function openaiModels(key, fetchImpl) {
  const res = await fetchImpl(`${OPENAI_URL}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw await apiError(res, "openai");
  const { data = [] } = await res.json();
  return data
    .filter((m) => OPENAI_TEXT.test(m.id) && !OPENAI_SKIP.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => ({ provider: "openai", id: m.id, name: m.id }));
}

// Respostas longas vão por streaming: um roteiro inteiro passa do tempo limite de uma resposta comum.
async function streamAnthropic({ key, model, system, messages, signal, onText, fetchImpl, effort = "high" }) {
  const body = {
    model: model.id,
    max_tokens: Math.min(model.maxTokens || 64000, 64000),
    stream: true,
    cache_control: { type: "ephemeral" },
    system,
    messages,
  };
  // Sem "summarized", os modelos novos pensam em silêncio (display "omitted"): nenhum texto chega
  // durante o planejamento e a interface parece travada.
  if (model.adaptive) body.thinking = { type: "adaptive", display: "summarized" };
  if (model.effort) body.output_config = { effort };
  const headers = anthropicHeaders(key);
  if (ANTHROPIC_FALLBACK.has(model.id)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const res = await fetchImpl(`${ANTHROPIC_URL}/messages`, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw await apiError(res, "anthropic");
  let text = "";
  let stop = null;
  for await (const ev of sse(res.body)) {
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      text += ev.delta.text;
      onText(text, "writing");
    } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") onText(text, "thinking", ev.delta.thinking ?? "");
    else if (ev.type === "message_start") onText(text, "received");
    else if ((ev.type === "content_block_start" && ev.content_block?.type === "thinking") || ev.delta?.type === "signature_delta") onText(text, "thinking", "");
    else if (ev.type === "message_delta") stop = ev.delta?.stop_reason ?? stop;
    else if (ev.type === "error") throw fail(`Claude: ${ev.error?.message || "erro no streaming"}.`, 502);
  }
  if (stop === "refusal") throw fail("O modelo recusou o pedido. Revise o roteiro ou escolha outro modelo.", 422);
  if (stop === "max_tokens") throw fail("A resposta passou do limite de tamanho do modelo. Divida o roteiro em partes menores.", 422);
  return text;
}

async function streamOpenai({ key, model, system, messages, signal, onText, fetchImpl }) {
  const body = { model: model.id, instructions: system, input: messages, stream: true, store: false };
  const res = await fetchImpl(`${OPENAI_URL}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await apiError(res, "openai");
  let text = "";
  for await (const ev of sse(res.body)) {
    if (ev.type === "response.output_text.delta") {
      text += ev.delta;
      onText(text, "writing");
    } else if (ev.type === "response.reasoning_summary_text.delta") onText(text, "thinking", ev.delta ?? "");
    else if (ev.type === "response.created" || ev.type === "response.in_progress") onText(text, "received");
    else if (ev.type === "response.incomplete") {
      const reason = ev.response?.incomplete_details?.reason;
      if (reason === "max_output_tokens") throw fail("A resposta passou do limite de tamanho do modelo. Divida o roteiro em partes menores.", 422);
      throw fail(`OpenAI: resposta incompleta (${reason || "motivo desconhecido"}).`, 422);
    } else if (ev.type === "response.failed") throw fail(`OpenAI: ${ev.response?.error?.message || "a geração falhou"}.`, 502);
    else if (ev.type === "error") throw fail(`OpenAI: ${ev.message || ev.error?.message || "erro no streaming"}.`, 502);
  }
  return text;
}

const STREAM = { anthropic: streamAnthropic, openai: streamOpenai };

// Mensagem do usuário com texto e imagens no formato de cada provedor.
// `parts`: [{ text }] ou [{ image: { mediaType, data } }] (data em base64).
export function userMessage(provider, parts) {
  const content = parts.map((part) => {
    if (part.image) {
      const { mediaType, data } = part.image;
      return provider === "openai"
        ? { type: "input_image", image_url: `data:${mediaType};base64,${data}` }
        : { type: "image", source: { type: "base64", media_type: mediaType, data } };
    }
    return provider === "openai" ? { type: "input_text", text: part.text } : { type: "text", text: part.text };
  });
  return { role: "user", content };
}

// Uma resposta completa (com streaming por baixo, que não estoura o tempo limite).
export function ask(provider, opts) {
  return STREAM[provider]({ onText: () => {}, ...opts });
}
const LIST = { anthropic: anthropicModels, openai: openaiModels };

export class ScriptWriter {
  constructor({ settings, store, fetchImpl = fetch, onChange = () => {} }) {
    this.settings = settings;
    this.store = store;
    this.fetch = fetchImpl;
    this.onChange = onChange;
    this.models = new Map(); // provedor -> { key, list }
    this.tasks = new Map();
  }

  // Lista os modelos de todos os provedores com chave. Um provedor com erro não esconde os outros.
  async listModels({ refresh = false } = {}) {
    const models = [];
    const errors = [];
    await Promise.all(
      Object.keys(PROVIDERS).map(async (provider) => {
        const key = this.settings.key(provider);
        if (!key) return;
        const cached = this.models.get(provider);
        if (!refresh && cached?.key === key) return models.push(...cached.list);
        try {
          const list = await LIST[provider](key, this.fetch);
          this.models.set(provider, { key, list });
          models.push(...list);
        } catch (error) {
          errors.push({ provider, error: error.message });
        }
      }),
    );
    const order = Object.keys(PROVIDERS);
    models.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
    return { models, errors };
  }

  async resolveModel(provider, id) {
    if (!PROVIDERS[provider]) throw fail("Escolha um modelo.");
    if (!this.settings.key(provider)) throw fail(`Cadastre a chave de API de ${PROVIDERS[provider].name}.`);
    await this.listModels();
    const model = this.models.get(provider)?.list.find((m) => m.id === id);
    return model ?? { provider, id };
  }

  // O texto só vai para a interface no fim, para os eventos de progresso ficarem leves.
  view(task) {
    const { abort, text, ...rest } = task;
    return task.status === "running" ? rest : { ...rest, text };
  }

  list(projectId) {
    return [...this.tasks.values()].filter((t) => !projectId || t.projectId === projectId).map((t) => this.view(t));
  }

  emit(task) {
    task.updatedAt = Date.now();
    this.onChange(this.view(task));
  }

  ensureIdle(projectId) {
    if ([...this.tasks.values()].some((t) => t.projectId === projectId && t.status === "running"))
      throw fail("Já há um roteiro sendo gerado para este projeto.", 409);
  }

  async start(projectId, { script, seconds, provider, model: modelId }) {
    this.store.get(projectId);
    if (!String(script || "").trim()) throw fail("Cole o roteiro completo.");
    this.ensureIdle(projectId);
    const model = await this.resolveModel(provider, modelId);
    this.ensureIdle(projectId);
    const task = {
      id: newId(),
      projectId,
      provider,
      model: model.id,
      modelName: model.name || model.id,
      status: "running",
      phase: "Enviando o roteiro…",
      thought: "",
      chars: 0,
      attempt: 1,
      text: "",
      error: null,
      startedAt: Date.now(),
      abort: new AbortController(),
    };
    this.tasks.set(task.id, task);
    for (const t of this.tasks.values()) if (t.projectId === projectId && t.id !== task.id && t.status !== "running") this.tasks.delete(t.id);
    this.emit(task);
    this.run(task, model, { script, seconds: Number(seconds) || null }).catch(() => {});
    return this.view(task);
  }

  async run(task, model, input) {
    const project = this.store.get(task.projectId);
    const { system, user } = fullScriptRequest(project, input);
    const messages = [{ role: "user", content: user }];
    let last = 0;
    const onText = (text, kind, thought = "") => {
      task.chars = text.length;
      const fixing = task.attempt > 1;
      if (text) task.phase = fixing ? "Corrigindo o roteiro…" : "Escrevendo as cenas…";
      else if (kind === "received") task.phase = fixing ? "O modelo recebeu os problemas e está pensando na correção…" : "O modelo recebeu o roteiro e está pensando…";
      else if (kind === "thinking") task.phase = fixing ? "Planejando a correção…" : "Planejando as cenas…";
      // Fim do resumo do raciocínio, para a interface mostrar no que o modelo está pensando.
      if (thought) task.thought = (task.thought + thought).replace(/\s+/g, " ").slice(-240);
      if (Date.now() - last > 400) {
        last = Date.now();
        this.emit(task);
      }
    };
    try {
      for (;;) {
        const text = await STREAM[task.provider]({ key: this.settings.key(task.provider), model, system, messages, signal: task.abort.signal, onText, fetchImpl: this.fetch });
        // A resposta fica disponível mesmo com erro, para o usuário corrigir à mão.
        task.text = text;
        let errors;
        try {
          const data = extractJson(text);
          parseScript(this.store.get(task.projectId), data, { strict: true });
          task.text = JSON.stringify(data, null, 2);
          break;
        } catch (error) {
          errors = error.details ?? [error.message];
        }
        // Uma tentativa de correção: devolve os problemas à LLM junto com a resposta anterior.
        if (task.attempt >= 2) throw fail(`O roteiro gerado ainda tem problemas:\n${errors.join("\n")}`, 422);
        task.attempt += 1;
        task.phase = "Enviando os problemas para o modelo corrigir…";
        task.thought = "";
        this.emit(task);
        messages.push({ role: "assistant", content: text }, { role: "user", content: repairRequest(errors) });
      }
      task.status = "complete";
      task.phase = "Pronto";
    } catch (error) {
      task.status = task.abort.signal.aborted ? "canceled" : "error";
      task.error = task.abort.signal.aborted ? "Cancelado." : error.message;
      task.phase = "";
    }
    this.emit(task);
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) throw fail("Tarefa não encontrada.", 404);
    if (task.status === "running") task.abort.abort();
    return this.view(task);
  }
}
