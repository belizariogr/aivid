const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  Module = require("node:module");
const { pathToFileURL } = require("node:url");
test("fluxo de geração salva só a cena escolhida e seus parâmetros, com índice original", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aivid-generation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "engine-output.mp4");
  fs.writeFileSync(source, "generated video bytes");
  const handlers = new Map(),
    requests = [];
  class FakeEngine {
    async generateEnvironment(request) {
      assert.match(request.prompt, /cartoon/);
      assert.match(request.prompt, /empty background plate/);
      assert.match(request.prompt, /Preserve the reference art direction/);
      assert.ok(request.imagePath.endsWith(".png"));
      return { status: "complete", image_paths: [environment] };
    }
    async prepare(model) {
      assert.equal(model, "ltx-2.3-22b-distilled-1.1");
    }
    async generate(request) {
      requests.push(request);
      return { status: "complete", video_path: source };
    }
  }
  class Window {
    constructor() {
      this.webContents = { send() {}, setWindowOpenHandler() {}, on() {} };
    }
    loadFile() {}
    on() {}
    isDestroyed() {
      return false;
    }
  }
  const electron = {
    app: {
      setName() {},
      setPath() {},
      getPath(name) {
        return root;
      },
      requestSingleInstanceLock() {
        return true;
      },
      on() {},
      whenReady() {
        return Promise.resolve();
      },
      quit() {},
    },
    BrowserWindow: Window,
    ipcMain: {
      handle(name, fn) {
        handlers.set(name, fn);
      },
    },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    powerSaveBlocker: {
      start() {
        return 1;
      },
      isStarted() {
        return true;
      },
      stop() {},
    },
    nativeImage: {
      createFromPath: () => ({
        resize: () => ({ toDataURL: () => "data:image/png;base64," }),
      }),
    },
    dialog: {},
    shell: {},
  };
  const original = Module._load,
    enginePath = require.resolve("../src/ltx.cjs"),
    prior = require.cache[enginePath];
  require.cache[enginePath] = {
    id: enginePath,
    filename: enginePath,
    loaded: true,
    exports: { Ltx: FakeEngine },
  };
  Module._load = function (name, ...args) {
    return name === "electron" ? electron : original.call(this, name, ...args);
  };
  try {
    require("../src/main.cjs");
    await new Promise(setImmediate);
  } finally {
    Module._load = original;
    if (prior) require.cache[enginePath] = prior;
    else delete require.cache[enginePath];
  }
  const event = {
    senderFrame: {
      url: pathToFileURL(path.resolve(__dirname, "../src/index.html")).href,
    },
  };
  const invoke = async (name, ...args) => {
    const r = await handlers.get(name)(event, ...args);
    assert.equal(r.ok, true, r.error);
    return r.value;
  };
  let view = await invoke("save-project", {
    name: "História",
    scenes: [
      { name: "Antes", prompt: "Primeira ação. Duração: 6 segundos." },
      { name: "Depois", prompt: "Segunda ação", duration: 2 },
    ],
  });
  const p = view.projects[0];
  electron.dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [root],
  });
  await invoke("choose-output", p.id);
  const environment = path.join(root, "praça.png");
  fs.writeFileSync(environment, "reference image");
  electron.dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [environment],
  });
  const withEnvironment = await invoke("scene-image", p.id);
  const savedEnvironment = withEnvironment.projects[0].environmentImage;
  assert.notEqual(savedEnvironment, environment);
  await invoke("save-project", p);
  await invoke("enqueue", p.id, p.scenes[1].id);
  let jobs;
  for (let n = 0; n < 100; n++) {
    await new Promise((r) => setTimeout(r, 10));
    jobs = (await invoke("library")).jobs;
    if (jobs[0]?.status === "complete" || jobs[0]?.status === "error") break;
  }
  assert.equal(jobs[0].status, "complete", jobs[0].error);
  assert.equal(jobs[0].files.length, 1);
  assert.equal(path.basename(jobs[0].files[0]), "cena-02.mp4");
  assert.equal(
    fs.readFileSync(jobs[0].files[0], "utf8"),
    "generated video bytes",
  );
  assert.equal(requests[0].duration, 2);
  assert.equal(requests[0].resolution, "720p");
  assert.match(requests[0].prompt, /Segunda ação/);
  assert.doesNotMatch(requests[0].prompt, /Primeira ação/);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(jobs[0].folder, "cena-02.json")),
  );
  assert.equal(metadata.request.audio, false);
  assert.equal(p.scenes[0].duration, null);
  const uploaded = await invoke("environment-reference", p.id, p.scenes[1].id);
  await invoke("generate-environment", p.id, p.scenes[1].id, {
    prompt: "Faça em cartoon e pinte a barraca de azul.",
    reference: uploaded.id,
    backgroundOnly: true,
  });
  assert.equal((await invoke("library")).projects[0].environments.length, 0);
  const approved = (
    await invoke("approve-environment", p.id, p.scenes[1].id, "Praça azul")
  ).projects[0];
  const frame = approved.environments[0];
  assert.equal(approved.scenes[1].reference, `env:${frame.id}`);
  await invoke("save-project", {
    ...approved,
    scenes: [
      { ...approved.scenes[0], reference: `env:${frame.id}` },
      approved.scenes[1],
    ],
  });
  await invoke("enqueue", p.id, p.scenes[0].id);
  for (let n = 0; n < 100; n++) {
    await new Promise((r) => setTimeout(r, 10));
    jobs = (await invoke("library")).jobs;
    if (["complete", "error"].includes(jobs[1].status)) break;
  }
  assert.equal(jobs[1].status, "complete", jobs[1].error);
  assert.equal(requests[1].duration, 6);
  assert.equal(requests[0].imagePath, savedEnvironment);
  assert.equal(requests[1].imagePath, frame.image);
  assert.match(
    requests[1].prompt,
    /Use the attached image as the opening frame/,
  );
  await invoke("enqueue", p.id, null, true);
  for (let n = 0; n < 100; n++) {
    await new Promise((r) => setTimeout(r, 10));
    jobs = (await invoke("library")).jobs;
    if (["complete", "error"].includes(jobs[2].status)) break;
  }
  assert.equal(jobs[2].status, "complete", jobs[2].error);
  assert.deepEqual(
    jobs[2].files.map((file) => path.basename(file)),
    ["sequencia.mp4"],
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[2].duration, 8);
  assert.equal(requests[2].imagePath, frame.image);
  assert.match(
    requests[2].prompt,
    /0–6 seconds: Primeira ação.*\n6–8 seconds: Segunda ação/,
  );
  await invoke("save-project", {
    ...approved,
    scenes: approved.scenes.map((scene) => ({ ...scene, duration: 20 })),
  });
  const tooLong = await handlers.get("enqueue")(event, p.id, null, true);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /ultrapassa 20 s/);
  assert.equal((await invoke("library")).jobs.length, 3);

  const bad = await handlers
    .get("library")({ senderFrame: { url: "https://example.com" } })
    .catch(() => null);
  assert.equal(bad, null);
});
