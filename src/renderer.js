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
const durations = [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20];
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
      resolution: $("resolution").value,
      duration: Number($("duration").value),
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
      duration: Number(el.querySelector(".scene-duration").value),
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
  $("model").value = p.settings.modelId;
  $("resolution").value = p.settings.resolution;
  $("duration").innerHTML = durations
    .map((d) => option(d, `${d} segundos`, d === p.settings.duration))
    .join("");
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
          `<section class="scene-card" data-id="${esc(s.id)}"><div class="scene-heading"><span class="scene-number">${String(i + 1).padStart(2, "0")}</span><input class="scene-name" aria-label="Nome da cena ${i + 1}" value="${esc(s.name)}" maxlength="100"><button class="remove-scene" title="Mover para cima" data-action="up">↑</button><button class="remove-scene" title="Mover para baixo" data-action="down">↓</button><button class="remove-scene" title="Remover cena" data-action="remove">×</button></div><div class="scene-cast">${p.characters.map((c) => `<label><input type="checkbox" value="${esc(c.id)}" ${(s.characterIds || []).includes(c.id) ? "checked" : ""}>${esc(c.name)}</label>`).join("")}</div><textarea class="scene-prompt" aria-label="Prompt da cena ${i + 1}" rows="5" placeholder="Descreva a ação desta cena, os gestos e o movimento da câmera…">${esc(s.prompt)}</textarea><div class="scene-controls"><label>Duração<select class="scene-duration">${durations.map((d) => option(d, `${d}s`, d === s.duration)).join("")}</select></label><label>Imagem inicial<select class="scene-reference">${option("", "Só o prompt / continuidade", !s.reference)}${s.image ? option("scene", "Imagem desta cena", s.reference === "scene") : ""}${p.characters.map((c) => option(c.id, c.name, s.reference === c.id)).join("")}</select></label></div>${s.preview ? `<img class="scene-thumb" src="${esc(s.preview)}" alt="Imagem inicial da cena ${i + 1}">` : ""}<div class="scene-actions"><button class="small secondary" data-action="image">＋ Imagem da cena</button><button class="small secondary" data-action="generate">Gerar só esta cena ↗</button></div></section>`,
      )
      .join("") || '<p class="hint">Adicione a primeira cena para começar.</p>';
  updateCount();
  renderJobs();
}
function updateCount() {
  const cards = [...document.querySelectorAll(".scene-card")];
  const seconds = cards.reduce(
    (n, c) => n + Number(c.querySelector(".scene-duration").value),
    0,
  );
  $("scene-count").textContent =
    `${cards.length} cena${cards.length === 1 ? "" : "s"} · ${seconds}s no total`;
  $("generate").disabled = cards.length === 0;
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
          return `<article class="job" data-id="${esc(j.id)}"><div class="job-top"><div><div class="job-title">${esc(j.scenes.length === 1 ? j.scenes[0].name : j.projectName)}</div><div class="job-meta">${j.scenes.length} cena${j.scenes.length === 1 ? "" : "s"} · ${esc(j.project.settings.resolution)} · ${new Date(j.createdAt).toLocaleString("pt-BR")}</div></div><span class="job-status">${labels[j.status] || esc(j.status)}</span></div>${busy ? `<progress max="100" value="${progress}"></progress>` : ""}${j.error ? `<p class="job-error">${esc(j.error)}</p>` : ""}<div class="job-bottom"><p>${j.status === "running" ? `Cena ${j.scene || 1} de ${j.scenes.length} · ${progress}%` : j.status === "queued" ? "Aguardando sua vez" : `${j.files.length} clipe(s) salvo(s)${j.elapsedSeconds ? " · " + Math.round(j.elapsedSeconds / 60) + " min" : ""}`}<br>${j.folder ? esc(j.folder) : ""}</p><div class="job-actions">${j.output ? '<button data-action="play" class="small secondary">Abrir vídeo</button>' : ""}${j.folder ? '<button data-action="folder" class="small secondary">Ver clipes ↗</button>' : ""}${busy ? '<button data-action="cancel" class="small secondary">Cancelar</button>' : ""}</div></div></article>`;
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
      scenes: [{ name: "Cena 1", prompt: "", duration: 10 }],
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
      duration: p.settings.duration,
      characterIds: p.characters.map((c) => c.id),
    });
    updateData(await api.saveProject(p));
  });
$("scenes").onchange = updateCount;
$("scenes").onclick = (e) => {
  const button = e.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest(".scene-card");
  action(async () => {
    await save();
    const sid = card.dataset.id;
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
$("jobs").onclick = (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const id = b.closest("[data-id]").dataset.id;
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
