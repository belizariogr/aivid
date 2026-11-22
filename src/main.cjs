const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  powerSaveBlocker,
  nativeImage,
  protocol,
} = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const { mediaResponse, playlist } = require("./media.cjs");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "aivid-media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
const mediaFiles = new Map();
const { estimateDuration } = require("./duration.js");
const { Store, splitScenes, buildPrompt } = require("./core.cjs");
const { Ltx } = require("./ltx.cjs");
const exec = promisify(execFile);
app.setName("Aivid");
app.setPath("userData", path.join(app.getPath("appData"), "Aivid"));
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
let window,
  store,
  engine = new Ltx(),
  active = null,
  working = false,
  blocker = null,
  quitting = false;
const page = path.join(__dirname, "index.html");
function emit() {
  if (window && !window.isDestroyed())
    window.webContents.send("jobs", store.data.jobs);
}
function persist() {
  store.save();
  emit();
}
function jobById(id) {
  const j = store.data.jobs.find((j) => j.id === id);
  if (!j) throw new Error("Geração não encontrada.");
  return j;
}
function library() {
  const view = {
    projects: structuredClone(store.data.projects),
    jobs: store.data.jobs,
  };
  for (const p of view.projects) {
    for (const c of p.characters) {
      try {
        c.preview = nativeImage
          .createFromPath(c.image)
          .resize({ width: 160 })
          .toDataURL();
      } catch {
        c.preview = null;
      }
    }
    for (const scene of p.scenes || []) {
      if (scene.image)
        scene.preview = nativeImage
          .createFromPath(scene.image)
          .resize({ width: 400 })
          .toDataURL();
    }
  }
  return view;
}
async function ffmpeg() {
  for (const p of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"])
    if (fs.existsSync(p)) return p;
  try {
    return (await exec("/usr/bin/which", ["ffmpeg"])).stdout.trim();
  } catch {
    throw new Error(
      "Instale FFmpeg (brew install ffmpeg) para encadear ou unir cenas.",
    );
  }
}
async function runQueue() {
  if (working) return;
  working = true;
  blocker = powerSaveBlocker.start("prevent-app-suspension");
  try {
    while (true) {
      const job = store.data.jobs.find((j) => j.status === "queued");
      if (!job) break;
      active = job;
      job.status = "running";
      job.startedAt = new Date().toISOString();
      persist();
      let timer;
      try {
        const p = job.project;
        await fsp.access(p.outputDir, fs.constants.W_OK);
        let binary;
        if (p.settings.chain && job.scenes.length > 1) binary = await ffmpeg();
        await engine.prepare(p.settings.modelId);
        const dir = path.join(
          p.outputDir,
          `aivid-${new Date().toISOString().replace(/[:.]/g, "-")}-${job.id.slice(0, 8)}`,
        );
        await fsp.mkdir(dir, { recursive: true });
        job.folder = dir;
        persist();
        let image = null;
        for (let i = 0; i < job.scenes.length; i++) {
          if (job.cancelRequested) break;
          const scene = job.scenes[i];
          if (scene.reference === "scene") image = scene.image;
          else if (scene.reference)
            image = p.characters.find((c) => c.id === scene.reference)?.image;
          else if (!p.settings.chain) image = null;
          job.scene = i + 1;
          job.progress = 0;
          job.phase = "Preparando a cena";
          job.ownsBackend = true;
          persist();
          timer = setInterval(async () => {
            try {
              const p = await engine.progress();
              if (job.status === "running" && p.status === "running") {
                job.progress = p.progress;
                job.phase = p.phase;
                job.remainingSeconds = p.remainingSeconds;
                emit();
              }
            } catch {
              /* A requisição principal apresentará o erro de conexão. */
            }
          }, 2000);
          const request = {
            prompt: buildPrompt(p, scene.prompt, scene.characterIds),
            resolution: p.settings.resolution,
            duration: scene.duration ?? estimateDuration(scene.prompt),
            fps: p.settings.fps,
            aspectRatio: p.settings.aspectRatio,
            model: "fast",
            seed: (p.settings.seed + i) % 2147483647,
            audio: false,
            ...(image ? { imagePath: image } : {}),
          };
          const result = await engine.generate(request);
          clearInterval(timer);
          timer = null;
          job.ownsBackend = false;
          if (result.status === "cancelled" || job.cancelRequested) {
            job.cancelRequested = true;
            break;
          }
          if (result.status !== "complete" || !result.video_path)
            throw new Error("O LTX não retornou um vídeo válido.");
          const out = path.join(
            dir,
            `cena-${String(scene.number).padStart(2, "0")}.mp4`,
          );
          await fsp.copyFile(
            result.video_path,
            out,
            fs.constants.COPYFILE_EXCL,
          );
          job.files.push(out);
          await fsp.writeFile(
            path.join(
              dir,
              `cena-${String(scene.number).padStart(2, "0")}.json`,
            ),
            JSON.stringify(
              { request, generatedAt: new Date().toISOString() },
              null,
              2,
            ),
          );
          if (p.settings.chain && i < job.scenes.length - 1) {
            image = path.join(dir, `referencia-${i + 1}.png`);
            await exec(binary, [
              "-y",
              "-sseof",
              "-0.1",
              "-i",
              out,
              "-frames:v",
              "1",
              "-update",
              "1",
              image,
            ]);
          }
          persist();
        }
        if (job.cancelRequested) {
          job.status = "cancelled";
          job.phase = "Cancelado";
        } else {
          job.output = job.files[0];
          job.status = "complete";
          job.phase = "Concluído";
          job.progress = 100;
        }
      } catch (error) {
        job.status = job.cancelRequested ? "cancelled" : "error";
        job.error = error.message;
      } finally {
        if (timer) clearInterval(timer);
        job.ownsBackend = false;
        job.finishedAt = new Date().toISOString();
        job.elapsedSeconds = Math.round(
          (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000,
        );
        persist();
        active = null;
      }
    }
  } finally {
    working = false;
    if (blocker !== null && powerSaveBlocker.isStarted(blocker))
      powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.senderFrame?.url !== pathToFileURL(page).href)
      throw new Error("Origem inválida.");
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}
app.whenReady().then(() => {
  protocol.handle("aivid-media", (request) => {
    const url = new URL(request.url);
    return mediaResponse(
      url.hostname === "clip" ? mediaFiles.get(url.pathname.slice(1)) : null,
      request,
    );
  });
  store = new Store(path.join(app.getPath("userData"), "library"));
  handle("library", () => library());
  handle("playlist", (id) => {
    const p = store.project(id);
    mediaFiles.clear();
    return playlist(p, store.data.jobs).map(({ file, ...item }) => {
      if (!file) return { ...item, src: null };
      const token = randomUUID();
      mediaFiles.set(token, file);
      return { ...item, src: `aivid-media://clip/${token}` };
    });
  });
  handle("save-project", (input) => {
    store.upsert(input);
    return library();
  });
  handle("choose-output", async (id) => {
    const p = store.project(id);
    const r = await dialog.showOpenDialog(window, {
      title: "Onde salvar os vídeos?",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: p.outputDir || app.getPath("videos"),
    });
    if (!r.canceled) {
      p.outputDir = r.filePaths[0];
      store.save();
    }
    return library();
  });
  handle("add-character", async (id, name) => {
    const p = store.project(id);
    const r = await dialog.showOpenDialog(window, {
      title: "Imagem do personagem",
      filters: [
        { name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
      properties: ["openFile"],
    });
    if (!r.canceled) {
      const image = store.asset(id, r.filePaths[0]);
      p.characters.push({
        id: randomUUID(),
        name: String(name || path.parse(r.filePaths[0]).name).slice(0, 100),
        description: "",
        image,
      });
      store.save();
    }
    return library();
  });
  handle("edit-character", (id, cid, patch) => {
    const c = store.project(id).characters.find((c) => c.id === cid);
    if (!c) throw new Error("Personagem não encontrado.");
    c.name = String(patch.name || "Personagem").slice(0, 100);
    c.description = String(patch.description || "").slice(0, 3000);
    store.save();
    return library();
  });
  handle("remove-character", (id, cid) => {
    const p = store.project(id);
    p.characters = p.characters.filter((c) => c.id !== cid);
    store.save();
    return library();
  });
  handle("scene-image", async (id, sid) => {
    const p = store.project(id);
    const scene = p.scenes.find((s) => s.id === sid);
    if (!scene) throw new Error("Cena não encontrada.");
    const r = await dialog.showOpenDialog(window, {
      title: "Imagem inicial da cena",
      filters: [
        { name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
      properties: ["openFile"],
    });
    if (!r.canceled) {
      scene.image = store.asset(id, r.filePaths[0]);
      scene.reference = "scene";
      store.save();
    }
    return library();
  });
  handle("connect", () => engine.connect());
  handle("open-ltx", async () => {
    const error = await shell.openPath("/Applications/LTX Desktop.app");
    if (error) throw new Error("Instale o LTX Desktop em Aplicativos.");
  });
  handle("enqueue", async (id, sceneId) => {
    const p = store.project(id);
    if (!p.outputDir)
      throw new Error("Escolha a pasta de saída antes de gerar.");
    const scenes = p.scenes
      .map((s, i) => ({ ...s, number: i + 1 }))
      .filter((s) => !sceneId || s.id === sceneId);
    if (!scenes.length) throw new Error("Adicione uma cena.");
    for (const s of scenes) {
      splitScenes(s.prompt);
      if (s.reference === "scene" && !s.image)
        throw new Error(`Escolha a imagem inicial de ${s.name}.`);
      if (
        s.reference &&
        s.reference !== "scene" &&
        !p.characters.some((c) => c.id === s.reference)
      )
        throw new Error(
          "A referência de uma cena foi removida. Escolha outra.",
        );
    }
    const job = {
      id: randomUUID(),
      projectId: id,
      projectName: p.name,
      project: structuredClone(p),
      scenes,
      status: "queued",
      createdAt: new Date().toISOString(),
      scene: 0,
      progress: 0,
      files: [],
      phase: "Na fila",
    };
    store.data.jobs.push(job);
    persist();
    setImmediate(runQueue);
    return job.id;
  });
  handle("cancel", async (id) => {
    const j = jobById(id);
    if (j.status === "queued") {
      j.status = "cancelled";
      persist();
    } else if (j.status === "running") {
      j.cancelRequested = true;
      persist();
      if (j.ownsBackend) await engine.cancel();
    }
  });
  handle("open-output", async (id, reveal) => {
    const j = jobById(id);
    if (reveal && j.folder) {
      const error = await shell.openPath(j.folder);
      if (error) throw new Error(error);
      return;
    }
    if (!j.output) throw new Error("Ainda não existe um vídeo final.");
    const error = await shell.openPath(j.output);
    if (error) throw new Error(error);
  });
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: "Aivid",
    backgroundColor: "#101210",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.loadFile(page);
  window.on("close", async (e) => {
    if (working && !quitting) {
      e.preventDefault();
      const r = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["Continuar gerando", "Cancelar e sair"],
        defaultId: 0,
        cancelId: 0,
        message: "Há vídeos na fila.",
        detail: "Mantenha o Aivid e o LTX abertos até a geração terminar.",
      });
      if (r.response === 1) {
        quitting = true;
        for (const j of store.data.jobs)
          if (j.status === "queued") j.status = "cancelled";
        if (active) {
          active.cancelRequested = true;
          if (active.ownsBackend) await engine.cancel().catch(() => {});
        }
        persist();
        app.quit();
      }
    }
  });
});
app.on("window-all-closed", () => app.quit());
