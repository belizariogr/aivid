const api = window.aivid;
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let data = { projects: [], jobs: [] },
  selected = null,
  editingCharacter = null,
  toastTimer;
const { durations, estimateDuration, sequenceDuration } = window.aividDuration;
function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => ($("toast").hidden = true),
    error ? 9000 : 3500,
  );
}
async function action(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}
function project() {
  return data.projects.find((p) => p.id === selected);
}
function option(value, label, selected) {
  return `<option value="${esc(value)}" ${selected ? "selected" : ""}>${esc(label)}</option>`;
}
function updateData(next) {
  data = next;
  if (!selected || !data.projects.some((p) => p.id === selected))
    selected = data.projects[0]?.id || null;
  render();
}
function readForm() {
  const p = project();
  if (!p) return;
  return {
    ...p,
    name: $("project-name").value,
    description: $("description").value,
    settings: {
      ...p.settings,
      resolution: $("resolution").value,
      fps: Number($("fps").value),
      aspectRatio: $("aspect").value,
      seed: Number($("seed").value),
      chain: $("chain").checked,
      merge: false,
      modelId: $("model").value,
    },
    scenes: [...document.querySelectorAll(".scene-card")].map((el) => ({
      id: el.dataset.id,
      name: el.querySelector(".scene-name").value,
      prompt: el.querySelector(".scene-prompt").value,
      duration: Number(el.querySelector(".scene-duration").value) || null,
      reference: el.querySelector(".scene-reference").value,
      characterIds: [...el.querySelectorAll(".scene-cast input:checked")].map(
        (i) => i.value,
      ),
    })),
  };
}
async function save() {
  const p = readForm();
  if (p) {
    data = await api.saveProject(p);
    return project();
  }
}
function render() {
  $("projects").innerHTML = data.projects
    .map(
      (p) =>
        `<button class="project-item ${p.id === selected ? "active" : ""}" data-id="${esc(p.id)}">◈ &nbsp; ${esc(p.name)}</button>`,
    )
    .join("");
  const p = project();
  $("empty").hidden = !!p;
  $("editor").hidden = !p;
  $("save").hidden = !p;
  $("watch").hidden = !p;
  if (!p) {
    $("heading").textContent = "Um lugar para suas histórias.";
    return;
  }
  $("heading").textContent = p.name;
  $("subtitle").textContent = "Seu elenco, suas cenas. Um clipe de cada vez.";
  $("project-name").value = p.name;
  $("description").value = p.description;
  const environment = $("environment-preview");
  environment.hidden = !p.environmentPreview;
  if (p.environmentPreview) environment.src = p.environmentPreview;
  else environment.removeAttribute("src");
  $("choose-environment").textContent = p.environmentImage
    ? "Trocar imagem do ambiente"
    : "Adicionar imagem do ambiente";
  $("remove-environment").hidden = !p.environmentImage;
  $("model").value = p.settings.modelId;
  $("resolution").value = p.settings.resolution;
  $("fps").value = p.settings.fps;
  $("aspect").value = p.settings.aspectRatio;
  $("seed").value = p.settings.seed;
  $("chain").checked = p.settings.chain;
  $("output-path").textContent = p.outputDir || "Nenhuma pasta selecionada";
  $("choose-output").textContent = p.outputDir
    ? "⌁ Alterar pasta"
    : "⌁ Escolher pasta";
  $("characters").innerHTML = p.characters.length
    ? p.characters
        .map(
          (c) =>
            `<button class="character-card" data-id="${esc(c.id)}" title="Editar ${esc(c.name)}"><img src="${esc(c.preview || "")}" alt="${esc(c.name)}"><span>${esc(c.name)}</span></button>`,
        )
        .join("")
    : '<div class="characters-empty">Adicione as imagens do seu elenco para reutilizar em todas as cenas.</div>';
  $("scenes").innerHTML =
    (p.scenes || [])
      .map(
        (s, i) =>
          `<section class="scene-card" data-id="${esc(s.id)}"><div class="scene-heading"><span class="scene-number">${String(i + 1).padStart(2, "0")}</span><input class="scene-name" aria-label="Nome da cena ${i + 1}" value="${esc(s.name)}" maxlength="100"><button class="remove-scene" title="Mover para cima" data-action="up">↑</button><button class="remove-scene" title="Mover para baixo" data-action="down">↓</button><button class="remove-scene" title="Remover cena" data-action="remove">×</button></div><div class="scene-cast">${p.characters.map((c) => `<label><input type="checkbox" value="${esc(c.id)}" ${(s.characterIds || []).includes(c.id) ? "checked" : ""}>${esc(c.name)}</label>`).join("")}</div><textarea class="scene-prompt" aria-label="Prompt da cena ${i + 1}" rows="5" placeholder="Descreva a ação desta cena, os gestos e o movimento da câmera…">${esc(s.prompt)}</textarea><div class="scene-controls"><label>Duração<select class="scene-duration">${option("", "Automática", s.duration == null)}${durations.map((d) => option(d, `${d}s`, d === s.duration)).join("")}</select></label><label>Imagem inicial<select class="scene-reference">${option("", "Padrão do projeto", !s.reference)}${p.environmentImage ? option("environment", "Ambiente do projeto", s.reference === "environment") : ""}${option("text", "Só o prompt", s.reference === "text")}${(p.environments || []).map((entry) => option(`env:${entry.id}`, entry.name, s.reference === `env:${entry.id}`)).join("")}${s.image ? option("scene", "Imagem desta cena", s.reference === "scene") : ""}${p.characters.map((c) => option(c.id, c.name, s.reference === c.id)).join("")}</select></label></div>${s.preview ? `<img class="scene-thumb" src="${esc(s.preview)}" alt="Imagem inicial da cena ${i + 1}">` : ""}<div class="scene-actions"><button class="small secondary" data-action="image">Importar quadro</button><button class="small secondary" data-action="scene-preview">✦ Gerar prévia da cena</button><button class="small secondary" data-action="environment">Gerar ambiente</button><button class="small secondary" data-action="generate">Gerar só esta cena ↗</button></div></section>`,
      )
      .join("") || '<p class="hint">Adicione a primeira cena para começar.</p>';
  updateCount();
  renderJobs();
}
function updateCount() {
  const cards = [...document.querySelectorAll(".scene-card")];
  let estimated = false;
  let missing = false;
  let emptyPrompt = false;
  let seconds = 0;
  for (const card of cards) {
    const selector = card.querySelector(".scene-duration");
    const estimate = estimateDuration(
      card.querySelector(".scene-prompt").value,
    );
    selector.options[0].textContent =
      estimate === null ? "Automática" : `Automática (~${estimate} s)`;
    emptyPrompt ||= estimate === null;
    const manual = Number(selector.value);
    estimated ||= !manual && estimate !== null;
    missing ||= !manual && estimate === null;
    seconds += manual || estimate || 0;
  }
  const total = missing
    ? " · escreva os prompts para estimar"
    : cards.length
      ? ` · ${estimated ? "~" : ""}${seconds} s no total`
      : "";
  $("scene-count").textContent =
    `${cards.length} cena${cards.length === 1 ? "" : "s"}${total}`;
  $("generate").disabled = cards.length === 0;
  const continuous = $("generate-continuous");
  const clipDuration = sequenceDuration(seconds);
  continuous.disabled = !cards.length || emptyPrompt || clipDuration === null;
  continuous.textContent =
    seconds > 20
      ? "Clipe contínuo · limite de 20 s"
      : !emptyPrompt && seconds > 0
        ? `✦ Gerar clipe contínuo · ${clipDuration} s`
        : "✦ Gerar clipe contínuo";
}
function renderJobs() {
  const jobs = data.jobs
    .filter((j) => j.projectId === selected)
    .slice()
    .reverse();
  $("jobs-count").textContent =
    `${jobs.length} ${jobs.length === 1 ? "geração" : "gerações"}`;
  const labels = {
    queued: "Na fila",
    running: "Gerando",
    complete: "Concluído",
    error: "Erro",
    cancelled: "Cancelado",
    interrupted: "Interrompido",
  };
  $("jobs").innerHTML = jobs.length
    ? jobs
        .map((j) => {
          const busy = ["queued", "running"].includes(j.status);
          const progress =
            j.status === "complete"
              ? 100
              : Math.min(
                  99,
                  Math.round(
                    ((Math.max(1, j.scene) - 1 + (j.progress || 0) / 100) /
                      j.scenes.length) *
                      100,
                  ),
                );
          return `<article class="job" data-id="${esc(j.id)}"><div class="job-top"><div><div class="job-title">${esc(j.scenes.length === 1 ? j.scenes[0].name : j.projectName)}</div><div class="job-meta">${j.scenes.length} cena${j.scenes.length === 1 ? "" : "s"} · ${esc(j.project.settings.resolution)} · ${new Date(j.createdAt).toLocaleString("pt-BR")}</div></div><span class="job-status">${labels[j.status] || esc(j.status)}</span></div>${busy ? `<progress max="100" value="${progress}"></progress>` : ""}${j.error ? `<p class="job-error">${esc(j.error)}</p>` : ""}<div class="job-bottom"><p>${j.status === "running" ? `Cena ${j.scene || 1} de ${j.scenes.length} · ${progress}%` : j.status === "queued" ? "Aguardando sua vez" : `${j.files.length} clipe(s) salvo(s)${j.elapsedSeconds ? " · " + Math.round(j.elapsedSeconds / 60) + " min" : ""}`}<br>${j.folder ? esc(j.folder) : ""}</p><div class="job-actions">${j.output ? '<button data-action="play" class="small secondary">Abrir vídeo</button>' : ""}${j.files.length ? '<button data-action="frame" class="small secondary">Salvar quadro</button>' : ""}${j.folder ? '<button data-action="folder" class="small secondary">Ver clipes ↗</button>' : ""}${busy ? '<button data-action="cancel" class="small secondary">Cancelar</button>' : ""}</div></div></article>`;
        })
        .join("")
    : '<p class="hint">Seus clipes e o andamento das gerações aparecerão aqui.</p>';
}
function newProject() {
  $("new-name").value = "";
  $("new-dialog").showModal();
  $("new-name").focus();
}
$("new-project").onclick = newProject;
$("empty-new").onclick = newProject;
$("new-cancel").onclick = () => $("new-dialog").close();
$("new-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (project()) await save();
    data = await api.saveProject({
      name: $("new-name").value,
      scenes: [{ name: "Cena 1", prompt: "" }],
    });
    selected = data.projects[0].id;
    $("new-dialog").close();
    render();
  });
};
$("projects").onclick = (e) => {
  const el = e.target.closest("[data-id]");
  if (el)
    action(async () => {
      await save();
      selected = el.dataset.id;
      render();
    });
};
$("save").onclick = () =>
  action(async () => {
    await save();
    render();
    toast("Projeto salvo neste Mac.");
  });
$("choose-output").onclick = () =>
  action(async () => {
    await save();
    updateData(await api.chooseOutput(selected));
  });
$("choose-environment").onclick = () =>
  action(async () => {
    await save();
    updateData(await api.chooseEnvironment(selected));
  });
$("remove-environment").onclick = () =>
  action(async () => {
    await save();
    updateData(await api.removeEnvironment(selected));
  });
$("add-character").onclick = () =>
  action(async () => {
    await save();
    updateData(await api.addCharacter(selected));
  });
$("characters").onclick = (e) => {
  const el = e.target.closest("[data-id]");
  if (!el) return;
  editingCharacter = el.dataset.id;
  const c = project().characters.find((c) => c.id === editingCharacter);
  $("character-name").value = c.name;
  $("character-description").value = c.description;
  $("character-dialog").showModal();
};
$("character-cancel").onclick = () => $("character-dialog").close();
$("character-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    await save();
    updateData(
      await api.editCharacter(selected, editingCharacter, {
        name: $("character-name").value,
        description: $("character-description").value,
      }),
    );
    $("character-dialog").close();
  });
};
$("character-remove").onclick = () =>
  action(async () => {
    await save();
    updateData(await api.removeCharacter(selected, editingCharacter));
    $("character-dialog").close();
  });
$("add-scene").onclick = () =>
  action(async () => {
    await save();
    const p = project();
    p.scenes.push({
      name: `Cena ${p.scenes.length + 1}`,
      prompt: "",
      characterIds: p.characters.map((c) => c.id),
    });
    updateData(await api.saveProject(p));
  });
$("scenes").oninput = updateCount;
$("scenes").onclick = (e) => {
  const button = e.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest(".scene-card");
  action(async () => {
    await save();
    const sid = card.dataset.id;
    if (button.dataset.action === "environment") openEnvironment(sid);
    if (button.dataset.action === "scene-preview") {
      openEnvironment(sid, true);
      if ($("environment-prompt").value.trim()) await generateSceneImage();
    }
    if (button.dataset.action === "image")
      updateData(await api.sceneImage(selected, sid));
    if (button.dataset.action === "generate") {
      await api.enqueue(selected, sid);
      toast("Cena adicionada à fila.");
    }
    if (["up", "down"].includes(button.dataset.action)) {
      const scenes = project().scenes;
      const from = scenes.findIndex((s) => s.id === sid),
        to = from + (button.dataset.action === "up" ? -1 : 1);
      if (to >= 0 && to < scenes.length) {
        [scenes[from], scenes[to]] = [scenes[to], scenes[from]];
        updateData(await api.saveProject(project()));
      }
    }
    if (button.dataset.action === "remove") {
      project().scenes = project().scenes.filter((s) => s.id !== sid);
      updateData(await api.saveProject(project()));
    }
  });
};
$("generate").onclick = () =>
  action(async () => {
    await save();
    await api.enqueue(selected);
    toast("Cenas adicionadas à fila.");
  });
$("generate-continuous").onclick = () =>
  action(async () => {
    await save();
    await api.enqueue(selected, null, true);
    toast("Clipe contínuo adicionado à fila.");
  });
$("jobs").onclick = (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const id = b.closest("[data-id]").dataset.id;
  if (b.dataset.action === "frame") {
    openClipFrame(id);
    return;
  }
  action(() =>
    b.dataset.action === "cancel"
      ? api.cancel(id)
      : api.openOutput(id, b.dataset.action === "folder"),
  );
};
async function connect() {
  try {
    const c = await api.connect();
    $("connection").textContent = c.models.length
      ? "LTX conectado · geração local"
      : "LTX conectado · instale um modelo";
    $("connection").classList.add("connected");
  } catch (e) {
    $("connection").textContent = "LTX desconectado";
    $("connection").classList.remove("connected");
    throw e;
  }
}
$("connect").onclick = () => action(connect);
$("open-ltx").onclick = () =>
  action(async () => {
    await api.openLtx();
    toast("LTX aberto. Aguarde iniciar e clique em Conectar novamente.");
  });
api.onJobs((jobs) => {
  data.jobs = jobs;
  renderJobs();
});
action(async () => {
  updateData(await api.library());
  try {
    await connect();
  } catch {
    /* A conexão pode ser feita depois pelo botão lateral. */
  }
});

let chapters = [],
  chapterIndex = -1;
function renderChapters() {
  $("chapters").innerHTML = chapters
    .map(
      (s, i) =>
        `<button class="chapter ${i === chapterIndex ? "playing" : ""}" data-index="${i}" ${s.src ? "" : "disabled"}><span>${String(s.number).padStart(2, "0")}</span><div>${esc(s.title)}<small>${s.src ? (i === chapterIndex ? "Reproduzindo" : "Pronta para assistir") : "Ainda não gerada"}</small></div></button>`,
    )
    .join("");
  $("previous").disabled = !chapters.some((s, i) => i < chapterIndex && s.src);
  $("next").disabled = !chapters.some((s, i) => i > chapterIndex && s.src);
}
function playChapter(index) {
  if (!chapters[index]?.src) return;
  chapterIndex = index;
  $("video").src = chapters[index].src;
  $("now-playing").textContent =
    `${chapters[index].number}. ${chapters[index].title}`;
  renderChapters();
  $("video")
    .play()
    .catch(() => toast("Clique no play do vídeo para iniciar."));
}
$("watch").onclick = () =>
  action(async () => {
    await save();
    chapters = await api.playlist(selected);
    if (!chapters.some((s) => s.src))
      throw new Error("Gere pelo menos uma cena para assistir à sequência.");
    $("player-heading").textContent = project().name;
    $("player-dialog").showModal();
    playChapter(chapters.findIndex((s) => s.src));
  });
$("chapters").onclick = (e) => {
  const b = e.target.closest("[data-index]");
  if (b) playChapter(Number(b.dataset.index));
};
$("next").onclick = () => {
  const i = chapters.findIndex((s, i) => i > chapterIndex && s.src);
  if (i >= 0) playChapter(i);
};
$("previous").onclick = () => {
  const indices = chapters
    .map((s, i) => (s.src && i < chapterIndex ? i : -1))
    .filter((i) => i >= 0);
  if (indices.length) playChapter(indices.at(-1));
};
$("video").onerror = () =>
  toast(
    "Não foi possível reproduzir este clipe. Confira se o arquivo ainda existe na pasta de saída.",
    true,
  );
$("video").onended = () => {
  const i = chapters.findIndex((s, i) => i > chapterIndex && s.src);
  if (i >= 0) playChapter(i);
  else $("now-playing").textContent = "Sequência concluída";
};
$("player-close").onclick = () => $("player-dialog").close();
$("player-dialog").onclose = () => {
  $("video").pause();
  $("video").removeAttribute("src");
  $("video").load();
};

let environmentSceneId,
  scenePreviewMode = false,
  environmentBusy = false;
function openEnvironment(id, preview = false) {
  const p = project();
  const scene = p.scenes.find((item) => item.id === id);
  environmentSceneId = id;
  scenePreviewMode = preview;
  $("environment-title").textContent = preview
    ? "Prévia da cena"
    : "Gerar ambiente";
  $("environment-draft").alt = preview
    ? "Imagem de prévia da cena"
    : "Prévia do ambiente gerado";
  $("environment-background-only").closest("label").hidden = preview;
  const approved = p.environments?.find(
    (entry) => scene.reference === `env:${entry.id}`,
  );
  $("environment-background-only").checked = false;
  $("environment-name").value = approved?.name || scene.name;
  $("environment-prompt").value = preview
    ? scene.prompt
    : approved?.prompt || scene.environmentPrompt || scene.prompt;
  let source = "";
  if (approved) source = `env:${approved.id}`;
  else if (scene.reference === "scene" && scene.image) source = "scene";
  else if (
    preview &&
    p.characters.some((character) => character.id === scene.reference)
  )
    source = `cast:${scene.reference}`;
  else if (p.environmentImage && (!preview || scene.reference !== "text"))
    source = "project";
  $("environment-source").innerHTML =
    option("", "Nenhuma · gerar pelo texto", !source) +
    (p.environmentImage
      ? option("project", "Ambiente do projeto", source === "project")
      : "") +
    (scene.image
      ? option("scene", "Quadro importado da cena", source === "scene")
      : "") +
    p.characters
      .map((character) =>
        option(
          `cast:${character.id}`,
          `Personagem: ${character.name}`,
          source === `cast:${character.id}`,
        ),
      )
      .join("") +
    (p.environments || [])
      .map((entry) =>
        option(`env:${entry.id}`, entry.name, entry.id === approved?.id),
      )
      .join("");
  $("environment-draft").hidden = true;
  $("environment-draft").removeAttribute("src");
  $("environment-approve").disabled = true;
  $("environment-generate").textContent = "Gerar prévia";
  $("environment-status").textContent = "";
  $("environment-dialog").showModal();
}
$("environment-close").onclick = () => $("environment-dialog").close();
$("environment-dialog").addEventListener("cancel", (event) => {
  if (environmentBusy) event.preventDefault();
});
$("environment-upload").onclick = () =>
  action(async () => {
    const source = await api.environmentReference(selected, environmentSceneId);
    if (!source) return;
    const select = $("environment-source");
    select.querySelector("[data-upload]")?.remove();
    const entry = new Option(source.name, source.id, true, true);
    entry.dataset.upload = "";
    select.append(entry);
    select.value = source.id;
  });
async function generateSceneImage() {
  if (environmentBusy) return;
  const prompt = $("environment-prompt").value.trim();
  if (!prompt) {
    $("environment-status").textContent =
      "Descreva como deve ser o primeiro quadro.";
    return;
  }
  environmentBusy = true;
  const buttons = [
    "environment-generate",
    "environment-upload",
    "environment-close",
    "environment-prompt",
    "environment-source",
    "environment-background-only",
  ];
  for (const id of buttons) $(id).disabled = true;
  $("environment-approve").disabled = true;
  $("environment-status").textContent = "Gerando imagem localmente…";
  try {
    const draft = await api.generateEnvironment(selected, environmentSceneId, {
      prompt,
      reference: $("environment-source").value,
      backgroundOnly: $("environment-background-only").checked,
      scenePreview: scenePreviewMode,
    });
    $("environment-draft").src = draft.preview;
    $("environment-draft").hidden = false;
    $("environment-status").textContent =
      "Revise a prévia ou ajuste o prompt e gere novamente.";
    $("environment-generate").textContent = "Gerar novamente";
    $("environment-approve").disabled = false;
  } catch (error) {
    $("environment-status").textContent = error.message;
    $("environment-approve").disabled = $("environment-draft").hidden;
  } finally {
    environmentBusy = false;
    for (const id of buttons) $(id).disabled = false;
  }
}
$("environment-generate").onclick = generateSceneImage;
$("environment-approve").onclick = () =>
  action(async () => {
    updateData(
      await api.approveEnvironment(
        selected,
        environmentSceneId,
        $("environment-name").value,
      ),
    );
    $("environment-dialog").close();
    toast("Quadro inicial aprovado e disponível para outras cenas.");
  });

let clipFrameJob;
function fillClipFrameName() {
  const index = Number($("clip-frame-clip").value);
  const position = $("clip-frame-position").value === "end" ? "fim" : "início";
  const title = clipFrameJob.scenes[index]?.name || `Clipe ${index + 1}`;
  $("clip-frame-name").value = `${title} · ${position}`.slice(0, 100);
}
function openClipFrame(id) {
  clipFrameJob = data.jobs.find((job) => job.id === id);
  $("clip-frame-clip").innerHTML = clipFrameJob.files
    .map((_, index) =>
      option(index, clipFrameJob.scenes[index]?.name || `Clipe ${index + 1}`),
    )
    .join("");
  $("clip-frame-position").value = "end";
  $("clip-frame-status").textContent = "";
  fillClipFrameName();
  $("clip-frame-dialog").showModal();
}
$("clip-frame-clip").onchange = fillClipFrameName;
$("clip-frame-position").onchange = fillClipFrameName;
$("clip-frame-close").onclick = () => $("clip-frame-dialog").close();
$("clip-frame-dialog").addEventListener("cancel", (event) => {
  if ($("clip-frame-save").disabled) event.preventDefault();
});
$("clip-frame-form").onsubmit = async (event) => {
  event.preventDefault();
  const submit = $("clip-frame-save");
  if (submit.disabled) return;
  submit.disabled = $("clip-frame-close").disabled = true;
  $("clip-frame-status").textContent = "Salvando referência…";
  try {
    await save();
    updateData(
      await api.saveClipFrame(
        clipFrameJob.id,
        Number($("clip-frame-clip").value),
        $("clip-frame-position").value,
        $("clip-frame-name").value,
      ),
    );
    $("clip-frame-dialog").close();
    toast("Quadro salvo na biblioteca do projeto.");
  } catch (error) {
    $("clip-frame-status").textContent = error.message;
  } finally {
    submit.disabled = $("clip-frame-close").disabled = false;
  }
};
