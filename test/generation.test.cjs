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
    nativeImage: {},
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
      { name: "Antes", prompt: "Primeira ação", duration: 5 },
      { name: "Depois", prompt: "Segunda ação", duration: 2 },
    ],
  });
  const p = view.projects[0];
  electron.dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [root],
  });
  await invoke("choose-output", p.id);
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
  const bad = await handlers
    .get("library")({ senderFrame: { url: "https://example.com" } })
    .catch(() => null);
  assert.equal(bad, null);
});
