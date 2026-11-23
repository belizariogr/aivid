import { editPhoto, readFile, pickFile } from "./cropper.js";
import { openPlayer } from "./player.js";

// ---------- utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mediaUrl = (file, v = "") => (file ? `/media?path=${encodeURIComponent(file)}&v=${encodeURIComponent(v)}` : "");
const fmtTime = (t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.round(t % 60)).padStart(2, "0")}`;
const uid = () => crypto.randomUUID();
const sceneSeconds = (scene) => scene.blocks.reduce((t, b) => t + Number(b.duration || 0), 0);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "X-Takes": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erro ${res.status}`), { details: data.details });
  return data;
}

// No app do Mac, a área de transferência passa pela janela nativa quando o WebKit recusa.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    const native = window.webkit?.messageHandlers?.takes;
    if (!native) throw error;
    native.postMessage({ type: "copy", text });
  }
}

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4000);
}
const fail = (e) => toast(e.message, "error");

// ---------- estado ----------
const state = {
  projects: [],
  project: null,
  tab: "overview",
  sceneId: null,
  jobs: [],
  ltx: null,
  modal: null, // { type, ... }
  llm: { request: "", seconds: "", inline: false, text: "", fileName: "", script: "", result: null, error: null, target: "" },
  previewForm: { sceneId: "", backgroundId: "", strength: 0.6, withCharacters: true, prompt: "" },
};

const TABS = [
  ["overview", "Projeto"],
  ["characters", "Personagens"],
  ["backgrounds", "Fundos"],
  ["scenes", "Cenas"],
  ["previews", "Prévias"],
  ["queue", "Fila"],
];
const CONTINUITY_LABEL = {
  continue: "Continuar o movimento (extend)",
  frame: "Partir do último quadro",
  cut: "Corte — novo plano",
};
const STATE_LABEL = { empty: "Não gerado", ready: "Pronto", stale: "Desatualizado", missing: "Arquivo ausente" };

// ---------- salvamento ----------
let saveTimer = null;
let saving = Promise.resolve();
let pendingSaves = 0;
function scheduleSave(delay = 500) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const p = state.project;
  if (!p) return saving;
  const payload = {
    name: p.name,
    prePrompt: p.prePrompt,
    negativePrompt: p.negativePrompt,
    outputDir: p.outputDir,
    settings: p.settings,
    characters: p.characters,
    backgrounds: p.backgrounds,
    scenes: p.scenes,
  };
  pendingSaves++;
  saving = saving
    .then(() => api("PUT", `/api/projects/${p.id}`, payload))
    .then((server) => absorb(server))
    .catch(fail)
    .finally(() => pendingSaves--);
  return saving;
}

// Incorpora dados controlados pelo servidor (takes, fotos, prévias) sem perder o que está sendo digitado.
function absorb(server) {
  const local = state.project;
  if (!local || local.id !== server.id) return;
  const before = ownedSignature(local);
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const sChars = byId(server.characters);
  for (const c of local.characters) if (sChars.has(c.id)) c.photo = sChars.get(c.id).photo;
  for (const c of server.characters) if (!local.characters.some((x) => x.id === c.id)) local.characters.push(c);
  const sBgs = byId(server.backgrounds);
  local.backgrounds = local.backgrounds.filter((b) => sBgs.has(b.id));
  for (const b of local.backgrounds) b.image = sBgs.get(b.id).image;
  for (const b of server.backgrounds) if (!local.backgrounds.some((x) => x.id === b.id)) local.backgrounds.push(b);
  local.previews = server.previews;
  const sScenes = byId(server.scenes);
  for (const s of server.scenes) if (!local.scenes.some((x) => x.id === s.id)) local.scenes.push(s);
  for (const s of local.scenes) {
    const ss = sScenes.get(s.id);
    if (!ss) continue;
    s.start = ss.start;
    s.backgroundId = ss.backgroundId;
    const sb = byId(ss.blocks);
    for (const b of s.blocks) {
      const x = sb.get(b.id);
      if (!x) continue;
      b.takes = x.takes;
      b.selectedTakeId = x.selectedTakeId;
      b.state = x.state;
    }
  }
  local.updatedAt = server.updatedAt;
  const entry = state.projects.find((p) => p.id === server.id);
  if (entry) Object.assign(entry, { name: local.name, scenes: local.scenes.length });
  if (ownedSignature(local) !== before) render();
}
function ownedSignature(p) {
  return JSON.stringify([
    p.characters.map((c) => [c.id, c.photo]),
    p.backgrounds.map((b) => [b.id, b.image]),
    p.previews.map((x) => x.id),
    p.scenes.map((s) => [s.id, s.start, s.blocks.map((b) => [b.id, b.selectedTakeId, b.state, b.takes.length])]),
  ]);
}

async function refreshProject() {
  if (!state.project) return;
  absorb(await api("GET", `/api/projects/${state.project.id}`));
}

// ---------- ligação de campos ----------
// data-bind: p.campo | p.settings.campo | c.<id>.campo | g.<id>.campo | s.<id>.campo | k.<sceneId>.<blockId>.campo
function target(bind) {
  const p = state.project;
  const [kind, ...rest] = bind.split(".");
  if (kind === "p") {
    if (rest[0] === "settings") return [p.settings, rest[1]];
    return [p, rest[0]];
  }
  if (kind === "c") return [p.characters.find((c) => c.id === rest[0]), rest[1]];
  if (kind === "g") return [p.backgrounds.find((b) => b.id === rest[0]), rest[1]];
  if (kind === "s") return [p.scenes.find((s) => s.id === rest[0]), rest[1]];
  if (kind === "k") return [p.scenes.find((s) => s.id === rest[0])?.blocks.find((b) => b.id === rest[1]), rest[2]];
  return [null, null];
}
function readValue(el) {
  const t = el.dataset.type;
  if (el.type === "checkbox") return el.checked;
  if (t === "number") return el.value === "" ? null : Number(el.value);
  return el.value;
}
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.dataset.bind || !state.project) return;
  const [obj, key] = target(el.dataset.bind);
  if (!obj) return;
  obj[key] = readValue(el);
  scheduleSave();
  if (el.dataset.live) updateLive();
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.bind && el.dataset.rerender) render();
  const fn = el.dataset.change && changes[el.dataset.change];
  if (fn) fn(el);
});

// Atualiza rótulos derivados (tempos dos blocos) sem refazer a tela.
function updateLive() {
  const scene = currentScene();
  if (!scene) return;
  let t = 0;
  scene.blocks.forEach((b) => {
    const el = document.querySelector(`[data-range="${b.id}"]`);
    if (el) el.textContent = `${fmtTime(t)}–${fmtTime(t + Number(b.duration || 0))}`;
    t += Number(b.duration || 0);
  });
  const total = document.querySelector("[data-total]");
  if (total) total.textContent = fmtTime(t);
}

// ---------- renderização ----------
function render() {
  const active = document.activeElement;
  const focusKey = active?.dataset?.bind || active?.dataset?.focus;
  const sel = focusKey && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
  const scrollY = $("#main").scrollTop;

  renderSidebar();
  $("#main").innerHTML = state.project ? projectView() : welcomeView();
  renderModal();
  renderTopbar();

  $("#main").scrollTop = scrollY;
  if (focusKey) {
    const el = document.querySelector(`[data-bind="${CSS.escape(focusKey)}"], [data-focus="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel && el.setSelectionRange) {
        try {
          el.setSelectionRange(...sel);
        } catch {
          /* campos numéricos não aceitam seleção */
        }
      }
    }
  }
}

function renderTopbar() {
  const l = state.ltx;
  const el = $("#ltx-status");
  if (!l) el.textContent = "LTX…";
  else if (!l.connected) {
    el.textContent = "LTX desconectado";
    el.className = "chip bad";
    el.title = l.error || "";
  } else {
    el.textContent = `LTX · ${l.model?.label ?? "sem modelo"}${l.busy ? " · ocupado" : ""}`;
    el.className = `chip ${l.busy ? "warn" : "ok"}`;
    el.title = l.imageGeneration ? "Vídeo e imagem locais disponíveis" : "Geração local de imagens indisponível (instale o Z-Image Turbo no LTX)";
  }
  const running = state.jobs.filter((j) => j.status === "running");
  const queued = state.jobs.filter((j) => j.status === "queued");
  const q = $("#queue-status");
  if (running.length) {
    const j = running[0];
    q.textContent = `Gerando ${jobPercent(j)}%${queued.length ? ` · +${queued.length} na fila` : ""}`;
    q.className = "chip warn";
  } else {
    q.textContent = queued.length ? `${queued.length} na fila` : "Fila vazia";
    q.className = "chip";
  }
}

function renderSidebar() {
  $("#project-list").innerHTML =
    state.projects
      .map(
        (p) => `<button class="project-item ${state.project?.id === p.id ? "active" : ""}" data-action="open-project" data-id="${p.id}">
          <strong>${esc(p.name)}</strong><small>${p.scenes} ${p.scenes === 1 ? "cena" : "cenas"}</small></button>`,
      )
      .join("") || `<p class="muted pad">Nenhum projeto ainda.</p>`;
}

function welcomeView() {
  return `<section class="welcome">
    <h1>Takes</h1>
    <p>Cenas longas e contínuas com o LTX Desktop, geradas em blocos de até 20 segundos.</p>
    <ol>
      <li>Abra o <strong>LTX Desktop</strong> e espere carregar (o status aparece no topo).</li>
      <li>Crie um projeto, defina o pré-prompt e a pasta de saída.</li>
      <li>Cadastre personagens e fundos, escreva as cenas em blocos — ou peça o roteiro a uma LLM.</li>
      <li>Gere, assista à cena inteira e confira as emendas entre os blocos.</li>
    </ol>
    <button class="btn primary" data-action="new-project">Criar projeto</button>
  </section>`;
}

function projectView() {
  const p = state.project;
  const tabs = TABS.map(([id, label]) => {
    const badge = id === "queue" ? state.jobs.filter((j) => ["queued", "running"].includes(j.status)).length : 0;
    return `<button class="tab ${state.tab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}${badge ? ` <span class="badge">${badge}</span>` : ""}</button>`;
  }).join("");
  const body = { overview, characters, backgrounds, scenes, previews, queue }[state.tab]();
  return `<div class="project-head">
      <input class="title-input" data-bind="p.name" value="${esc(p.name)}" aria-label="Nome do projeto">
      <div class="tabs">${tabs}</div>
    </div>
    <div class="tab-body">${body}</div>`;
}

const option = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current) ? "selected" : ""}>${esc(label)}</option>`;

function overview() {
  const p = state.project;
  const s = p.settings;
  return `<div class="grid-2">
    <section class="card">
      <h3>Pré-prompt do projeto</h3>
      <p class="hint">Instruções gerais que entram antes de <em>todo</em> prompt de vídeo e imagem: estilo visual, época, lente, luz, regras. Escreva em inglês para melhores resultados.</p>
      <textarea data-bind="p.prePrompt" rows="8" placeholder="Ex.: Cinematic 35mm film look, warm golden-hour light, shallow depth of field, handheld camera, realistic textures…">${esc(p.prePrompt)}</textarea>
      <h4>Prompt negativo</h4>
      <textarea data-bind="p.negativePrompt" rows="2" placeholder="Ex.: blurry, distorted faces, text, watermark">${esc(p.negativePrompt)}</textarea>
    </section>
    <section class="card">
      <h3>Pasta de saída</h3>
      <p class="hint">Cada cena ganha uma subpasta com um MP4 por bloco (<code>bloco-01.mp4</code>, <code>bloco-02.mp4</code>…) para edição posterior. Novas versões viram <code>_take-2</code>, <code>_take-3</code>. As prévias ficam em <code>previas/</code>.</p>
      <div class="path-row">
        <code class="path">${esc(p.outputDir || "Nenhuma pasta escolhida")}</code>
        <button class="btn" data-action="pick-output">Escolher…</button>
        ${p.outputDir ? `<button class="btn ghost" data-action="reveal" data-path="${esc(p.outputDir)}">Abrir</button>` : ""}
      </div>
      <input data-bind="p.outputDir" value="${esc(p.outputDir)}" placeholder="/Users/você/Movies/meu-projeto" class="mono">
      <h3>Vídeo</h3>
      <div class="form-grid">
        <label>Resolução<select data-bind="p.settings.resolution">${["360p", "540p", "720p", "1080p"].map((r) => option(r, r, s.resolution)).join("")}</select></label>
        <label>Proporção<select data-bind="p.settings.aspectRatio">${["16:9", "9:16", "1:1", "4:3", "3:2", "4:5", "21:9"].map((r) => option(r, r, s.aspectRatio)).join("")}</select></label>
        <label>FPS<select data-bind="p.settings.fps" data-type="number">${[24, 25, 48, 50].map((r) => option(r, r, s.fps)).join("")}</select></label>
        <label>Seed<input data-bind="p.settings.seed" data-type="number" type="number" min="0" value="${s.seed ?? ""}" placeholder="aleatória"></label>
        <label title="Quantos segundos do fim do bloco anterior o LTX recebe para continuar o movimento">Contexto da continuação<select data-bind="p.settings.contextSeconds" data-type="number">${[1, 2, 3, 4, 5].map((r) => option(r, `${r} s`, s.contextSeconds)).join("")}</select></label>
        <label class="check"><input type="checkbox" data-bind="p.settings.audio" ${s.audio ? "checked" : ""}> Gerar áudio</label>
      </div>
      <p class="hint">Mude as configurações de vídeo antes de gerar a cena: os blocos de continuação herdam a resolução do bloco anterior.</p>
    </section>
    <section class="card">
      <h3>Roteiro com LLM</h3>
      <p class="hint">Baixe o arquivo do projeto, cole as instruções em uma LLM (ChatGPT, Claude, Gemini…) e importe o roteiro da cena que ela devolver.</p>
      <button class="btn primary" data-action="open-llm">Abrir assistente de roteiro</button>
    </section>
    <section class="card danger-zone">
      <h3>Excluir projeto</h3>
      <p class="hint">Move o projeto para a lixeira da biblioteca do Takes. Os vídeos da pasta de saída não são apagados.</p>
      <button class="btn danger" data-action="delete-project">Excluir projeto</button>
    </section>
  </div>`;
}

function avatar(c, size = "md") {
  return c.photo
    ? `<img class="avatar ${size}" src="${mediaUrl(c.photo, c.photo)}" alt="">`
    : `<div class="avatar ${size} empty">${esc((c.name || "?").slice(0, 1).toUpperCase())}</div>`;
}

function characters() {
  const p = state.project;
  return `<div class="toolbar"><button class="btn primary" data-action="new-character">＋ Novo personagem</button>
    <span class="hint">A aparência e o figurino entram no prompt das cenas em que o personagem aparece.</span></div>
    <div class="cards">${
      p.characters
        .map(
          (c) => `<button class="char-card" data-action="edit-character" data-id="${c.id}">${avatar(c, "lg")}<strong>${esc(c.name)}</strong><small>${esc(c.role || "")}</small></button>`,
        )
        .join("") || `<p class="muted">Nenhum personagem cadastrado.</p>`
    }</div>`;
}

function backgrounds() {
  const p = state.project;
  return `<div class="toolbar"><button class="btn primary" data-action="upload-background">＋ Enviar imagem de referência</button>
    <span class="hint">A imagem serve de base para as prévias e pode ser o quadro inicial de uma cena. A descrição entra no prompt das cenas que usam o fundo.</span></div>
    <div class="bg-grid">${
      p.backgrounds
        .map(
          (b) => `<div class="card bg-card">
            <img src="${mediaUrl(b.image, b.image)}" alt="">
            <input data-bind="g.${b.id}.name" value="${esc(b.name)}" placeholder="Nome">
            <textarea data-bind="g.${b.id}.description" rows="3" placeholder="Descrição do ambiente (em inglês): lugar, época, luz, objetos…">${esc(b.description)}</textarea>
            <div class="row"><button class="btn small" data-action="preview-from-bg" data-id="${b.id}">Gerar prévia com este fundo</button><button class="btn small ghost danger" data-action="delete-background" data-id="${b.id}">Excluir</button></div>
          </div>`,
        )
        .join("") || `<p class="muted">Nenhum fundo enviado.</p>`
    }</div>`;
}

function currentScene() {
  return state.project?.scenes.find((s) => s.id === state.sceneId) ?? null;
}

function sceneJob(sceneId) {
  return state.jobs.find((j) => j.kind === "video" && j.sceneId === sceneId && ["queued", "running"].includes(j.status));
}

function scenes() {
  const p = state.project;
  if (!currentScene() && p.scenes.length) state.sceneId = p.scenes[0].id;
  const scene = currentScene();
  const list = p.scenes
    .map((s, i) => {
      const states = s.blocks.map((b) => b.state || "empty");
      const ready = states.filter((x) => x === "ready").length;
      const job = sceneJob(s.id);
      return `<button class="scene-item ${s.id === state.sceneId ? "active" : ""}" data-action="select-scene" data-id="${s.id}">
        <span class="num">${i + 1}</span><span class="grow"><strong>${esc(s.title)}</strong>
        <small>${s.blocks.length} blocos · ${fmtTime(sceneSeconds(s))} · ${ready}/${s.blocks.length} prontos${job ? " · na fila" : ""}</small></span></button>`;
    })
    .join("");
  return `<div class="scenes-layout">
    <div class="scene-list">
      ${list || `<p class="muted pad">Nenhuma cena.</p>`}
      <button class="btn block-btn" data-action="new-scene">＋ Nova cena</button>
      <button class="btn ghost block-btn" data-action="open-llm">Importar roteiro de LLM</button>
    </div>
    <div class="scene-editor">${scene ? sceneEditor(scene) : `<p class="muted">Crie uma cena para começar.</p>`}</div>
  </div>`;
}

function startOptions(scene) {
  const p = state.project;
  const current = `${scene.start.kind}:${scene.start.id ?? ""}`;
  return [
    option("none:", "Nenhuma — o 1º bloco nasce só do texto", current),
    ...p.backgrounds.map((b) => option(`background:${b.id}`, `Fundo: ${b.name}`, current)),
    ...p.previews.map((x, i) => option(`preview:${x.id}`, `Prévia ${p.previews.length - i}${x.sceneId === scene.id ? " (desta cena)" : ""} · ${new Date(x.createdAt).toLocaleString("pt-BR")}`, current)),
  ].join("");
}

function startImageFile(scene) {
  const p = state.project;
  if (scene.start.kind === "background") return p.backgrounds.find((b) => b.id === scene.start.id)?.image;
  if (scene.start.kind === "preview") return p.previews.find((x) => x.id === scene.start.id)?.file;
  return null;
}

function castChips(selected, bindAction, extra = "") {
  const p = state.project;
  if (!p.characters.length) return `<span class="muted">Cadastre personagens na aba Personagens.</span>`;
  return p.characters
    .map(
      (c) =>
        `<button class="cast-chip ${selected.includes(c.id) ? "on" : ""}" data-action="${bindAction}" data-id="${c.id}" ${extra}>${avatar(c, "xs")}${esc(c.name)}</button>`,
    )
    .join("");
}

function sceneEditor(scene) {
  const p = state.project;
  const job = sceneJob(scene.id);
  const running = job?.status === "running" ? job : null;
  const start = startImageFile(scene);
  const allReady = scene.blocks.length && scene.blocks.every((b) => b.state === "ready");
  let t = 0;
  const blocks = scene.blocks
    .map((b, i) => {
      const html = blockCard(scene, b, i, t, running);
      t += Number(b.duration || 0);
      return html;
    })
    .join("");
  return `<div class="card">
      <div class="scene-head">
        <input class="scene-title" data-bind="s.${scene.id}.title" value="${esc(scene.title)}" aria-label="Título da cena">
        <div class="row">
          <button class="btn icon" data-action="move-scene" data-dir="-1" title="Mover para cima">↑</button>
          <button class="btn icon" data-action="move-scene" data-dir="1" title="Mover para baixo">↓</button>
          <button class="btn ghost danger" data-action="delete-scene">Excluir cena</button>
        </div>
      </div>
      <textarea data-bind="s.${scene.id}.synopsis" rows="2" placeholder="Sinopse da cena (referência sua e da LLM; não entra no prompt)">${esc(scene.synopsis)}</textarea>
      <div class="scene-setup">
        <div>
          <label>Fundo (descrição entra no prompt)
            <select data-change="scene-background">${option("", "Nenhum", scene.backgroundId ?? "")}${p.backgrounds.map((b) => option(b.id, b.name, scene.backgroundId ?? "")).join("")}</select>
          </label>
          <label>Imagem inicial do 1º bloco
            <select data-change="scene-start">${startOptions(scene)}</select>
          </label>
          <div class="label">Elenco da cena</div>
          <div class="chips">${castChips(scene.characterIds, "toggle-scene-cast")}</div>
        </div>
        <div class="start-thumb">${start ? `<img src="${mediaUrl(start, start)}" alt="Imagem inicial">` : `<div class="placeholder">Sem imagem inicial</div>`}
          <button class="btn small" data-action="preview-for-scene">Gerar prévia do ambiente</button></div>
      </div>
      <div class="scene-actions">
        <button class="btn primary" data-action="generate-scene" ${job ? "disabled" : ""}>${job ? "Na fila…" : "Gerar cena inteira"}</button>
        <button class="btn" data-action="generate-missing" ${job ? "disabled" : ""}>Gerar só os pendentes</button>
        ${job ? `<button class="btn danger" data-action="cancel-job" data-id="${job.id}">Cancelar</button>` : ""}
        <button class="btn" data-action="play-scene">▶ Assistir cena</button>
        <button class="btn ghost" data-action="export-scene" ${allReady ? "" : "disabled"} title="Une todos os blocos em um MP4 para conferência">Exportar unida</button>
        <span class="grow"></span>
        <span class="total">Duração total <strong data-total>${fmtTime(t)}</strong></span>
      </div>
      ${running ? `<div class="job-inline">${jobLine(running)}</div>` : ""}
    </div>
    <div class="blocks">${blocks}</div>
    <button class="btn block-btn" data-action="add-block">＋ Adicionar bloco</button>`;
}

function blockCard(scene, b, i, t, running) {
  const take = b.takes.find((x) => x.id === b.selectedTakeId);
  const isRunning = running && running.current?.index === i;
  const isQueued = running && running.blockIds.includes(b.id) && !isRunning && running.current?.index < i;
  const st = isRunning ? "running" : isQueued ? "queued" : b.state || "empty";
  const label = isRunning ? `Gerando ${running.stepProgress ?? 0}%` : isQueued ? "Na fila" : STATE_LABEL[st];
  const custom = b.characterIds != null;
  return `<article class="block card st-${st}">
    <div class="block-head">
      <span class="block-num">${i + 1}</span>
      <span class="range" data-range="${b.id}">${fmtTime(t)}–${fmtTime(t + Number(b.duration || 0))}</span>
      <span class="status ${st}">${label}</span>
      ${st === "stale" ? `<span class="hint">O bloco anterior mudou depois desta geração. Gere de novo para manter a continuidade.</span>` : ""}
      <span class="grow"></span>
      <button class="btn icon" data-action="move-block" data-id="${b.id}" data-dir="-1" title="Subir">↑</button>
      <button class="btn icon" data-action="move-block" data-id="${b.id}" data-dir="1" title="Descer">↓</button>
      <button class="btn icon" data-action="duplicate-block" data-id="${b.id}" title="Duplicar">⧉</button>
      <button class="btn icon danger" data-action="delete-block" data-id="${b.id}" title="Excluir">✕</button>
    </div>
    <div class="block-body">
      <div class="block-fields">
        <div class="form-row">
          ${
            i === 0
              ? `<span class="pill">Abre a cena${startImageFile(scene) ? " a partir da imagem inicial" : " só pelo texto"}</span>`
              : `<select data-bind="k.${scene.id}.${b.id}.continuity" data-rerender="1">${Object.entries(CONTINUITY_LABEL).map(([v, l]) => option(v, l, b.continuity)).join("")}</select>`
          }
          <label class="inline">Duração <input type="number" min="2" max="20" step="1" data-type="number" data-live="1" data-change="clamp-duration" data-bind="k.${scene.id}.${b.id}.duration" value="${b.duration}"> s</label>
        </div>
        <textarea data-bind="k.${scene.id}.${b.id}.prompt" rows="4" placeholder="O que acontece neste bloco (em inglês): ação, movimento, câmera, luz…">${esc(b.prompt)}</textarea>
        <div class="cast-row">
          <label class="check"><input type="checkbox" data-change="block-cast-custom" data-scene="${scene.id}" data-id="${b.id}" ${custom ? "checked" : ""}> Elenco próprio neste bloco</label>
          ${custom ? `<div class="chips">${castChips(b.characterIds, "toggle-block-cast", `data-block="${b.id}"`)}</div>` : `<span class="muted small">usa o elenco da cena</span>`}
        </div>
      </div>
      <div class="block-media">
        ${take ? `<video src="${mediaUrl(take.file, take.id)}" preload="metadata" muted controls></video>` : `<div class="placeholder">${isRunning ? (running.phase ? esc(running.phase) : "Gerando…") : "Sem vídeo"}</div>`}
        <div class="row">
          ${
            b.takes.length > 1
              ? `<select data-change="select-take" data-scene="${scene.id}" data-id="${b.id}">${b.takes.map((x, n) => option(x.id, `Take ${n + 1}`, b.selectedTakeId)).join("")}</select>`
              : ""
          }
          <button class="btn small" data-action="generate-block" data-id="${b.id}" ${running ? "disabled" : ""}>${take ? "Gerar de novo" : "Gerar"}</button>
          ${i < scene.blocks.length - 1 ? `<button class="btn small ghost" data-action="generate-from" data-index="${i}" ${running ? "disabled" : ""} title="Gera este bloco e todos os seguintes">Daqui em diante</button>` : ""}
          ${take ? `<button class="btn small ghost" data-action="reveal" data-path="${esc(take.file)}">Finder</button>` : ""}
        </div>
      </div>
    </div>
  </article>`;
}

function previews() {
  const p = state.project;
  const f = state.previewForm;
  const job = state.jobs.find((j) => j.kind === "preview" && j.projectId === p.id && ["queued", "running"].includes(j.status));
  const gallery = p.previews
    .map(
      (x) => `<div class="card preview-card">
        <a href="${mediaUrl(x.file, x.id)}" target="_blank"><img src="${mediaUrl(x.file, x.id)}" alt=""></a>
        <small class="muted">${new Date(x.createdAt).toLocaleString("pt-BR")}${x.sceneId ? ` · ${esc(p.scenes.find((s) => s.id === x.sceneId)?.title ?? "")}` : ""}</small>
        <details><summary>Prompt</summary><pre>${esc(x.prompt)}</pre></details>
        <div class="row">
          <select data-change="preview-to-scene" data-id="${x.id}"><option value="">Usar como início de…</option>${p.scenes.map((s) => option(s.id, s.title, "")).join("")}</select>
          <button class="btn small" data-action="preview-to-background" data-id="${x.id}">Salvar como fundo</button>
          <button class="btn small ghost" data-action="reveal" data-path="${esc(x.file)}">Finder</button>
          <button class="btn small ghost danger" data-action="delete-preview" data-id="${x.id}" title="Remove da lista; o arquivo continua na pasta">Remover</button>
        </div>
      </div>`,
    )
    .join("");
  return `<div class="grid-2">
    <section class="card">
      <h3>Gerar prévia do ambiente</h3>
      <p class="hint">Uma imagem estática para ver como o ambiente vai ficar antes de gastar tempo com vídeo. Fica salva em <code>${esc(p.outputDir ? p.outputDir + "/previas" : "pasta de saída/previas")}</code> e pode virar a imagem inicial de uma cena.</p>
      <label>Cena<select data-change="pf" data-k="sceneId">${option("", "Nenhuma (só o pré-prompt e o texto abaixo)", f.sceneId)}${p.scenes.map((s) => option(s.id, s.title, f.sceneId)).join("")}</select></label>
      <label>Imagem de referência<select data-change="pf" data-k="backgroundId">${option("", "Nenhuma — gerar do zero", f.backgroundId)}${p.backgrounds.map((b) => option(b.id, b.name, f.backgroundId)).join("")}</select></label>
      ${f.backgroundId ? `<label>Quanto mudar a referência <span class="muted">${Math.round(f.strength * 100)}%</span><input type="range" min="0.1" max="1" step="0.05" value="${f.strength}" data-change="pf" data-k="strength"></label>` : ""}
      <label class="check"><input type="checkbox" data-change="pf" data-k="withCharacters" ${f.withCharacters ? "checked" : ""}> Incluir o elenco da cena (desmarque para gerar só o fundo)</label>
      <label>Descrição extra<textarea data-focus="pf-prompt" data-pf="prompt" rows="4" placeholder="Em branco usa o 1º bloco da cena. Ex.: wide shot of the kitchen at dawn, steam rising from a kettle…">${esc(f.prompt)}</textarea></label>
      <button class="btn primary" data-action="generate-preview" ${job ? "disabled" : ""}>${job ? "Gerando…" : "Gerar prévia"}</button>
      ${job ? `<div class="job-inline">${jobLine(job)}</div>` : ""}
    </section>
    <section class="preview-gallery">${gallery || `<p class="muted">Nenhuma prévia gerada.</p>`}</section>
  </div>`;
}

function jobPercent(j) {
  if (j.kind === "video" && j.current) return Math.round(((j.current.n - 1 + (j.stepProgress ?? 0) / 100) / j.current.total) * 100);
  return j.stepProgress ?? j.progress ?? 0;
}

function jobLine(j) {
  const pct = j.status === "complete" ? 100 : jobPercent(j);
  const eta = j.remainingSeconds ? ` · ~${Math.ceil(j.remainingSeconds / 60)} min restantes neste bloco` : "";
  return `<div class="progress"><div style="width:${pct}%"></div></div><small>${esc(j.phase || "")}${eta}</small>`;
}

const JOB_STATUS = { queued: "Na fila", running: "Gerando", complete: "Concluída", error: "Erro", cancelled: "Cancelada" };

function queue() {
  const name = (id) => state.projects.find((p) => p.id === id)?.name ?? "";
  const rows = [...state.jobs]
    .reverse()
    .map(
      (j) => `<div class="card job ${j.status}">
        <div class="row"><strong class="grow">${esc(j.title || j.kind)}</strong><span class="muted">${esc(name(j.projectId))}</span><span class="status ${j.status}">${JOB_STATUS[j.status]}</span></div>
        ${j.status === "running" ? jobLine(j) : ""}
        ${j.error ? `<pre class="error">${esc(j.error)}</pre>` : ""}
        ${j.kind === "avatar" && j.result?.draft ? `<small>Foto pronta — abra o personagem para usar.</small>` : ""}
        <div class="row">
          ${["queued", "running"].includes(j.status) ? `<button class="btn small danger" data-action="cancel-job" data-id="${j.id}">Cancelar</button>` : `<button class="btn small ghost" data-action="remove-job" data-id="${j.id}">Remover</button>`}
          ${j.steps?.length ? `<small class="muted">${j.steps.length} bloco(s) salvo(s)</small>` : ""}
        </div>
      </div>`,
    )
    .join("");
  return `<div class="toolbar"><button class="btn ghost" data-action="clear-jobs">Limpar concluídas</button>
    <span class="hint">O LTX gera uma coisa por vez; as tarefas rodam em ordem. Deixe o LTX Desktop aberto.</span></div>
    ${rows || `<p class="muted">Nenhuma tarefa.</p>`}`;
}

// ---------- modais ----------
function renderModal() {
  const root = $("#modal-root");
  const m = state.modal;
  if (!m) {
    root.innerHTML = "";
    return;
  }
  const content = m.type === "character" ? characterModal(m) : m.type === "llm" ? llmModal() : "";
  root.innerHTML = `<div class="overlay" data-action="overlay-close">${content}</div>`;
}

function characterModal(m) {
  const c = state.project.characters.find((x) => x.id === m.id);
  if (!c) return "";
  const job = [...state.jobs].reverse().find((j) => j.kind === "avatar" && j.characterId === c.id);
  const active = job && ["queued", "running"].includes(job.status);
  const draft = job?.status === "complete" && job.result?.draft && !m.dismissed?.includes(job.id) ? job : null;
  const field = (key, label, rows, hint = "") =>
    `<label>${label}${hint ? ` <span class="muted small">${hint}</span>` : ""}<textarea data-bind="c.${c.id}.${key}" rows="${rows}">${esc(c[key])}</textarea></label>`;
  return `<div class="modal wide" role="dialog" aria-label="Personagem">
    <div class="modal-head"><h2>${esc(c.name)}</h2><button class="icon-btn" data-action="close-modal" title="Fechar">✕</button></div>
    <div class="char-editor">
      <div class="char-photo">
        ${avatar(c, "xl")}
        <div class="col">
          <button class="btn" data-action="char-upload" data-id="${c.id}">Enviar foto…</button>
          ${c.photo ? `<button class="btn" data-action="char-edit-photo" data-id="${c.id}">Editar foto</button>` : ""}
          ${c.photo ? `<button class="btn ghost danger" data-action="char-remove-photo" data-id="${c.id}">Remover foto</button>` : ""}
        </div>
        <div class="card inset">
          <h4>Gerar foto com IA</h4>
          <textarea data-focus="avatar-prompt" rows="2" placeholder="Detalhes extras (opcional)">${esc(m.avatarPrompt || "")}</textarea>
          ${c.photo ? `<label class="check"><input type="checkbox" data-focus="avatar-from" ${m.fromPhoto ? "checked" : ""}> Partir da foto atual</label>` : ""}
          <button class="btn small primary" data-action="char-generate" data-id="${c.id}" ${active ? "disabled" : ""}>${active ? "Gerando…" : "Gerar a partir do perfil"}</button>
          ${active && job.status === "running" ? `<div class="job-inline">${jobLine(job)}</div>` : ""}
          ${job?.status === "error" ? `<small class="error">${esc(job.error)}</small>` : ""}
          ${
            draft
              ? `<div class="draft"><img src="${mediaUrl(draft.result.draft, draft.id)}" alt="Foto gerada"><div class="row">
                 <button class="btn small primary" data-action="char-apply-draft" data-id="${c.id}" data-job="${draft.id}">Usar esta foto</button>
                 <button class="btn small ghost" data-action="char-dismiss-draft" data-job="${draft.id}">Descartar</button></div></div>`
              : ""
          }
        </div>
      </div>
      <div class="char-fields">
        <label>Nome<input data-bind="c.${c.id}.name" value="${esc(c.name)}"></label>
        <label>Papel<input data-bind="c.${c.id}.role" value="${esc(c.role)}" placeholder="Ex.: protagonista, detetive aposentada"></label>
        ${field("appearance", "Aparência", 4, "entra no prompt — em inglês: idade, rosto, cabelo, corpo")}
        ${field("wardrobe", "Figurino", 2, "entra no prompt")}
        ${field("personality", "Personalidade", 3, "para a LLM e para você")}
        ${field("voice", "Voz e jeito de falar", 2)}
        ${field("notes", "Notas", 2)}
        <div class="row"><span class="grow"></span><button class="btn ghost danger" data-action="delete-character" data-id="${c.id}">Excluir personagem</button></div>
      </div>
    </div>
  </div>`;
}

function llmModal() {
  const p = state.project;
  const l = state.llm;
  const res = l.result;
  return `<div class="modal wide" role="dialog" aria-label="Roteiro com LLM">
    <div class="modal-head"><h2>Roteiro com LLM</h2><button class="icon-btn" data-action="close-modal" title="Fechar">✕</button></div>
    <div class="steps">
      <section>
        <h3><span class="step">1</span> Baixe o arquivo do projeto</h3>
        <p class="hint">Contém o pré-prompt, os personagens, os fundos, as cenas existentes, as regras do LTX (blocos de até 20 s) e o formato de resposta.</p>
        <a class="btn" href="/api/projects/${p.id}/llm-brief" download>Baixar ${esc(l.fileName || "arquivo do projeto")}</a>
      </section>
      <section>
        <h3><span class="step">2</span> Copie as instruções para a LLM</h3>
        <label>O que acontece na cena<textarea data-focus="llm-request" data-llm="request" rows="3" placeholder="Ex.: Ana chega à cafeteria na chuva, procura Bruno, os dois discutem e ela sai sem pedir nada.">${esc(l.request)}</textarea></label>
        <div class="form-row">
          <label class="inline">Duração total <input type="number" min="2" data-focus="llm-seconds" data-llm="seconds" value="${esc(l.seconds)}" placeholder="ex. 90"> s</label>
          <label class="check"><input type="checkbox" data-change="llm-inline" ${l.inline ? "checked" : ""}> Incluir o arquivo no texto (para LLMs sem anexo)</label>
        </div>
        <textarea class="mono" readonly rows="${l.inline ? 10 : 7}" data-focus="llm-text">${esc(l.text)}</textarea>
        <button class="btn primary" data-action="copy-llm">Copiar instruções</button>
      </section>
      <section>
        <h3><span class="step">3</span> Importe o roteiro devolvido</h3>
        <textarea class="mono" data-focus="llm-script" data-llm="script" rows="7" placeholder='Cole aqui a resposta da LLM (o JSON com "format": "takes.scene-script")'>${esc(l.script)}</textarea>
        <div class="row">
          <button class="btn" data-action="llm-open-file">Abrir arquivo .json…</button>
          <button class="btn" data-action="llm-validate">Validar</button>
          <select data-change="llm-target">${option("", "Adicionar como nova cena", l.target)}${p.scenes.map((s) => option(s.id, `Substituir: ${s.title}`, l.target)).join("")}</select>
          <button class="btn primary" data-action="llm-import">Importar</button>
        </div>
        ${l.error ? `<pre class="error">${esc(l.error)}</pre>` : ""}
        ${
          res
            ? `<div class="card inset">${res.scenes
                .map(
                  (s) => `<strong>${esc(s.title)}</strong> — ${s.blocks.length} blocos, ${fmtTime(sceneSeconds(s))}
                  <ol class="script-preview">${s.blocks.map((b) => `<li><span class="pill">${b.duration}s · ${b.continuity}</span> ${esc(b.prompt.slice(0, 180))}${b.prompt.length > 180 ? "…" : ""}</li>`).join("")}</ol>`,
                )
                .join("")}${res.warnings.length ? `<ul class="warn">${res.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</div>`
            : ""
        }
      </section>
    </div>
  </div>`;
}

let llmTimer = null;
function refreshLlmText() {
  clearTimeout(llmTimer);
  llmTimer = setTimeout(async () => {
    try {
      const r = await api("POST", `/api/projects/${state.project.id}/llm-prompt`, { request: state.llm.request, seconds: state.llm.seconds, inline: state.llm.inline });
      state.llm.text = r.text;
      state.llm.fileName = r.fileName;
      const el = document.querySelector('[data-focus="llm-text"]');
      if (el) el.value = r.text;
      else render();
    } catch (e) {
      fail(e);
    }
  }, 250);
}

// Campos de formulários locais (não salvos no projeto).
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.llm) {
    state.llm[el.dataset.llm] = el.value;
    if (el.dataset.llm !== "script") refreshLlmText();
    else {
      state.llm.result = null;
      state.llm.error = null;
    }
  }
  if (el.dataset.pf) state.previewForm[el.dataset.pf] = el.value;
  if (el.dataset.focus === "avatar-prompt" && state.modal) state.modal.avatarPrompt = el.value;
  if (el.dataset.focus === "avatar-from" && state.modal) state.modal.fromPhoto = el.checked;
});

// ---------- ações ----------
const actions = {
  async "new-project"() {
    const name = prompt("Nome do projeto:", "Novo projeto");
    if (name === null) return;
    const p = await api("POST", "/api/projects", { name });
    await loadProjects();
    openProject(p.id, p);
  },
  "open-project": ({ id }) => openProject(id),
  tab({ tab }) {
    state.tab = tab;
    render();
  },
  "open-queue"() {
    if (state.project) actions.tab({ tab: "queue" });
  },
  async "refresh-ltx"() {
    state.ltx = await api("GET", "/api/ltx");
    renderTopbar();
    if (!state.ltx.connected) toast(state.ltx.error, "error");
  },
  async "pick-output"() {
    await saveNow();
    const r = await api("POST", "/api/pick-folder", { start: state.project.outputDir });
    if (!r.path) return;
    state.project.outputDir = r.path;
    await saveNow();
    render();
  },
  async reveal({ path }) {
    await api("POST", "/api/reveal", { path });
  },
  async "delete-project"() {
    if (!confirm(`Excluir o projeto "${state.project.name}"? Os vídeos já gerados continuam na pasta de saída.`)) return;
    clearTimeout(saveTimer);
    await api("DELETE", `/api/projects/${state.project.id}`);
    state.project = null;
    await loadProjects();
    render();
  },
  // personagens
  async "new-character"() {
    await saveNow();
    const before = new Set(state.project.characters.map((c) => c.id));
    const server = await api("POST", `/api/projects/${state.project.id}/characters`, { name: "Novo personagem" });
    absorb(server);
    const created = state.project.characters.find((c) => !before.has(c.id));
    state.modal = { type: "character", id: created.id, dismissed: [] };
    render();
  },
  "edit-character"({ id }) {
    state.modal = { type: "character", id, dismissed: [] };
    render();
  },
  async "char-upload"({ id }) {
    const file = await pickFile();
    if (!file) return;
    const edited = await editPhoto(await readFile(file), { title: "Enquadrar foto" });
    if (!edited) return;
    absorb(await api("POST", `/api/projects/${state.project.id}/characters/${id}/photo`, { dataUrl: edited }));
  },
  async "char-edit-photo"({ id }) {
    const c = state.project.characters.find((x) => x.id === id);
    const edited = await editPhoto(mediaUrl(c.photo, c.photo));
    if (!edited) return;
    absorb(await api("POST", `/api/projects/${state.project.id}/characters/${id}/photo`, { dataUrl: edited }));
  },
  async "char-remove-photo"({ id }) {
    absorb(await api("DELETE", `/api/projects/${state.project.id}/characters/${id}/photo`));
  },
  async "char-generate"({ id }) {
    await saveNow();
    await api("POST", `/api/projects/${state.project.id}/characters/${id}/avatar`, { prompt: state.modal.avatarPrompt || "", fromPhoto: Boolean(state.modal.fromPhoto) });
  },
  async "char-apply-draft"({ id, job }) {
    const j = state.jobs.find((x) => x.id === job);
    const edited = await editPhoto(mediaUrl(j.result.draft, j.id), { title: "Ajustar foto gerada" });
    if (!edited) return;
    absorb(await api("POST", `/api/projects/${state.project.id}/characters/${id}/photo`, { dataUrl: edited }));
    state.modal.dismissed.push(job);
    render();
  },
  "char-dismiss-draft"({ job }) {
    state.modal.dismissed.push(job);
    render();
  },
  async "delete-character"({ id }) {
    const p = state.project;
    const c = p.characters.find((x) => x.id === id);
    if (!confirm(`Excluir ${c.name}?`)) return;
    p.characters = p.characters.filter((x) => x.id !== id);
    for (const s of p.scenes) {
      s.characterIds = s.characterIds.filter((x) => x !== id);
      for (const b of s.blocks) if (b.characterIds) b.characterIds = b.characterIds.filter((x) => x !== id);
    }
    state.modal = null;
    await saveNow();
    render();
  },
  // fundos
  async "upload-background"() {
    const file = await pickFile();
    if (!file) return;
    const dataUrl = await readFile(file);
    const name = file.name.replace(/\.[^.]+$/, "");
    absorb(await api("POST", `/api/projects/${state.project.id}/backgrounds`, { name, dataUrl, description: "" }));
    toast("Fundo enviado. Escreva uma descrição para ele entrar nos prompts.");
  },
  async "delete-background"({ id }) {
    if (!confirm("Excluir este fundo? Cenas que o usam ficam sem fundo.")) return;
    await saveNow();
    const server = await api("DELETE", `/api/projects/${state.project.id}/backgrounds/${id}`);
    state.project = server;
    render();
  },
  "preview-from-bg"({ id }) {
    state.previewForm.backgroundId = id;
    state.previewForm.withCharacters = false;
    actions.tab({ tab: "previews" });
  },
  // cenas
  "select-scene"({ id }) {
    state.sceneId = id;
    render();
  },
  async "new-scene"() {
    const scene = {
      id: uid(),
      title: `Cena ${state.project.scenes.length + 1}`,
      synopsis: "",
      characterIds: [],
      backgroundId: null,
      start: { kind: "none", id: null },
      blocks: [{ id: uid(), title: "", prompt: "", duration: 6, continuity: "cut", characterIds: null, takes: [], selectedTakeId: null, state: "empty" }],
    };
    state.project.scenes.push(scene);
    state.sceneId = scene.id;
    state.tab = "scenes";
    await saveNow();
    render();
  },
  async "delete-scene"() {
    const scene = currentScene();
    if (!confirm(`Excluir a cena "${scene.title}"? Os vídeos continuam na pasta de saída.`)) return;
    state.project.scenes = state.project.scenes.filter((s) => s.id !== scene.id);
    state.sceneId = state.project.scenes[0]?.id ?? null;
    await saveNow();
    render();
  },
  async "move-scene"({ dir }) {
    const list = state.project.scenes;
    const i = list.findIndex((s) => s.id === state.sceneId);
    const j = i + Number(dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await saveNow();
    render();
  },
  "toggle-scene-cast"({ id }) {
    const s = currentScene();
    s.characterIds = s.characterIds.includes(id) ? s.characterIds.filter((x) => x !== id) : [...s.characterIds, id];
    scheduleSave(0);
    render();
  },
  "toggle-block-cast"({ id, block }) {
    const b = currentScene().blocks.find((x) => x.id === block);
    b.characterIds = b.characterIds.includes(id) ? b.characterIds.filter((x) => x !== id) : [...b.characterIds, id];
    scheduleSave(0);
    render();
  },
  async "add-block"() {
    const s = currentScene();
    s.blocks.push({ id: uid(), title: "", prompt: "", duration: 6, continuity: "continue", characterIds: null, takes: [], selectedTakeId: null, state: "empty" });
    await saveNow();
    render();
    document.querySelector(".blocks .block:last-child textarea")?.focus();
  },
  async "duplicate-block"({ id }) {
    const s = currentScene();
    const i = s.blocks.findIndex((b) => b.id === id);
    const b = s.blocks[i];
    s.blocks.splice(i + 1, 0, { ...structuredClone(b), id: uid(), takes: [], selectedTakeId: null, state: "empty", continuity: "continue" });
    await saveNow();
    render();
  },
  async "move-block"({ id, dir }) {
    const list = currentScene().blocks;
    const i = list.findIndex((b) => b.id === id);
    const j = i + Number(dir);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await saveNow();
    render();
  },
  async "delete-block"({ id }) {
    const s = currentScene();
    const b = s.blocks.find((x) => x.id === id);
    if ((b.prompt || b.takes.length) && !confirm("Excluir este bloco? Os vídeos dele continuam na pasta de saída.")) return;
    s.blocks = s.blocks.filter((x) => x.id !== id);
    await saveNow();
    render();
  },
  async "generate-scene"() {
    await generate({ from: 0 });
  },
  async "generate-missing"() {
    await generate({ missing: true });
  },
  async "generate-block"({ id }) {
    await generate({ only: id });
  },
  async "generate-from"({ index }) {
    await generate({ from: Number(index) });
  },
  async "cancel-job"({ id }) {
    await api("POST", `/api/jobs/${id}/cancel`);
  },
  async "remove-job"({ id }) {
    await api("DELETE", `/api/jobs/${id}`);
  },
  async "clear-jobs"() {
    await api("POST", "/api/jobs/clear");
  },
  async "play-scene"() {
    await saveNow();
    const scene = currentScene();
    const list = await api("GET", `/api/projects/${state.project.id}/scenes/${scene.id}/playlist`);
    if (!list.some((i) => i.file)) return toast("Nenhum bloco desta cena foi gerado ainda.");
    openPlayer({ title: scene.title, items: list.map((i) => ({ ...i, src: i.file && i.state !== "missing" ? mediaUrl(i.file, i.blockId + i.file) : null })) });
  },
  async "export-scene"() {
    await saveNow();
    toast("Unindo os blocos…");
    const r = await api("POST", `/api/projects/${state.project.id}/scenes/${currentScene().id}/export`);
    toast(`Cena unida salva em ${r.file}`);
    await api("POST", "/api/reveal", { path: r.file });
  },
  "preview-for-scene"() {
    const s = currentScene();
    Object.assign(state.previewForm, { sceneId: s.id, backgroundId: s.backgroundId || "", withCharacters: true });
    actions.tab({ tab: "previews" });
  },
  // prévias
  async "generate-preview"() {
    await saveNow();
    const f = state.previewForm;
    await api("POST", `/api/projects/${state.project.id}/previews`, f);
    toast("Prévia na fila.");
  },
  async "delete-preview"({ id }) {
    await saveNow();
    state.project = await api("DELETE", `/api/projects/${state.project.id}/previews/${id}`);
    render();
  },
  async "preview-to-background"({ id }) {
    const name = prompt("Nome do fundo:", "Fundo da prévia");
    if (name === null) return;
    await saveNow();
    absorb(await api("POST", `/api/projects/${state.project.id}/previews/${id}/to-background`, { name }));
    toast("Salvo na aba Fundos.");
  },
  // LLM
  "open-llm"() {
    state.modal = { type: "llm" };
    render();
    refreshLlmText();
  },
  async "copy-llm"() {
    await copyText(state.llm.text);
    toast("Instruções copiadas. Cole na LLM junto com o arquivo.");
  },
  async "llm-open-file"() {
    const file = await pickFile("application/json,.json,.txt");
    if (!file) return;
    state.llm.script = await file.text();
    await actions["llm-validate"]();
  },
  async "llm-validate"() {
    try {
      state.llm.result = await api("POST", `/api/projects/${state.project.id}/import-script`, { text: state.llm.script, validateOnly: true });
      state.llm.error = null;
    } catch (e) {
      state.llm.result = null;
      state.llm.error = e.message;
    }
    render();
  },
  async "llm-import"() {
    await saveNow();
    try {
      const r = await api("POST", `/api/projects/${state.project.id}/import-script`, { text: state.llm.script, replaceSceneId: state.llm.target || null });
      state.project = r.project;
      state.sceneId = r.sceneIds[0];
      state.tab = "scenes";
      state.modal = null;
      state.llm = { ...state.llm, script: "", result: null, error: null, target: "" };
      await loadProjects();
      render();
      toast(r.warnings.length ? `Roteiro importado com ${r.warnings.length} aviso(s).` : "Roteiro importado.");
    } catch (e) {
      state.llm.error = e.message;
      render();
    }
  },
  "close-modal"() {
    state.modal = null;
    render();
  },
  "overlay-close"(_, el, event) {
    if (event.target === el) actions["close-modal"]();
  },
};

const changes = {
  "clamp-duration"(el) {
    const [block] = target(el.dataset.bind);
    if (!block) return;
    block.duration = Math.min(20, Math.max(2, Math.round(Number(el.value) || 6)));
    scheduleSave(0);
    render();
  },
  "scene-background"(el) {
    const s = currentScene();
    s.backgroundId = el.value || null;
    scheduleSave(0);
    render();
  },
  "scene-start"(el) {
    const s = currentScene();
    const [kind, id] = el.value.split(":");
    s.start = { kind, id: id || null };
    scheduleSave(0);
    render();
  },
  "block-cast-custom"(el) {
    const s = state.project.scenes.find((x) => x.id === el.dataset.scene);
    const b = s.blocks.find((x) => x.id === el.dataset.id);
    b.characterIds = el.checked ? [...s.characterIds] : null;
    scheduleSave(0);
    render();
  },
  "select-take"(el) {
    const s = state.project.scenes.find((x) => x.id === el.dataset.scene);
    const b = s.blocks.find((x) => x.id === el.dataset.id);
    b.selectedTakeId = el.value;
    saveNow();
  },
  pf(el) {
    const k = el.dataset.k;
    state.previewForm[k] = el.type === "checkbox" ? el.checked : k === "strength" ? Number(el.value) : el.value;
    if (k === "sceneId" && el.value) {
      const s = state.project.scenes.find((x) => x.id === el.value);
      if (s?.backgroundId && !state.previewForm.backgroundId) state.previewForm.backgroundId = s.backgroundId;
    }
    render();
  },
  async "preview-to-scene"(el) {
    if (!el.value) return;
    const s = state.project.scenes.find((x) => x.id === el.value);
    s.start = { kind: "preview", id: el.dataset.id };
    await saveNow();
    toast(`Imagem inicial de "${s.title}" atualizada.`);
    render();
  },
  "llm-inline"(el) {
    state.llm.inline = el.checked;
    refreshLlmText();
    render();
  },
  "llm-target"(el) {
    state.llm.target = el.value;
  },
};

async function generate(opts) {
  await saveNow();
  const scene = currentScene();
  const empty = scene.blocks.findIndex((b) => !b.prompt.trim());
  if (empty >= 0 && (opts.only ? scene.blocks[empty].id === opts.only : empty >= (opts.from ?? 0)))
    return toast(`O bloco ${empty + 1} está sem prompt.`, "error");
  if (!state.project.outputDir) {
    actions.tab({ tab: "overview" });
    return toast("Escolha a pasta de saída do projeto antes de gerar.", "error");
  }
  await api("POST", `/api/projects/${state.project.id}/scenes/${scene.id}/generate`, opts);
  toast("Na fila de geração.");
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.dataset.action !== "overlay-close") e.preventDefault();
  try {
    await fn(el.dataset, el, e);
  } catch (err) {
    fail(err);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.modal && !document.querySelector(".overlay.top")) actions["close-modal"]();
});

// ---------- carregamento ----------
async function loadProjects() {
  state.projects = await api("GET", "/api/projects");
  renderSidebar();
}

async function openProject(id, data) {
  if (state.project && saveTimer) await saveNow();
  state.project = data ?? (await api("GET", `/api/projects/${id}`));
  state.sceneId = state.project.scenes[0]?.id ?? null;
  state.modal = null;
  state.previewForm = { sceneId: "", backgroundId: "", strength: 0.6, withCharacters: true, prompt: "" };
  state.llm = { request: "", seconds: "", inline: false, text: "", fileName: "", script: "", result: null, error: null, target: "" };
  if (!["overview", "characters", "backgrounds", "scenes", "previews", "queue"].includes(state.tab)) state.tab = "overview";
  try {
    localStorage.setItem("takes:last", id);
  } catch {
    /* sem armazenamento local */
  }
  render();
}

function connectEvents() {
  const es = new EventSource("/api/events");
  let previous = new Map();
  let structure = "";
  es.addEventListener("jobs", (e) => {
    state.jobs = JSON.parse(e.data);
    const finished = state.jobs.some((j) => previous.get(j.id) && previous.get(j.id) !== j.status && j.status !== "running");
    for (const j of state.jobs) {
      const was = previous.get(j.id);
      if (was && was !== j.status && j.status === "error") toast(`${j.title}: ${j.error}`, "error");
      if (was && was !== j.status && j.status === "complete") toast(`${j.title}: concluída.`);
    }
    previous = new Map(state.jobs.map((j) => [j.id, j.status]));
    renderTopbar();
    if (finished) refreshProject().catch(fail);
    // Refaz a tela só quando muda o estado das tarefas ou o bloco em geração; o progresso
    // em si é atualizado no lugar, para não recarregar os vídeos nem atrapalhar a digitação.
    const next = JSON.stringify(state.jobs.map((j) => [j.id, j.status, j.current?.index]));
    if (next !== structure || state.tab === "queue") {
      structure = next;
      render();
    } else patchProgress();
  });
  es.addEventListener("project", (e) => {
    const { id } = JSON.parse(e.data);
    // Durante um salvamento a resposta do PUT já traz o estado novo.
    if (state.project?.id === id && !saveTimer && !pendingSaves) refreshProject().catch(() => {});
  });
}

function patchProgress() {
  const running = state.jobs.find((j) => j.status === "running");
  if (!running) return;
  document.querySelectorAll(".job-inline").forEach((el) => (el.innerHTML = jobLine(running)));
  if (running.kind === "video" && running.current) {
    document.querySelectorAll(".block .status.running").forEach((el) => (el.textContent = `Gerando ${running.stepProgress ?? 0}%`));
    document.querySelectorAll(".block.st-running .placeholder").forEach((el) => (el.textContent = running.phase || "Gerando…"));
  }
}

async function pollLtx() {
  try {
    state.ltx = await api("GET", "/api/ltx");
  } catch {
    state.ltx = { connected: false, error: "Servidor do Takes indisponível." };
  }
  renderTopbar();
}

(async function boot() {
  await loadProjects();
  let last = null;
  try {
    last = localStorage.getItem("takes:last");
  } catch {
    /* ignora */
  }
  if (last && state.projects.some((p) => p.id === last)) await openProject(last);
  else render();
  connectEvents();
  pollLtx();
  setInterval(pollLtx, 15000);
})();
