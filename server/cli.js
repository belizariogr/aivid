// Ferramentas de linha de comando com assinatura (Claude Code, Codex e Cursor): usar o modelo pelo
// login do usuário em vez de uma chave de API. Cada chamada roda o CLI sem interação, sem
// ferramentas e numa pasta temporária, e devolve o texto final.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const found = new Map();

// Procura o executável nos lugares comuns e no PATH do shell de login (o app do Mac é aberto
// pelo Finder, sem o PATH do terminal). Atalhos quebrados não contam.
export function findCli(bin) {
  if (found.has(bin)) return found.get(bin);
  const dirs = [path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global/bin"), path.join(home, ".bun/bin"), ...(process.env.PATH || "").split(":")];
  let file = dirs.map((d) => d && path.join(d, bin)).find((f) => f && usable(f)) ?? null;
  if (!file) {
    try {
      const out = execFileSync("/bin/zsh", ["-lc", `command -v ${bin}`], { encoding: "utf8", timeout: 4000 }).trim();
      if (out && usable(out)) file = out;
    } catch {
      /* não encontrado */
    }
  }
  found.set(bin, file);
  return file;
}

function usable(file) {
  try {
    fs.accessSync(fs.realpathSync(file), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resetCliCache() {
  found.clear();
}

const fail = (message, status = 502, code) => Object.assign(new Error(message), { status, code });

// Conversa (mensagens no formato do Takes) achatada numa só mensagem: os CLIs recebem um pedido
// por vez. `parts`: [{ text }] | [{ image: { mediaType, data } }].
export function flatten(messages) {
  const parts = [];
  for (const m of messages) {
    const own = m.parts ?? (typeof m.content === "string" ? [{ text: m.content }] : []);
    if (m.role === "assistant") parts.push({ text: `Your previous reply was:\n${own.map((p) => p.text ?? "").join("\n")}` });
    else parts.push(...own);
  }
  return parts;
}

// Sem estas variáveis os CLIs usam o login (assinatura), e não uma chave de API cobrada por token.
function cliEnv() {
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY"]) delete env[k];
  env.PATH = [path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", env.PATH].filter(Boolean).join(":");
  return env;
}

async function workDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "takes-cli-"));
  return dir;
}

// Roda o CLI, entrega `stdin` e chama `onLine` para cada linha de saída. Devolve { code, stderr }.
function run(file, args, { stdin = "", cwd, signal, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) onLine?.(line);
      }
    });
    child.stderr.on("data", (c) => (stderr = (stderr + c.toString("utf8")).slice(-4000)));
    child.on("error", (e) => reject(fail(`Não foi possível rodar ${path.basename(file)}: ${e.message}`)));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (buffer.trim()) onLine?.(buffer.trim());
      if (signal?.aborted) return reject(Object.assign(new Error("Operação cancelada."), { code: "ABORTED" }));
      resolve({ code, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const limitError = (text) => /rate.?limit|usage limit|limit reached|quota|too many requests|429/i.test(text || "");

// ---------- Claude Code ----------
// `claude -p` com entrada e saída em stream-json: as imagens vão como blocos, igual à API.
export async function streamClaudeCode(opts) {
  try {
    return await claudeCodeOnce(opts);
  } catch (error) {
    // Sem créditos de uso (ou modelo sem modo rápido): refaz no modo normal e avisa.
    if (!opts.fast || error.code !== "FAST_UNAVAILABLE") throw error;
    opts.onNotice?.(`Modo rápido indisponível (${error.message}); a chamada seguiu no modo normal.`);
    return claudeCodeOnce({ ...opts, fast: false });
  }
}

async function claudeCodeOnce({ model, system, messages, signal, onText, effort, fast = false }) {
  const file = findCli("claude");
  if (!file) throw fail("Claude Code não encontrado. Instale e faça login com `claude`.", 400);
  const content = flatten(messages).map((p) =>
    p.image ? { type: "image", source: { type: "base64", media_type: p.image.mediaType, data: p.image.data } } : { type: "text", text: p.text },
  );
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--model", model.id,
    "--system-prompt", system,
    ...(effort ? ["--effort", effort] : []),
    // Modo rápido: na assinatura consome créditos de uso (fora do limite do plano).
    ...(fast ? ["--settings", JSON.stringify({ fastMode: true })] : []),
  ];
  const cwd = await workDir();
  let text = "";
  let result = null;
  let limited = false;
  try {
    const { code, stderr } = await run(file, args, {
      cwd,
      signal,
      stdin: JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      onLine: (line) => {
        const ev = parse(line);
        if (!ev) return;
        if (ev.type === "stream_event") {
          const e = ev.event;
          if (e?.type === "message_start") onText(text, "received");
          else if (e?.type === "content_block_start" && e.content_block?.type === "thinking") onText(text, "thinking", "");
          else if (e?.type === "content_block_delta" && e.delta?.type === "thinking_delta") onText(text, "thinking", e.delta.thinking ?? "");
          else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
            text += e.delta.text;
            onText(text, "writing");
          }
        } else if (ev.type === "rate_limit_event" && /reject|exceed|limited/i.test(JSON.stringify(ev))) limited = true;
        else if (ev.type === "result") result = ev;
      },
    });
    if (!result) {
      const why = stderr.trim().split("\n").slice(-2).join(" ");
      if (fast && /fast mode|usage credits/i.test(why)) throw fail(why, 400, "FAST_UNAVAILABLE");
      throw fail(`O Claude Code parou sem responder (código ${code}). ${why}`);
    }
    if (result.is_error || result.subtype !== "success") {
      const msg = String(result.result || result.subtype || "erro");
      if (fast && /fast mode|usage credits/i.test(msg)) throw fail(msg, 400, "FAST_UNAVAILABLE");
      if (limited || limitError(msg)) throw fail(`Claude Code: limite de uso da assinatura atingido (${msg}).`, 429, "RATE_LIMIT");
      throw fail(`Claude Code: ${msg}`);
    }
    return String(result.result ?? text);
  } finally {
    fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Codex ----------
// `codex exec` lê o pedido do stdin; as imagens vão como arquivos (-i), na ordem em que aparecem.
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export async function streamCodex({ model, system, messages, signal, onText, effort }) {
  const file = findCli("codex");
  if (!file) throw fail("Codex não encontrado. Instale e faça login com `codex`.", 400);
  const cwd = await workDir();
  try {
    const images = [];
    const lines = [system, ""];
    for (const p of flatten(messages)) {
      if (p.image) {
        const f = path.join(cwd, `imagem-${String(images.length + 1).padStart(2, "0")}.${p.image.mediaType === "image/png" ? "png" : "jpg"}`);
        await fsp.writeFile(f, Buffer.from(p.image.data, "base64"));
        images.push(f);
        lines.push(`[attached image #${images.length}]`);
      } else lines.push(p.text);
    }
    lines.push("", "Do not run commands or edit files. Answer only from the text and the attached images.");
    const out = path.join(cwd, "resposta.txt");
    const levels = model.efforts?.length ? model.efforts : CODEX_EFFORTS;
    const level = effort && levels.includes(effort) ? effort : levels.includes("high") ? "high" : levels[0];
    const args = [
      "exec", "--json", "--ephemeral", "--skip-git-repo-check",
      "--sandbox", "read-only",
      "-m", model.id,
      "-c", `model_reasoning_effort="${level}"`,
      "-c", `model_reasoning_summary="auto"`,
      "-C", cwd,
      "-o", out,
      "-",
      ...images.flatMap((f) => ["-i", f]),
    ];
    let text = "";
    let failure = null;
    onText("", "received");
    const { code, stderr } = await run(file, args, {
      cwd,
      signal,
      stdin: lines.join("\n"),
      onLine: (line) => {
        const ev = parse(line);
        if (!ev) return;
        const item = ev.item;
        if (ev.type === "turn.started") onText(text, "received");
        else if (item?.type === "reasoning") onText(text, "thinking", item.text ?? "");
        else if (ev.type === "item.completed" && item?.type === "agent_message") {
          text = item.text ?? text;
          onText(text, "writing");
        } else if (ev.type === "turn.failed" || ev.type === "error") failure = ev.error?.message ?? ev.message ?? JSON.stringify(ev);
      },
    });
    if (failure) throw fail(limitError(failure) ? `Codex: limite de uso da assinatura atingido (${failure}).` : `Codex: ${failure}`, limitError(failure) ? 429 : 502, limitError(failure) ? "RATE_LIMIT" : undefined);
    const last = await fsp.readFile(out, "utf8").catch(() => "");
    if (!last.trim() && !text.trim()) throw fail(`O Codex parou sem responder (código ${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}`);
    return last.trim() || text;
  } finally {
    fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

// Modelos do Codex com imagem, do cache que o próprio Codex mantém para a conta.
export function codexModels() {
  const dir = process.env.CODEX_HOME || path.join(home, ".codex");
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(dir, "models_cache.json"), "utf8"));
    return (cache.models ?? [])
      .filter((m) => m.visibility !== "hide" && (m.input_modalities ?? ["image"]).includes("image"))
      .map((m) => ({
        provider: "codex",
        id: m.slug,
        name: m.display_name || m.slug,
        efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e) => CODEX_EFFORTS.includes(e)),
      }));
  } catch {
    const model = (() => {
      try {
        return fs.readFileSync(path.join(dir, "config.toml"), "utf8").match(/^model\s*=\s*"([^"]+)"/m)?.[1];
      } catch {
        return null;
      }
    })();
    return model ? [{ provider: "codex", id: model, name: model, efforts: CODEX_EFFORTS }] : [];
  }
}

// ---------- Cursor ----------
// `cursor-agent -p` não recebe imagens como anexo: elas vão como arquivos na pasta de trabalho e
// o pedido diz onde estão, para o agente abrir.
export async function streamCursor({ model, system, messages, signal, onText }) {
  const file = findCli("cursor-agent") ?? findCli("agent");
  if (!file) throw fail("Cursor CLI não encontrado. Instale com `curl https://cursor.com/install -fsS | bash` e faça login com `cursor-agent login`.", 400);
  const cwd = await workDir();
  try {
    let n = 0;
    const lines = [system, ""];
    for (const p of flatten(messages)) {
      if (p.image) {
        const name = `imagem-${String(++n).padStart(2, "0")}.${p.image.mediaType === "image/png" ? "png" : "jpg"}`;
        await fsp.writeFile(path.join(cwd, name), Buffer.from(p.image.data, "base64"));
        lines.push(`[image #${n}: ./${name}]`);
      } else lines.push(p.text);
    }
    if (n) lines.push("", `Open and look at every image file listed above (${n} in total) before answering. Do not edit files or run commands.`);
    const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", ...(model.id && model.id !== "auto" ? ["--model", model.id] : []), lines.join("\n")];
    let text = "";
    let result = null;
    onText("", "received");
    const { code, stderr } = await run(file, args, {
      cwd,
      signal,
      onLine: (line) => {
        const ev = parse(line);
        if (!ev) return;
        if (ev.type === "thinking") onText(text, "thinking", ev.text ?? "");
        else if (ev.type === "assistant") {
          const chunk = (ev.message?.content ?? []).map((c) => c.text ?? "").join("");
          if (chunk) {
            text += chunk;
            onText(text, "writing");
          }
        } else if (ev.type === "result") result = ev;
      },
    });
    if (result?.is_error) throw fail(limitError(result.result) ? `Cursor: limite de uso atingido (${result.result}).` : `Cursor: ${result.result}`, limitError(result.result) ? 429 : 502, limitError(result.result) ? "RATE_LIMIT" : undefined);
    const final = typeof result?.result === "string" ? result.result : text;
    if (!final.trim()) throw fail(`O Cursor parou sem responder (código ${code}). ${stderr.trim().split("\n").slice(-2).join(" ")}`);
    return final;
  } finally {
    fsp.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
