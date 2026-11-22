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
const { estimateDuration, modelDuration } = require("./duration.js");
const {
  Store,
  splitScenes,
  buildPrompt,
  projectPromptParts,
} = require("./core.cjs");
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
  activeImage = null,
  activeProcess = null,
  working = false,
  blocker = null,
  quitting = false,
  closing = false;
const deletingJobs = new Set();
const idleWaiters = new Set();
const environmentDrafts = new Map();
const environmentReferences = new Map();
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
    if (p.environmentImage)
      p.environmentPreview = nativeImage
        .createFromPath(p.environmentImage)
        .resize({ width: 400 })
        .toDataURL();
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
      const approved = p.environments?.find(
        (entry) => scene.reference === `env:${entry.id}`,
      );
      const reference =
        approved?.image || (scene.reference === "scene" && scene.image);
      if (reference)
        scene.preview = nativeImage
          .createFromPath(reference)
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
      "Instale FFmpeg (brew install ffmpeg) para recortar vídeos, encadear cenas ou salvar quadros.",
    );
  }
}
function finishWork() {
  working = false;
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
}
async function stopGeneration(task) {
  task.cancelRequested = true;
  activeProcess?.abort();
  for (let attempt = 0; attempt < 4 && task.ownsBackend; attempt++) {
    const result = await engine.cancel();
    if (result?.status !== "no_active_generation") return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (task.ownsBackend)
    throw new Error(
      "O LTX ainda está iniciando a geração. Tente abortar novamente.",
    );
}
async function runVideoProcess(binary, args) {
  const controller = new AbortController();
  activeProcess = controller;
  try {
    return await exec(binary, args, { signal: controller.signal });
  } finally {
    activeProcess = null;
  }
}
async function runQueue() {
  if (working || closing || quitting) return;
  working = true;
  blocker = powerSaveBlocker.start("prevent-app-suspension");
  try {
    while (!closing && !quitting) {
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
        const needsTrim = job.scenes.some(
          (scene) =>
            scene.duration != null &&
            modelDuration(scene.duration) !== scene.duration,
        );
        if (needsTrim || (p.settings.chain && job.scenes.length > 1))
          binary = await ffmpeg();
        await engine.prepare(p.settings.modelId);
        const dir = path.join(
          p.outputDir,
          `aivid-${new Date().toISOString().replace(/[:.]/g, "-")}-${job.id.slice(0, 8)}`,
        );
        await fsp.mkdir(dir, { recursive: true });
        job.folder = dir;
        persist();
        let previousFrame = null;
        for (let i = 0; i < job.scenes.length; i++) {
          if (job.cancelRequested) break;
          const scene = job.scenes[i];
          let image;
          if (scene.reference === "scene") image = scene.image;
          else if (scene.reference === "text") image = null;
          else if (scene.reference === "environment")
            image = p.environmentImage;
          else if (scene.reference?.startsWith("env:"))
            image = p.environments.find(
              (entry) => entry.id === scene.reference.slice(4),
            )?.image;
          else if (scene.reference)
            image = p.characters.find((c) => c.id === scene.reference)?.image;
          else image = previousFrame || p.environmentImage;
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
          const duration = scene.duration ?? estimateDuration(scene.prompt);
          const renderDuration = modelDuration(duration);
          const trimOutput = renderDuration !== duration;
          const request = {
            prompt: [
              buildPrompt(p, scene.prompt, scene.characterIds),
              trimOutput &&
                `Finish the requested action within the first ${duration} seconds, then hold the final pose through the rest of the clip.`,
              image &&
                "Use the attached image as the opening frame. Preserve its setting, layout, character appearance and visual style while animating the scene action.",
            ]
              .filter(Boolean)
              .join("\n\n"),
            resolution: p.settings.resolution,
            duration: renderDuration,
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
          const filename = job.continuous
            ? "sequencia"
            : `cena-${String(scene.number).padStart(2, "0")}`;
          const out = path.join(dir, `${filename}.mp4`);
          if (trimOutput) {
            job.phase = "Ajustando a duração";
            persist();
            const temporaryOutput = path.join(dir, `${filename}-temp.mp4`);
            try {
              await runVideoProcess(binary, [
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                result.video_path,
                "-t",
                String(duration),
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                temporaryOutput,
              ]);
              if (job.cancelRequested) break;
              await fsp.rename(temporaryOutput, out);
            } finally {
              await fsp.rm(temporaryOutput, { force: true });
            }
          } else {
            await fsp.copyFile(
              result.video_path,
              out,
              fs.constants.COPYFILE_EXCL,
            );
          }
          job.files.push(out);
          await fsp.writeFile(
            path.join(dir, `${filename}.json`),
            JSON.stringify(
              {
                request,
                outputDuration: duration,
                generatedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
          if (p.settings.chain && i < job.scenes.length - 1) {
            previousFrame = path.join(dir, `referencia-${i + 1}.png`);
            await runVideoProcess(binary, [
              "-y",
              "-sseof",
              "-0.1",
              "-i",
              out,
              "-frames:v",
              "1",
              "-update",
              "1",
              previousFrame,
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
        if (!job.cancelRequested) job.error = error.message;
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
    finishWork();
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
  handle("open-project-assets", async (id) => {
    const { id: projectId } = store.project(id);
    const folder = path.join(store.root, "assets", projectId);
    await fsp.mkdir(folder, { recursive: true });
    const error = await shell.openPath(folder);
    if (error) throw new Error("Não foi possível abrir a pasta do projeto.");
  });
  handle("export-character-image", async (id, cid) => {
    const character = store
      .project(id)
      .characters.find((item) => item.id === cid);
    if (!character?.image) throw new Error("Personagem sem imagem.");
    const extension = path.extname(character.image);
    const filename =
      character.name.replace(/[^\p{L}\p{N} ._-]/gu, "_").trim() || "Personagem";
    const result = await dialog.showSaveDialog(window, {
      title: "Salvar imagem do personagem",
      defaultPath: path.join(
        app.getPath("pictures"),
        `${filename}${extension}`,
      ),
      filters: [{ name: "Imagem", extensions: [extension.slice(1)] }],
    });
    if (result.canceled || !result.filePath) return false;
    if (path.resolve(result.filePath) !== path.resolve(character.image))
      await fsp.copyFile(character.image, result.filePath);
    return true;
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
    if (sid && !scene) throw new Error("Cena não encontrada.");
    const r = await dialog.showOpenDialog(window, {
      title: scene ? "Imagem inicial da cena" : "Imagem do ambiente",
      filters: [
        { name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
      properties: ["openFile"],
    });
    if (!r.canceled) {
      const image = store.asset(id, r.filePaths[0]);
      if (scene) {
        scene.image = image;
        scene.reference = "scene";
      } else {
        p.environmentImage = image;
      }
      store.save();
    }
    return library();
  });
  handle("environment-reference", async (id, sid) => {
    const project = store.project(id);
    if (!project.scenes.some((scene) => scene.id === sid))
      throw new Error("Cena não encontrada.");
    const selection = await dialog.showOpenDialog(window, {
      title: "Imagem de referência para o ambiente",
      filters: [
        { name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
      properties: ["openFile"],
    });
    if (selection.canceled) return null;
    const filename = selection.filePaths[0];
    const referenceId = `upload:${randomUUID()}`;
    environmentReferences.set(`${id}/${sid}`, {
      id: referenceId,
      image: store.asset(id, filename),
    });
    return { id: referenceId, name: path.basename(filename) };
  });
  handle("generate-environment", async (id, sid, input) => {
    if (working || closing) throw new Error("Aguarde a geração em andamento.");
    const project = store.project(id);
    const scene = project.scenes.find((item) => item.id === sid);
    const prompt = String(input.prompt || "").trim();
    if (!scene || !prompt || prompt.length > 10000)
      throw new Error("Descreva a imagem inicial em até 10 mil caracteres.");
    const upload = environmentReferences.get(`${id}/${sid}`);
    const references = new Map([
      ["project", project.environmentImage],
      ["scene", scene.image],
      ...project.characters.map((item) => [`cast:${item.id}`, item.image]),
      ...(project.environments || []).map((item) => [
        `env:${item.id}`,
        item.image,
      ]),
    ]);
    if (upload) references.set(upload.id, upload.image);
    const imagePath = references.get(input.reference);
    if (input.reference && !imagePath)
      throw new Error("Escolha uma imagem da biblioteca deste projeto.");
    const cast = project.characters
      .filter((character) => scene.characterIds?.includes(character.id))
      .map((character) =>
        [character.name, character.description].filter(Boolean).join(": "),
      );
    const [width, height] = {
      "16:9": [1024, 576],
      "9:16": [576, 1024],
      "1:1": [768, 768],
    }[project.settings.aspectRatio];
    const request = {
      prompt: [
        ...projectPromptParts(project),
        !input.backgroundOnly &&
          cast.length &&
          `Cast available in this scene: ${cast.join("; ")}`,
        imagePath &&
          "Preserve the reference art direction: rendering medium, linework, textures, palette and lighting. Apply the requested changes without redesigning the rest.",
        input.scenePreview
          ? `Create a single preview image of the opening moment of this scene. Show the characters and props in their starting positions. Use the actions as context for the still. ${prompt}`
          : `Create a single opening still for this scene. ${prompt}`,
        input.backgroundOnly &&
          "Create an empty background plate. Omit all characters, people and animals, including any appearing in the reference. Preserve the environment layout and art direction unless the request specifies changes.",
        "No captions or logos.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      width,
      height,
      numImages: 1,
      numSteps: 8,
      ...(imagePath && { imagePath, strength: 0.72 }),
    };
    working = true;
    const task = { cancelRequested: false, ownsBackend: false };
    activeImage = task;
    const imageBlocker = powerSaveBlocker.start("prevent-app-suspension");
    try {
      const result = await engine.generateEnvironment(request, () => {
        if (task.cancelRequested) return false;
        task.ownsBackend = true;
        return true;
      });
      if (task.cancelRequested || result.status === "cancelled")
        return { cancelled: true };
      if (result.status !== "complete" || !result.image_paths?.[0])
        throw new Error("O LTX não retornou uma imagem.");
      const image = result.image_paths[0];
      const key = `${id}/${sid}`;
      environmentDrafts.set(key, { image, prompt });
      return {
        preview: nativeImage
          .createFromPath(image)
          .resize({ width: 1000 })
          .toDataURL(),
      };
    } finally {
      powerSaveBlocker.stop(imageBlocker);
      task.ownsBackend = false;
      activeImage = null;
      finishWork();
      if (!quitting) setImmediate(runQueue);
    }
  });
  handle("cancel-environment", async () => {
    if (activeImage) await stopGeneration(activeImage);
  });
  handle("approve-environment", (id, sid, name) => {
    const project = store.project(id);
    const scene = project.scenes.find((item) => item.id === sid);
    const key = `${id}/${sid}`;
    const draft = environmentDrafts.get(key);
    if (!scene || !draft) throw new Error("Gere e revise a imagem primeiro.");
    const entry = {
      id: randomUUID(),
      name:
        String(name || "")
          .trim()
          .slice(0, 100) || scene.name,
      prompt: draft.prompt,
      image: store.asset(id, draft.image),
    };
    (project.environments ??= []).push(entry);
    scene.reference = `env:${entry.id}`;
    scene.environmentPrompt = entry.prompt;
    environmentDrafts.delete(key);
    environmentReferences.delete(key);
    store.save();
    return library();
  });
  handle("remove-environment", (id) => {
    const p = store.project(id);
    p.environmentImage = null;
    for (const scene of p.scenes)
      if (scene.reference === "environment") scene.reference = "";
    store.save();
    return library();
  });
  handle("connect", () => engine.connect());
  handle("open-ltx", async () => {
    const error = await shell.openPath("/Applications/LTX Desktop.app");
    if (error) throw new Error("Instale o LTX Desktop em Aplicativos.");
  });
  handle("enqueue", async (id, sceneId, continuous = false) => {
    if (closing) throw new Error("O Aivid está encerrando.");
    const p = store.project(id);
    if (!p.outputDir)
      throw new Error("Escolha a pasta de saída antes de gerar.");
    const scenes = p.scenes
      .map((s, i) => ({ ...s, number: i + 1 }))
      .filter((s) => !sceneId || s.id === sceneId);
    if (!scenes.length) throw new Error("Adicione uma cena.");
    for (const s of scenes) {
      splitScenes(s.prompt);
      if (continuous && s !== scenes[0]) continue;
      if (s.reference === "scene" && !s.image)
        throw new Error(`Escolha a imagem inicial de ${s.name}.`);
      if (s.reference === "environment" && !p.environmentImage)
        throw new Error("Adicione uma imagem do ambiente ao projeto.");
      if (
        s.reference &&
        !["scene", "text", "environment"].includes(s.reference) &&
        !p.environments?.some((entry) => s.reference === `env:${entry.id}`) &&
        !p.characters.some((c) => c.id === s.reference)
      )
        throw new Error(
          "A referência de uma cena foi removida. Escolha outra.",
        );
    }
    let renderScenes = scenes;
    if (continuous) {
      let elapsed = 0;
      const beats = scenes.map((scene) => {
        const start = elapsed;
        elapsed += scene.duration ?? estimateDuration(scene.prompt);
        return `${start}–${elapsed} seconds: ${scene.prompt.trim()}`;
      });
      const duration = modelDuration(elapsed);
      if (duration === null)
        throw new Error(
          "A sequência ultrapassa 20 s. Encurte as cenas para gerar em um único clipe.",
        );

      const first = scenes[0];
      renderScenes = [
        {
          ...first,
          id: randomUUID(),
          name: "Sequência contínua",
          duration: elapsed,
          characterIds: [
            ...new Set(scenes.flatMap((scene) => scene.characterIds || [])),
          ],
          prompt: [
            "One continuous shot. Keep the same rendering style, linework, color palette, lighting, character designs, and set layout throughout. Use continuous motion and avoid cuts or restarts.",
            ...beats,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ];
    }
    const job = {
      id: randomUUID(),
      projectId: id,
      projectName: p.name,
      project: structuredClone(p),
      scenes: renderScenes,
      continuous,
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
      try {
        await stopGeneration(j);
      } finally {
        persist();
      }
    }
  });
  handle("delete-job", async (id) => {
    const job = jobById(id);
    if (["running", "queued"].includes(job.status))
      throw new Error("Aborte a geração e aguarde até ela parar.");
    if (deletingJobs.has(id)) return false;
    deletingJobs.add(id);
    try {
      const result = await dialog.showMessageBox(window, {
        type: "warning",
        message: "Excluir esta geração?",
        detail:
          "Os clipes desta geração serão movidos para o Lixo do macOS. As imagens que você salvou como referência continuam na biblioteca.",
        buttons: ["Cancelar", "Mover para o Lixo"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return false;
      const files = new Set(job.files);
      if (job.folder && !job.imported) {
        for (const [index, scene] of job.scenes.entries()) {
          const basename = job.continuous
            ? "sequencia"
            : `cena-${String(scene.number).padStart(2, "0")}`;
          files.add(path.join(job.folder, `${basename}.json`));
          if (job.project.settings.chain && index < job.scenes.length - 1)
            files.add(path.join(job.folder, `referencia-${index + 1}.png`));
        }
      }
      for (const filename of files) {
        if (fs.existsSync(filename)) await shell.trashItem(filename);
      }
      store.data.jobs = store.data.jobs.filter((item) => item.id !== id);
      for (const [token, file] of mediaFiles)
        if (files.has(file)) mediaFiles.delete(token);
      persist();
      return true;
    } finally {
      deletingJobs.delete(id);
    }
  });
  handle("replace-character-photo", async (id, cid) => {
    const project = store.project(id);
    const selection = await dialog.showOpenDialog(window, {
      title: "Trocar foto do personagem",
      filters: [
        { name: "Imagens", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
      properties: ["openFile"],
    });
    if (selection.canceled) return null;
    const character = project.characters.find((item) => item.id === cid);
    if (!character) throw new Error("Personagem não encontrado.");
    const filename = selection.filePaths[0];
    if (nativeImage.createFromPath(filename).isEmpty())
      throw new Error("Não foi possível abrir a imagem escolhida.");
    character.image = store.asset(id, filename);
    store.save();
    return library();
  });
  handle("character-photo", (id, cid) => {
    const character = store
      .project(id)
      .characters.find((item) => item.id === cid);
    if (!character?.image) return null;
    const photo = nativeImage.createFromPath(character.image);
    if (photo.isEmpty()) return null;
    const { width, height } = photo.getSize();
    return (
      Math.max(width, height) > 1200
        ? photo.resize(width >= height ? { width: 1200 } : { height: 1200 })
        : photo
    ).toDataURL();
  });
  handle("save-clip-frame", async (jobId, index, position, name) => {
    const job = jobById(jobId);
    const clip = Number.isInteger(index) ? job.files[index] : null;
    if (!clip) throw new Error("Escolha um clipe já salvo.");
    if (position !== "start" && position !== "end")
      throw new Error("Escolha o início ou o fim do clipe.");

    const binary = await ffmpeg();
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "aivid-frame-"));
    try {
      const frame = path.join(temp, "quadro.png");
      // Write each frame near the end to the same file, leaving the final one.
      const input = position === "end" ? ["-sseof", "-0.5"] : [];
      const output = position === "start" ? ["-frames:v", "1"] : [];
      await exec(binary, [
        "-hide_banner",
        "-loglevel",
        "error",
        ...input,
        "-i",
        clip,
        "-map",
        "0:v:0",
        ...output,
        "-update",
        "1",
        frame,
      ]);
      const project = store.project(job.projectId);
      const scene = job.scenes[index];
      (project.environments ??= []).push({
        id: randomUUID(),
        name:
          String(name || "")
            .trim()
            .slice(0, 100) ||
          `${scene?.name || "Clipe"} · ${position === "end" ? "fim" : "início"}`,
        prompt: scene?.prompt || "",
        image: store.asset(project.id, frame),
      });
      store.save();
      return library();
    } finally {
      await fsp.rm(temp, { recursive: true, force: true });
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
    backgroundColor: "#101021",
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
  window.on("close", (event) => {
    if (!working || quitting) return;
    event.preventDefault();
    app.quit();
  });
});
app.on("before-quit", (event) => {
  if (
    quitting ||
    (!working && !store?.data.jobs.some((job) => job.status === "queued"))
  )
    return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  void (async () => {
    try {
      for (const job of store.data.jobs) {
        if (job.status === "queued") job.status = "cancelled";
      }
      persist();
      const task = active || activeImage;
      if (task) await stopGeneration(task);
      if (working) await new Promise((resolve) => idleWaiters.add(resolve));
      quitting = true;
      app.quit();
    } catch (error) {
      closing = false;
      dialog.showErrorBox("Não foi possível encerrar a geração", error.message);
    }
  })();
});
app.on("window-all-closed", () => app.quit());
