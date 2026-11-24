#!/usr/bin/env node
// Servidor local do Takes: API JSON, eventos em tempo real e arquivos de mídia.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store, findScene, selectedTake, blockState, slug, newId, normalizeCharacter } from "./store.js";
import { LtxClient } from "./ltx.js";
import { JobQueue, sceneFolder } from "./jobs.js";
import { buildBrief, userPrompt, parseScript } from "./llm.js";
import { AiSettings, ScriptWriter } from "./ai.js";
import * as media from "./media.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

export function createApp({ root, ltx = new LtxClient(), mediaLib = media, fetchImpl = fetch } = {}) {
  const store = new Store(root);
  const clients = new Set();
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  const queue = new JobQueue({
    store,
    ltx,
    mediaLib,
    file: path.join(root, "jobs.json"),
    onChange: (jobs) => broadcast("jobs", jobs),
  });
  const aiSettings = new AiSettings(path.join(root, "ai.json"));
  const writer = new ScriptWriter({ settings: aiSettings, store, fetchImpl, onChange: (task) => broadcast("ai", task) });
  let onShutdown = () => {};
  const originalSave = store.save.bind(store);
  store.save = (project) => {
    const saved = originalSave(project);
    broadcast("project", { id: saved.id, updatedAt: saved.updatedAt });
    return saved;
  };

  // Só serve arquivos da biblioteca e das pastas de saída dos projetos.
  function allowedFile(file) {
    const resolved = path.resolve(file);
    const roots = [root, ...store.list().map((p) => p.outputDir).filter(Boolean)].map((r) => path.resolve(r) + path.sep);
    return roots.some((r) => resolved.startsWith(r)) ? resolved : null;
  }

  function view(project) {
    const p = structuredClone(project);
    for (const scene of p.scenes) scene.blocks.forEach((b, i) => (b.state = blockState(project.scenes.find((s) => s.id === scene.id), i)));
    p.summary = { sceneCount: p.scenes.length };
    return p;
  }

  async function saveDataUrl(dataUrl, dir, name) {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/s.exec(String(dataUrl || ""));
    if (!m) throw Object.assign(new Error("Envie uma imagem PNG, JPEG ou WebP."), { status: 400 });
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const file = path.join(dir, `${name}.${ext}`);
    await fsp.writeFile(file, Buffer.from(m[2], "base64"));
    return file;
  }

  const routes = [];
  const route = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, fn });
  };

  route("GET", "/api/ltx", async () => {
    try {
      return await ltx.status();
    } catch (error) {
      return { connected: false, error: error.message };
    }
  });

  route("GET", "/api/projects", () =>
    store.list().map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt, scenes: p.scenes.length, characters: p.characters.length })),
  );
  route("POST", "/api/projects", ({ body }) => view(store.create(body.name)));
  route("GET", "/api/projects/:id", ({ id }) => view(store.get(id)));
  route("PUT", "/api/projects/:id", ({ id, body }) => view(store.edit(id, body)));
  route("DELETE", "/api/projects/:id", ({ id }) => (store.remove(id), { ok: true }));
  route("POST", "/api/projects/:id/clone", ({ id, body }) => view(store.clone(id, body.name)));
  // Apaga as cenas do projeto. Os vídeos já gerados continuam na pasta de saída.
  route("DELETE", "/api/projects/:id/scenes", ({ id }) => {
    store.get(id);
    if (queue.list().some((j) => j.projectId === id && j.kind === "video" && ["queued", "running"].includes(j.status)))
      throw Object.assign(new Error("Há cenas deste projeto na fila. Cancele as gerações antes de limpar as cenas."), { status: 409 });
    return view(store.update(id, (p) => void (p.scenes = [])));
  });

  route("POST", "/api/projects/:id/characters", ({ id, body }) => {
    const character = normalizeCharacter({ ...body, id: newId() });
    return view(store.update(id, (p) => void p.characters.push(character)));
  });
  route("POST", "/api/projects/:id/characters/:cid/photo", async ({ id, cid, body }) => {
    const project = store.get(id);
    if (!project.characters.some((c) => c.id === cid)) throw Object.assign(new Error("Personagem não encontrado."), { status: 404 });
    const dir = store.assetsDir(id, "characters");
    const file = await saveDataUrl(body.dataUrl, dir, `${cid}-${Date.now()}`);
    return view(
      store.update(id, (p) => {
        const c = p.characters.find((x) => x.id === cid);
        c.photo = file;
      }),
    );
  });
  route("DELETE", "/api/projects/:id/characters/:cid/photo", ({ id, cid }) =>
    view(
      store.update(id, (p) => {
        const c = p.characters.find((x) => x.id === cid);
        if (c) c.photo = null;
      }),
    ),
  );
  route("POST", "/api/projects/:id/characters/:cid/avatar", ({ id, cid, body }) => {
    store.get(id);
    return queue.add({ kind: "avatar", projectId: id, characterId: cid, prompt: String(body.prompt || ""), fromPhoto: Boolean(body.fromPhoto), strength: Number(body.strength) || 0.5, title: "Foto do personagem" });
  });

  route("POST", "/api/projects/:id/backgrounds", async ({ id, body }) => {
    store.get(id);
    const bid = newId();
    const file = await saveDataUrl(body.dataUrl, store.assetsDir(id, "backgrounds"), bid);
    return view(
      store.update(id, (p) =>
        void p.backgrounds.push({ id: bid, name: String(body.name || "Fundo").slice(0, 200), description: String(body.description || "").slice(0, 4000), image: file }),
      ),
    );
  });
  route("DELETE", "/api/projects/:id/backgrounds/:bid", ({ id, bid }) =>
    view(
      store.update(id, (p) => {
        p.backgrounds = p.backgrounds.filter((b) => b.id !== bid);
        for (const s of p.scenes) {
          if (s.backgroundId === bid) s.backgroundId = null;
          if (s.start.kind === "background" && s.start.id === bid) s.start = { kind: "none", id: null };
        }
      }),
    ),
  );

  route("POST", "/api/projects/:id/previews", ({ id, body }) => {
    store.get(id);
    return queue.add({
      kind: "preview",
      projectId: id,
      sceneId: body.sceneId || null,
      backgroundId: body.backgroundId || null,
      prompt: String(body.prompt || ""),
      rawPrompt: Boolean(body.rawPrompt),
      withCharacters: body.withCharacters !== false,
      strength: Math.min(1, Math.max(0.05, Number(body.strength) || 0.6)),
      title: "Prévia do ambiente",
    });
  });
  route("DELETE", "/api/projects/:id/previews/:pid", ({ id, pid }) =>
    view(
      store.update(id, (p) => {
        p.previews = p.previews.filter((x) => x.id !== pid);
        for (const s of p.scenes) if (s.start.kind === "preview" && s.start.id === pid) s.start = { kind: "none", id: null };
      }),
    ),
  );
  route("POST", "/api/projects/:id/previews/:pid/to-background", async ({ id, pid, body }) => {
    const project = store.get(id);
    const preview = project.previews.find((x) => x.id === pid);
    if (!preview || !fs.existsSync(preview.file)) throw Object.assign(new Error("Prévia não encontrada."), { status: 404 });
    const bid = newId();
    const file = path.join(store.assetsDir(id, "backgrounds"), bid + path.extname(preview.file));
    await fsp.copyFile(preview.file, file);
    return view(store.update(id, (p) => void p.backgrounds.push({ id: bid, name: String(body.name || "Fundo da prévia").slice(0, 200), description: String(body.description || ""), image: file })));
  });

  route("POST", "/api/projects/:id/scenes/:sid/generate", ({ id, sid, body }) =>
    queue.addScene(id, sid, { from: Number(body.from) || 0, only: body.only || null, missing: Boolean(body.missing) }),
  );
  route("POST", "/api/projects/:id/generate-all", ({ id, body }) => queue.addAllScenes(id, { missing: Boolean(body.missing) }));
  route("GET", "/api/projects/:id/scenes/:sid/playlist", ({ id, sid }) => {
    const project = store.get(id);
    const scene = findScene(project, sid);
    let t = 0;
    return scene.blocks.map((b, i) => {
      const take = selectedTake(b);
      const item = { blockId: b.id, index: i, start: t, duration: b.duration, state: blockState(scene, i), continuity: i === 0 ? "start" : b.continuity, prompt: b.prompt, file: take?.file ?? null };
      t += b.duration;
      return item;
    });
  });
  route("POST", "/api/projects/:id/scenes/:sid/export", async ({ id, sid }) => {
    const project = store.get(id);
    const scene = findScene(project, sid);
    const files = scene.blocks.map((b) => selectedTake(b)?.file);
    if (!files.length || files.some((f) => !f || !fs.existsSync(f))) throw Object.assign(new Error("Gere todos os blocos antes de exportar a cena unida."), { status: 409 });
    const folder = sceneFolder(project, scene);
    const output = path.join(folder, `${path.basename(folder)}-completa.mp4`);
    await mediaLib.concat(files, output, { audio: project.settings.audio });
    return { file: output };
  });

  route("GET", "/api/jobs", () => queue.list());
  route("POST", "/api/jobs/:jid/cancel", async ({ jid }) => (await queue.cancel(jid), { ok: true }));
  route("DELETE", "/api/jobs/:jid", ({ jid }) => (queue.remove(jid), { ok: true }));
  route("POST", "/api/jobs/clear", () => (queue.clearFinished(), { ok: true }));
  route("POST", "/api/jobs/:jid/resume", ({ jid }) => queue.resume(jid));
  // Usado pelo app do Mac ao sair: `cancel` decide se o LTX termina a geração atual ou não.
  route("POST", "/api/shutdown", ({ body }) => {
    setImmediate(() => onShutdown({ cancel: Boolean(body.cancel) }));
    return { ok: true };
  });
  route("POST", "/api/projects/:id/characters/:cid/avatar/apply", async ({ id, cid, body }) => {
    const draft = allowedFile(String(body.draft || ""));
    if (!draft || !fs.existsSync(draft)) throw Object.assign(new Error("Imagem gerada não encontrada."), { status: 404 });
    const file = path.join(store.assetsDir(id, "characters"), `${cid}-${Date.now()}${path.extname(draft)}`);
    await fsp.copyFile(draft, file);
    return view(store.update(id, (p) => {
      const c = p.characters.find((x) => x.id === cid);
      if (c) c.photo = file;
    }));
  });

  route("GET", "/api/projects/:id/llm-brief", ({ id }) => {
    const project = store.get(id);
    return { __download: `${slug(project.name, "projeto")}.takes-llm.json`, body: buildBrief(project) };
  });
  route("POST", "/api/projects/:id/llm-prompt", ({ id, body }) => {
    const project = store.get(id);
    const fileName = `${slug(project.name, "projeto")}.takes-llm.json`;
    const brief = body.inline ? buildBrief(project) : null;
    return { text: userPrompt(project, { request: String(body.request || ""), seconds: Number(body.seconds) || null, fileName, inline: Boolean(body.inline), brief }), fileName };
  });
  route("POST", "/api/projects/:id/import-script", ({ id, body }) => {
    const project = store.get(id);
    const { scenes, warnings } = parseScript(project, body.text ?? body.script);
    if (body.validateOnly) return { scenes, warnings };
    const updated = store.update(id, (p) => {
      if (body.replaceSceneId) {
        const at = p.scenes.findIndex((s) => s.id === body.replaceSceneId);
        if (at < 0) throw Object.assign(new Error("Cena a substituir não encontrada."), { status: 404 });
        const old = p.scenes[at];
        scenes[0].id = old.id;
        scenes[0].start = old.start.kind !== "none" ? old.start : scenes[0].start;
        p.scenes.splice(at, 1, ...scenes);
      } else {
        p.scenes.push(...scenes);
      }
    });
    return { project: view(updated), sceneIds: scenes.map((s) => s.id), warnings };
  });

  // Chaves de API (ficam só neste Mac, fora dos projetos) e roteiro gerado automaticamente.
  route("GET", "/api/ai", () => aiSettings.view());
  route("PUT", "/api/ai", ({ body }) => {
    const view = aiSettings.update(body);
    if (body.keys) writer.models.clear();
    return view;
  });
  route("GET", "/api/ai/models", ({ query }) => writer.listModels({ refresh: query.get("refresh") === "1" }));
  route("GET", "/api/projects/:id/ai-script", ({ id }) => writer.list(id));
  route("POST", "/api/projects/:id/ai-script", ({ id, body }) => {
    if (body.provider && body.model) aiSettings.update({ model: { provider: body.provider, id: body.model } });
    return writer.start(id, body);
  });
  route("POST", "/api/ai-script/:tid/cancel", ({ tid }) => writer.cancel(tid));

  route("POST", "/api/pick-folder", async ({ body }) => {
    const start = body.start && fs.existsSync(body.start) ? body.start : path.join(os.homedir(), "Movies");
    const script = `POSIX path of (choose folder with prompt "Pasta de saída dos vídeos" default location (POSIX file ${JSON.stringify(start)}))`;
    try {
      const out = await new Promise((resolve, reject) =>
        execFile("/usr/bin/osascript", ["-e", script], (e, stdout) => (e ? reject(e) : resolve(stdout))),
      );
      return { path: out.trim().replace(/\/$/, "") };
    } catch {
      return { path: null };
    }
  });
  route("POST", "/api/reveal", async ({ body }) => {
    const target = allowedFile(String(body.path || ""));
    if (!target || !fs.existsSync(target)) throw Object.assign(new Error("Arquivo fora das pastas do projeto."), { status: 403 });
    const isDir = fs.statSync(target).isDirectory();
    execFile("/usr/bin/open", isDir ? [target] : ["-R", target]);
    return { ok: true };
  });

  function sendMedia(req, res, file) {
    const target = allowedFile(file);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(target).size;
    const type = { ".mp4": "video/mp4", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[path.extname(target).toLowerCase()] || "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || end < start) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
      fs.createReadStream(target, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(target).pipe(res);
  }

  const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    // Proteção contra páginas externas e DNS rebinding.
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost"].includes(host)) return res.writeHead(403).end();
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-takes"] !== "1") return res.writeHead(403).end();

    if (url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") || "");
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: jobs\ndata: ${JSON.stringify(queue.list())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => (clearInterval(ping), clients.delete(res)));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) return json(res, 404, { error: "Rota não encontrada." });
      try {
        let body = {};
        if (req.method !== "GET") {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 60 << 20) throw Object.assign(new Error("Arquivo grande demais."), { status: 413 });
            chunks.push(chunk);
          }
          const text = Buffer.concat(chunks).toString("utf8");
          body = text ? JSON.parse(text) : {};
        }
        const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(match.re.exec(url.pathname)[i + 1])]));
        const result = await match.fn({ ...params, body, query: url.searchParams });
        if (result?.__download) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${result.__download}"` });
          return res.end(JSON.stringify(result.body, null, 2));
        }
        return json(res, 200, result ?? { ok: true });
      } catch (error) {
        return json(res, error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.message, details: error.details });
      }
    }
    // Arquivos da interface.
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  }

  return { store, queue, handler, server: http.createServer(handler), setShutdown: (fn) => (onShutdown = fn) };
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.TAKES_HOME || path.join(os.homedir(), "Library", "Application Support", "Takes");
  const port = process.env.PORT === undefined ? 4477 : Number(process.env.PORT);
  const { server, queue, setShutdown } = createApp({ root });
  server.listen(port, "127.0.0.1", () => {
    const address = `http://127.0.0.1:${server.address().port}`;
    console.log(`Takes rodando em ${address}`);
    console.log(`Projetos em ${root}`);
    if (!process.argv.includes("--no-open")) execFile("/usr/bin/open", [address]);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`A porta ${port} já está em uso. O Takes já está aberto? Use PORT=outra npm start.`);
      process.exit(1);
    }
    throw e;
  });

  // Ctrl+C no terminal cancela o que está gerando. SIGTERM, o fechamento do app do Mac
  // (ou uma queda dele) deixam o LTX terminar: a geração é recuperada na próxima abertura.
  let stopping = false;
  const shutdown = async ({ cancel }) => {
    if (stopping) return;
    stopping = true;
    await queue.stop({ cancel }).catch(() => {});
    process.exit(0);
  };
  setShutdown(shutdown);
  process.on("SIGINT", () => shutdown({ cancel: true }));
  process.on("SIGTERM", () => shutdown({ cancel: false }));
  if (process.env.TAKES_EXIT_WITH_PARENT === "1") {
    process.stdin.on("end", () => shutdown({ cancel: false }));
    process.stdin.on("close", () => shutdown({ cancel: false }));
    process.stdin.resume();
  }
}
