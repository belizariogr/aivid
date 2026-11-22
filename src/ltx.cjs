const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
class Ltx {
  constructor() {
    this.connection = null;
  }
  async discover() {
    let rows;
    try {
      ({ stdout: rows } = await exec("/bin/ps", ["eww", "-axo", "command="], {
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch {
      throw new Error("Não foi possível localizar o LTX Desktop.");
    }
    const row = rows
      .split("\n")
      .find(
        (r) =>
          r.includes(
            "/LTX Desktop.app/Contents/Resources/python/bin/python3",
          ) &&
          r.includes("ltx2_server.py") &&
          r.includes("LTX_AUTH_TOKEN="),
      );
    const token = row?.match(/(?:^|\s)LTX_AUTH_TOKEN=(\S+)/)?.[1];
    if (!token)
      throw new Error("Abra o LTX Desktop e espere a inicialização terminar.");
    const folder = path.join(
      os.homedir(),
      "Library/Application Support/LTXDesktop/logs",
    );
    const files = await fs.readdir(folder);
    const candidates = await Promise.all(
      files
        .filter((f) => f.endsWith(".log"))
        .map(async (f) => ({
          f,
          mtime: (await fs.stat(path.join(folder, f))).mtimeMs,
        })),
    );
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const { f } of candidates.slice(0, 5)) {
      const log = await fs.readFile(path.join(folder, f), "utf8");
      const matches = [
        ...log.matchAll(/Server running on http:\/\/127\.0\.0\.1:(\d+)/g),
      ];
      if (matches.length) {
        const port = Number(matches.at(-1)[1]);
        if (port > 0 && port < 65536) {
          this.connection = { url: `http://127.0.0.1:${port}`, token };
          return;
        }
      }
    }
    throw new Error(
      "O LTX ainda está iniciando. Tente conectar novamente em alguns segundos.",
    );
  }
  async request(endpoint, data, { timeout = 20000 } = {}) {
    if (!this.connection) await this.discover();
    const { url, token } = this.connection;
    let response;
    try {
      response = await fetch(url + endpoint, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      this.connection = null;
      throw new Error(
        "A conexão com o LTX foi interrompida. Confira se ele continua aberto.",
      );
    }
    if (response.status === 401) {
      this.connection = null;
      throw new Error("O LTX reiniciou. Conecte novamente.");
    }
    const result = await response.json();
    if (!response.ok) {
      const detail = result.detail || result.message || result.error;
      throw new Error(
        typeof detail === "string"
          ? detail
          : `O LTX recusou a operação (HTTP ${response.status}). Verifique os modelos instalados e a memória disponível.`,
      );
    }
    return result;
  }
  async connect() {
    this.connection = null;
    await this.discover();
    const versions = await this.request("/api/models/ltx-versions");
    return {
      connected: true,
      models: versions.versions
        .filter((m) => m.installed)
        .map((m) => ({ id: m.model_id, label: m.label, active: m.active })),
    };
  }
  async prepare(modelId) {
    const p = await this.request("/api/generation/progress");
    if (p.status === "running")
      throw new Error(
        "O LTX já está gerando outro vídeo. Aguarde antes de iniciar a fila do Aivid.",
      );
    const versions = await this.request("/api/models/ltx-versions");
    if (!versions.versions.some((m) => m.model_id === modelId && m.installed))
      throw new Error(
        "Esse modelo ainda não está instalado. Baixe-o em Settings → Models no LTX Desktop.",
      );
    await this.request("/api/settings", {
      use_local_text_encoder: true,
      prompt_enhancer_enabled: false,
      explore_auto_enhance_prompts: false,
      user_prefers_ltx_api_video_generations: false,
    });
    await this.request("/api/models/active-ltx-model", { model_id: modelId });
  }
  generate(request) {
    return this.request("/api/generate", request, {
      timeout: 4 * 60 * 60 * 1000,
    });
  }
  progress() {
    return this.request("/api/generation/progress");
  }
  cancel() {
    return this.request("/api/generate/cancel", {});
  }
}
module.exports = { Ltx };
