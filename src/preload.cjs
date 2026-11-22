const { contextBridge, ipcRenderer } = require("electron");
const invoke = async (name, ...args) => {
  const result = await ipcRenderer.invoke(name, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld("aivid", {
  library: () => invoke("library"),
  playlist: (id) => invoke("playlist", id),
  saveProject: (p) => invoke("save-project", p),
  chooseOutput: (id) => invoke("choose-output", id),
  addCharacter: (id, name) => invoke("add-character", id, name),
  editCharacter: (id, cid, p) => invoke("edit-character", id, cid, p),
  removeCharacter: (id, cid) => invoke("remove-character", id, cid),
  sceneImage: (id, sid) => invoke("scene-image", id, sid),
  chooseEnvironment: (id) => invoke("scene-image", id),
  removeEnvironment: (id) => invoke("remove-environment", id),
  environmentReference: (id, sid) => invoke("environment-reference", id, sid),
  generateEnvironment: (id, sid, input) =>
    invoke("generate-environment", id, sid, input),
  approveEnvironment: (id, sid, name) =>
    invoke("approve-environment", id, sid, name),
  connect: () => invoke("connect"),
  openLtx: () => invoke("open-ltx"),
  enqueue: (id, r) => invoke("enqueue", id, r),
  cancel: (id) => invoke("cancel", id),
  openOutput: (id, r) => invoke("open-output", id, r),
  onJobs: (callback) => {
    const listener = (_e, jobs) => callback(jobs);
    ipcRenderer.on("jobs", listener);
    return () => ipcRenderer.removeListener("jobs", listener);
  },
});
