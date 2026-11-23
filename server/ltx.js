// Cliente da API local do LTX Desktop (backend FastAPI em 127.0.0.1).
// A porta e o token de sessão são lidos do processo `ltx2_server.py` em execução.
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";

const run = promisify(execFile);

// Durações aceitas pelo pipeline local "fast" quando a API não informa outra lista.
export const FALLBACK_DURATIONS = [2, 3, 4, 5, 6, 8, 10, 20];
export const MAX_BLOCK_SECONDS = 20;
export const MIN_BLOCK_SECONDS = 2;

export class LtxError extends Error {
  constructor(message, { status = 0, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function errorDetail(body) {
  if (!body || typeof body !== "object") return null;
  for (const value of [body.detail, body.message, body.error?.message, body.error?.detail, body.error]) {
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value) && value[0]?.msg) return value.map((v) => v.msg).join("; ");
  }
  return null;
}

// HTTP sem limite de espera pelos cabeçalhos. O fetch do Node desiste após 300 s, e uma
// continuação em 720p leva mais que isso; o LTX só responde quando termina de gerar.
export function httpTransport(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, signal }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new LtxError("Operação cancelada.", { code: "ABORTED" }))), { once: true });
  });

export class LtxClient {
  constructor({ exec = run, transport = httpTransport } = {}) {
    this.exec = exec;
    this.transport = transport;
    this.connection = null;
    this.specsCache = null;
  }

  async discover() {
    let listing;
    try {
      ({ stdout: listing } = await this.exec("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 32 << 20 }));
    } catch {
      throw new LtxError("Não foi possível listar os processos para localizar o LTX Desktop.");
    }
    const line = listing
      .split("\n")
      .find((row) => row.includes("ltx2_server.py") && row.includes("LTX Desktop"));
    const pid = line?.trim().split(/\s+/)[0];
    if (!pid || !/^\d+$/.test(pid))
      throw new LtxError("O LTX Desktop não está aberto. Abra o app e aguarde a inicialização.", { code: "NOT_RUNNING" });

    const { stdout: env } = await this.exec("/bin/ps", ["eww", "-o", "command=", "-p", pid], { maxBuffer: 32 << 20 });
    const token = env.match(/(?:^|\s)LTX_AUTH_TOKEN=(\S+)/)?.[1] ?? "";

    let port = null;
    try {
      const { stdout } = await this.exec("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid]);
      port = stdout.match(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/)?.[1] ?? null;
    } catch {
      /* lsof retorna erro quando ainda não há porta aberta */
    }
    if (!port) throw new LtxError("O LTX Desktop ainda está iniciando. Tente de novo em alguns segundos.", { code: "STARTING" });
    this.connection = { base: `http://127.0.0.1:${port}`, token, pid: Number(pid) };
    return this.connection;
  }

  async request(method, endpoint, body, { timeout = 30_000, signal } = {}) {
    if (!this.connection) await this.discover();
    const { base, token } = this.connection;
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    let response;
    try {
      response = await this.transport(base + endpoint, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      this.connection = null;
      if (signal?.aborted) throw new LtxError("Operação cancelada.", { code: "ABORTED" });
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new LtxError("O LTX demorou demais para responder.");
      throw new LtxError("A conexão com o LTX Desktop caiu. Confira se ele continua aberto.", { code: "CONNECTION" });
    }
    if (response.status === 401) {
      this.connection = null;
      throw new LtxError("O LTX Desktop foi reiniciado. Tente novamente.", { status: 401 });
    }
    const text = response.text;
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = errorDetail(data);
      throw new LtxError(detail || `O LTX recusou a operação (HTTP ${response.status}).`, { status: response.status });
    }
    return data;
  }

  async status() {
    this.connection = null;
    await this.discover();
    const [versions, settings, image, progress] = await Promise.all([
      this.request("GET", "/api/models/ltx-versions"),
      this.request("GET", "/api/settings"),
      this.request("GET", "/api/image-generation/status").catch(() => null),
      this.request("GET", "/api/generation/progress").catch(() => null),
    ]);
    const active = versions.versions.find((v) => v.active && v.installed);
    return {
      connected: true,
      model: active ? { id: active.model_id, label: active.label } : null,
      models: versions.versions.filter((v) => v.installed).map((v) => ({ id: v.model_id, label: v.label, active: v.active })),
      imageGeneration: image ? image.defaultProvider === "local" && !image.localBlocker : false,
      cloudVideo: Boolean(settings.userPrefersLtxApiVideoGenerations),
      busy: progress?.status === "running",
    };
  }

  // Garante geração local: sem nuvem para vídeo ou imagem.
  async ensureLocal() {
    const settings = await this.request("GET", "/api/settings");
    const patch = {};
    if (settings.userPrefersLtxApiVideoGenerations) patch.userPrefersLtxApiVideoGenerations = false;
    if (settings.userPrefersFalApiImageGenerations) patch.userPrefersFalApiImageGenerations = false;
    if (Object.keys(patch).length) await this.request("POST", "/api/settings", patch);
  }

  // Durações que o pipeline local aceita para a resolução/fps escolhidos.
  async durations(resolution, fps) {
    try {
      if (!this.specsCache) this.specsCache = await this.request("GET", "/api/generate/models-specs");
      const fast = this.specsCache.local_models?.find((m) => m.pipeline === "fast");
      const list = fast?.spec?.supported_resolutions_durations?.[resolution]?.fps_to_durations?.[String(fps)];
      if (Array.isArray(list) && list.length) return [...list].sort((a, b) => a - b);
    } catch {
      /* usa a lista padrão */
    }
    return FALLBACK_DURATIONS;
  }

  // Gerações longas: se a conexão cair, acompanha o progresso do LTX e recupera o resultado.
  async long(endpoint, body, opts, toResult) {
    let before = null;
    try {
      before = (await this.progress()).id ?? null;
    } catch {
      /* sem progresso anterior */
    }
    try {
      return await this.request("POST", endpoint, body, { timeout: 6 * 3600_000, ...opts });
    } catch (error) {
      if (error.code !== "CONNECTION") throw error;
      const deadline = Date.now() + 6 * 3600_000;
      while (Date.now() < deadline) {
        await sleep(3000, opts.signal);
        let p;
        try {
          p = await this.progress();
        } catch {
          throw error;
        }
        if (p.id === before) throw error; // a nossa geração nem começou
        if (p.status === "running") continue;
        if (p.status === "complete" && p.result) return toResult(p.result);
        if (p.status === "cancelled") return { status: "cancelled" };
        throw new LtxError(p.status === "error" ? `O LTX falhou: ${p.phase || "erro desconhecido"}` : error.message);
      }
      throw error;
    }
  }

  generateVideo(body, opts = {}) {
    return this.long("/api/generate", body, opts, (r) => ({ status: "complete", video_path: Array.isArray(r) ? r[0] : r }));
  }

  extend(body, opts = {}) {
    return this.long("/api/extend", body, opts, (r) => ({ status: "complete", video_path: Array.isArray(r) ? r[0] : r }));
  }

  async generateImage(body, opts = {}) {
    const status = await this.request("GET", "/api/image-generation/status");
    if (status.localBlocker || status.defaultProvider !== "local")
      throw new LtxError("A geração local de imagens não está disponível. Instale o Z-Image Turbo no LTX Desktop.");
    return this.long("/api/generate-image", body, opts, (r) => ({ status: "complete", image_paths: Array.isArray(r) ? r : [r] }));
  }

  progress() {
    return this.request("GET", "/api/generation/progress", undefined, { timeout: 10_000 });
  }

  cancel() {
    return this.request("POST", "/api/generate/cancel", {}, { timeout: 10_000 });
  }
}

// Menor duração aceita pelo LTX que cobre o tempo pedido.
export function renderDuration(seconds, allowed = FALLBACK_DURATIONS) {
  return allowed.find((d) => d >= seconds) ?? allowed.at(-1);
}
