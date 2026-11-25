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
const newLlmState = () => ({ fullScript: "", fullSeconds: "", mode: "append", film: false, task: null });
const state = {
  projects: [],
  project: null,
  tab: "overview",
  sceneId: null,
  jobs: [],
  ltx: null,
  modal: null, // { type, ... }
  llm: newLlmState(),
  ai: { settings: null, models: [], errors: [], loading: false },
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
  for (const c of local.characters) if (sChars.has(c.id)) Object.assign(c, { photo: sChars.get(c.id).photo, refs: sChars.get(c.id).refs ?? [] });
  for (const c of server.characters) if (!local.characters.some((x) => x.id === c.id)) local.characters.push(c);
  const sBgs = byId(server.backgrounds);
  local.backgrounds = local.backgrounds.filter((b) => sBgs.has(b.id));
  for (const b of local.backgrounds) b.image = sBgs.get(b.id).image;
  for (const b of server.backgrounds) if (!local.backgrounds.some((x) => x.id === b.id)) local.backgrounds.push(b);
  local.previews = server.previews;
  local.attention = server.attention ?? [];
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
      // A revisão de continuidade com IA pode ter mudado o bloco no servidor.
      if (x.review?.at && x.review.at !== b.review?.at) Object.assign(b, { review: x.review, continuity: x.continuity, start: x.start, prompt: x.prompt, note: x.note, currentState: x.currentState, opening: x.opening });
      // A imagem de abertura gerada é gravada pelo servidor.
      if (x.start?.kind === "keyframe" && b.start?.kind === "keyframe") b.start.id = x.start.id;
    }
  }
  local.updatedAt = server.updatedAt;
  const entry = state.projects.find((p) => p.id === server.id);
  if (entry) Object.assign(entry, { name: local.name, scenes: local.scenes.length });
  if (ownedSignature(local) !== before) render();
}
function ownedSignature(p) {
  return JSON.stringify([
    p.characters.map((c) => [c.id, c.photo, (c.refs ?? []).map((r) => r.file)]),
    (p.attention ?? []).length,
    p.backgrounds.map((b) => [b.id, b.image]),
    p.previews.map((x) => x.id),
    p.scenes.map((s) => [s.id, s.start, s.blocks.map((b) => [b.id, b.selectedTakeId, b.state, b.takes.length, b.review?.at, b.start?.id, b.takes.map((t) => t.judge?.at)])]),
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
  const film = state.jobs.some((j) => j.kind === "film" && j.projectId === p.id && ["queued", "running"].includes(j.status));
  return `<div class="project-head">
      <div class="project-title-row">
        <input class="title-input" data-bind="p.name" value="${esc(p.name)}" aria-label="Nome do projeto">
        <div class="head-actions">
          <button class="btn" data-action="open-llm" title="Cole o roteiro; a IA cria as cenas e os blocos e importa no projeto">✦ Gerar cenas com IA</button>
          <button class="btn primary" data-action="generate-film" ${p.scenes.length && !film ? "" : "disabled"} title="Gera o que falta em todas as cenas, une o filme e escreve o relatório">${film ? "Filme na fila…" : "▶ Gerar filme"}</button>
        </div>
      </div>
      <div class="tabs">${tabs}</div>
    </div>
    <div class="tab-body">${body}</div>`;
}

const option = (value, label, current) => `<option value="${esc(value)}" ${String(value) === String(current) ? "selected" : ""}>${esc(label)}</option>`;

function projectStats(p) {
  const blocks = p.scenes.flatMap((s) => s.blocks);
  const done = blocks.filter((b) => b.state === "ready").length;
  const seconds = p.scenes.reduce((n, s) => n + sceneSeconds(s), 0);
  return { scenes: p.scenes.length, blocks: blocks.length, done, seconds };
}

function filmResult(p) {
  const job = [...state.jobs].reverse().find((j) => j.kind === "film" && j.projectId === p.id);
  if (!job) return "";
  if (["queued", "running"].includes(job.status)) return `<p class="hint">Filme completo na fila: ${esc(job.phase || "")}</p>`;
  if (job.status !== "complete" || !job.result) return job.error ? `<pre class="error">${esc(job.error)}</pre>` : "";
  return `<div class="row film-result">
      <span class="muted small">Último filme: ${job.result.blocks} blocos unidos${job.result.attention ? ` · ${job.result.attention} ponto(s) para revisar` : ""}</span>
      ${job.result.file ? `<button class="btn small" data-action="reveal" data-path="${esc(job.result.file)}">Mostrar o filme</button>` : ""}
      <button class="btn small ghost" data-action="reveal" data-path="${esc(job.result.report)}">Relatório</button>
    </div>`;
}

const ATTENTION_LABEL = { empty: "não gerados", missing: "sem arquivo", stale: "desatualizados", judge: "reprovados pelo juiz" };

// O que precisa de uma pessoa, agrupado por cena: problemas primeiro, blocos não gerados por último.
function attentionPanel(p) {
  const items = p.attention ?? [];
  if (!items.length) return `<p class="hint ok-line">✓ Nada pendente: todos os blocos estão gerados e aprovados.</p>`;
  const counts = Object.entries(ATTENTION_LABEL)
    .map(([kind, label]) => [kind, label, items.filter((i) => i.kind === kind).length])
    .filter(([, , n]) => n);
  const byScene = new Map();
  for (const i of items) {
    if (!byScene.has(i.sceneId)) byScene.set(i.sceneId, { scene: i.scene, title: i.sceneTitle, items: [] });
    byScene.get(i.sceneId).items.push(i);
  }
  const rows = [...byScene.values()]
    .map((g) => {
      const problems = g.items.filter((i) => i.kind !== "empty");
      const empty = g.items.filter((i) => i.kind === "empty");
      const link = (i, text) => `<button class="link" data-action="goto-block" data-scene="${i.sceneId}" data-id="${i.blockId}">${text}</button>`;
      return `<li>
          <div class="att-scene">${link(g.items[0], `Cena ${g.scene}`)} <span class="muted">${esc(g.title)}</span></div>
          <div class="att-items">
            ${problems.map((i) => `<div>${link(i, `Bloco ${i.block}`)} <span class="pill ${i.kind}">${ATTENTION_LABEL[i.kind].replace(/s$/, "").replace("pelo juiz", "")}</span> <small class="muted">${esc(i.kind === "judge" ? i.message : "")}</small></div>`).join("")}
            ${empty.length ? `<div class="muted small">${empty.length === g.items.length && empty.length > 1 ? "Nenhum bloco gerado" : `${empty.length === 1 ? "Bloco" : "Blocos"} ${empty.map((i) => i.block).join(", ")} não ${empty.length === 1 ? "gerado" : "gerados"}`}</div>` : ""}
          </div>
        </li>`;
    })
    .join("");
  return `<div class="att-counts">${counts.map(([kind, label, n]) => `<span class="pill ${kind}">${n} ${label}</span>`).join("")}</div>
    <ul class="attention-list">${rows}</ul>`;
}

function overview() {
  const p = state.project;
  const s = p.settings;
  const st = projectStats(p);
  const model = state.ai.settings?.model;
  const pct = st.blocks ? Math.round((st.done / st.blocks) * 100) : 0;
  return `<div class="overview">
    <section class="card status-card">
      <div class="section-head">
        <div>
          <h3>Andamento</h3>
          <p class="hint">${st.scenes ? `${st.scenes} ${st.scenes === 1 ? "cena" : "cenas"} · ${st.blocks} blocos · ${fmtTime(st.seconds)} de vídeo` : "Nenhuma cena ainda. Use “Gerar cenas com IA” para criar a partir do roteiro, ou crie na aba Cenas."}</p>
        </div>
        <div class="row">
          <button class="btn" data-action="generate-all-missing" ${st.scenes ? "" : "disabled"} title="Em todas as cenas, gera só os blocos que ainda não têm vídeo">Gerar pendentes</button>
          <button class="btn ghost" data-action="generate-all" ${st.scenes ? "" : "disabled"} title="Gera de novo todos os blocos de todas as cenas">Gerar tudo de novo</button>
        </div>
      </div>
      ${st.blocks ? `<div class="meter"><div style="width:${pct}%"></div></div><p class="hint">${st.done} de ${st.blocks} blocos prontos (${pct}%)</p>` : ""}
      ${filmResult(p)}
      ${st.blocks ? `<h4>Precisa de você</h4>${attentionPanel(p)}` : ""}
    </section>

    <div class="grid-2">
      <section class="card">
        <h3>Estilo</h3>
        <label><span>Pré-prompt <span class="muted small">entra antes de todo prompt de vídeo e imagem; em inglês</span></span>
          <textarea data-bind="p.prePrompt" rows="7" placeholder="Ex.: Cinematic 35mm film look, warm golden-hour light, shallow depth of field, handheld camera, realistic textures…">${esc(p.prePrompt)}</textarea>
        </label>
        <label>Prompt negativo
          <textarea data-bind="p.negativePrompt" rows="2" placeholder="Ex.: blurry, distorted faces, text, watermark">${esc(p.negativePrompt)}</textarea>
        </label>
      </section>

      <section class="card">
        <h3>Saída e vídeo</h3>
        <label><span>Pasta de saída <span class="muted small">uma subpasta por cena, um MP4 por bloco</span></span>
          <div class="path-row">
            <input data-bind="p.outputDir" value="${esc(p.outputDir)}" placeholder="/Users/você/Movies/meu-projeto" class="mono">
            <button class="btn" data-action="pick-output">Escolher…</button>
            ${p.outputDir ? `<button class="btn ghost" data-action="reveal" data-path="${esc(p.outputDir)}">Abrir</button>` : ""}
          </div>
        </label>
        <div class="form-grid">
          <label>Resolução<select data-bind="p.settings.resolution">${["360p", "540p", "720p", "1080p"].map((r) => option(r, r, s.resolution)).join("")}</select></label>
          <label>Proporção<select data-bind="p.settings.aspectRatio">${["16:9", "9:16", "1:1", "4:3", "3:2", "4:5", "21:9"].map((r) => option(r, r, s.aspectRatio)).join("")}</select></label>
          <label>FPS<select data-bind="p.settings.fps" data-type="number">${[24, 25, 48, 50].map((r) => option(r, r, s.fps)).join("")}</select></label>
          <label>Seed<input data-bind="p.settings.seed" data-type="number" type="number" min="0" value="${s.seed ?? ""}" placeholder="aleatória"></label>
          <label title="Quantos segundos do fim do bloco anterior o LTX recebe para continuar o movimento">Contexto da continuação<select data-bind="p.settings.contextSeconds" data-type="number">${[1, 2, 3, 4, 5].map((r) => option(r, `${r} s`, s.contextSeconds)).join("")}</select></label>
          <label class="check"><input type="checkbox" data-bind="p.settings.audio" ${s.audio ? "checked" : ""}> Gerar áudio</label>
        </div>
        <p class="hint">Mude antes de gerar: os blocos de continuação herdam a resolução do bloco anterior.</p>
      </section>

      <section class="card">
        <h3>IA durante a geração</h3>
        <p class="hint">${model ? `Usa ${esc(modelName(state.ai.settings?.reviewModel ?? model))}, definido em <a href="#" data-action="open-settings">Configurações</a>.` : `Escolha um modelo em <a href="#" data-action="open-settings">Configurações</a>; sem modelo, os blocos seguem o plano sem conferência.`} Cada bloco conferido é uma chamada de API com imagens.</p>
        <label class="check" title="Antes de cada bloco, a LLM vê o último quadro real dos blocos anteriores e pode ajustar a continuidade, a imagem inicial e o prompt."><input type="checkbox" data-bind="p.settings.review" ${s.review ? "checked" : ""}> Revisar a continuidade antes de cada bloco</label>
        <label class="check" title="Depois de cada bloco, a LLM confere o take; se reprovar, o Takes gera outro e fica com o melhor."><input type="checkbox" data-bind="p.settings.judge" data-rerender="1" ${s.judge ? "checked" : ""}> Juiz depois de cada bloco</label>
        ${s.judge ? `<label class="inline indent">Retakes se reprovar <select data-bind="p.settings.retakes" data-type="number">${[0, 1, 2, 3].map((r) => option(r, r === 0 ? "nenhum" : `até ${r}`, s.retakes)).join("")}</select></label>` : ""}
      </section>

      <section class="card">
        <h3>Projeto</h3>
        <p class="hint">Clonar copia pré-prompt, configurações, personagens, fundos e cenas, sem os vídeos. Limpar e excluir não apagam os vídeos da pasta de saída.</p>
        <div class="row">
          <button class="btn" data-action="clone-project">Clonar projeto…</button>
          <span class="grow"></span>
          <button class="btn ghost danger" data-action="clear-scenes" ${p.scenes.length ? "" : "disabled"}>Limpar cenas</button>
          <button class="btn ghost danger" data-action="delete-project">Excluir projeto</button>
        </div>
      </section>
    </div>
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
      <div class="scene-list-actions">
        <button class="btn grow" data-action="new-scene">＋ Nova cena</button>
        <button class="btn grow" data-action="open-llm" title="Cole o roteiro; a IA cria as cenas">✦ Com IA</button>
      </div>
      ${list || `<p class="muted pad">Nenhuma cena.</p>`}
    </div>
    <div class="scene-editor">${scene ? sceneEditor(scene) : `<p class="muted">Crie uma cena para começar.</p>`}</div>
  </div>`;
}

function startOptions(scene) {
  const p = state.project;
  const current = `${scene.start.kind}:${scene.start.id ?? ""}`;
  const first = p.scenes[0]?.id === scene.id;
  const sel = ["previous", "keyframe"].includes(scene.start.kind) ? `${scene.start.kind}:` : current;
  return [
    option("none:", "Nenhuma — o 1º bloco nasce só do texto", sel),
    ...(first ? [] : [option("previous:", "Último quadro da cena anterior", sel)]),
    option("keyframe:", "Gerar imagem de abertura (Z-Image)", sel),
    ...p.backgrounds.map((b) => option(`background:${b.id}`, `Fundo: ${b.name}`, sel)),
    ...p.previews.map((x) => option(`preview:${x.id}`, previewLabel(x, scene), sel)),
  ].join("");
}

function startImageFile(scene) {
  const p = state.project;
  if (scene.start.kind === "keyframe") return p.previews.find((x) => x.id === scene.start.id)?.file;
  if (scene.start.kind === "background") return p.backgrounds.find((b) => b.id === scene.start.id)?.image;
  if (scene.start.kind === "preview") return p.previews.find((x) => x.id === scene.start.id)?.file;
  return null;
}

// Imagem inicial de um bloco de corte: imagem da cena, só o texto, último quadro de um bloco
// anterior, um fundo ou uma prévia (inclusive quadros salvos de um take).
function previewLabel(x, scene) {
  const p = state.project;
  if (x.kind === "keyframe") {
    const owner = p.scenes.find((s) => s.blocks.some((b) => b.id === x.blockId));
    const n = owner ? owner.blocks.findIndex((b) => b.id === x.blockId) + 1 : "?";
    return `Abertura gerada: bloco ${n}${owner && owner.id !== scene.id ? ` (${owner.title})` : ""} · ${new Date(x.createdAt).toLocaleString("pt-BR")}`;
  }
  if (x.fromBlock) {
    const owner = p.scenes.find((s) => s.blocks.some((b) => b.id === x.fromBlock.blockId));
    const n = owner ? owner.blocks.findIndex((b) => b.id === x.fromBlock.blockId) + 1 : "?";
    return `Quadro salvo: bloco ${n} em ${Number(x.fromBlock.time).toFixed(1)} s${owner && owner.id !== scene.id ? ` (${owner.title})` : ""}`;
  }
  return `Prévia · ${new Date(x.createdAt).toLocaleString("pt-BR")}${x.sceneId === scene.id ? " (desta cena)" : ""}`;
}

// Resumo da continuidade de um bloco do roteiro antes de importar.
function scriptContinuity(scene, b, i) {
  if (i === 0) return "abre a cena";
  if (b.continuity !== "cut") return b.continuity === "frame" ? "último quadro" : "continua";
  const st = b.start ?? { kind: "scene" };
  if (st.kind === "block") return `corte · do fim do bloco ${scene.blocks.findIndex((x) => x.id === st.id) + 1}`;
  if (st.kind === "background") return `corte · fundo ${state.project.backgrounds.find((x) => x.id === st.id)?.name ?? "?"}`;
  if (st.kind === "keyframe") return "corte · abertura gerada";
  return st.kind === "none" ? "corte · só texto" : "corte · imagem da cena";
}

function judgeLine(take) {
  const j = take?.judge;
  if (!j) return "";
  const problems = (j.problems ?? []).filter(Boolean);
  return `<div class="judge ${j.pass ? "pass" : "fail"}" title="${esc(j.model || "")}">
      <strong>${j.pass ? "Aprovado" : "Reprovado"} pelo juiz · ${j.score}/10</strong>${j.reason ? ` <span>${esc(j.reason)}</span>` : ""}
      ${problems.length ? `<ul>${problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </div>`;
}

function reviewBox(scene, b) {
  const r = b.review;
  const when = new Date(r.at).toLocaleString("pt-BR");
  const status = r.undone ? "Revisão desfeita" : r.changed ? "A IA ajustou este bloco" : "A IA conferiu e manteve o plano";
  return `<div class="review ${r.changed && !r.undone ? "changed" : ""}">
      <strong>${status}</strong> <small class="muted">${esc(r.model || "")} · ${when}</small>
      ${r.reason ? `<div>${esc(r.reason)}</div>` : ""}
      ${r.changed && !r.undone ? `<button class="btn small ghost" data-action="undo-review" data-scene="${scene.id}" data-id="${b.id}" title="Volta a continuidade, a imagem inicial, o prompt e a nota ao que eram antes da revisão">Desfazer</button>` : ""}
    </div>`;
}

function cutStartOptions(scene, b, i) {
  const p = state.project;
  const start = b.start ?? { kind: "scene", id: null };
  const current = start.kind === "keyframe" ? "keyframe:" : `${start.kind}:${start.id ?? ""}`;
  return [
    option("scene:", `Imagem inicial da cena${startImageFile(scene) ? "" : " (nenhuma: só o texto)"}`, current),
    option("keyframe:", "Gerar imagem de abertura (Z-Image)", current),
    option("none:", "Só o texto, sem imagem", current),
    ...scene.blocks.slice(0, i).map((x, j) => option(`block:${x.id}`, `Último quadro do bloco ${j + 1}`, current)),
    ...p.backgrounds.map((x) => option(`background:${x.id}`, `Fundo: ${x.name}`, current)),
    ...p.previews.map((x) => option(`preview:${x.id}`, previewLabel(x, scene), current)),
  ].join("");
}

// Referência de uma abertura gerada: de qual imagem o Z-Image parte.
function refOptions(scene, ref, i, { sceneLevel = false } = {}) {
  const p = state.project;
  const current = `${ref?.kind ?? "scene"}:${ref?.id ?? ""}`;
  const first = p.scenes[0]?.id === scene.id;
  return [
    ...(sceneLevel ? [] : [option("scene:", "Imagem inicial da cena", current)]),
    option("none:", "Nenhuma (só o texto)", current),
    ...(sceneLevel && !first ? [option("previous:", "Último quadro da cena anterior", current)] : []),
    ...scene.blocks.slice(0, i).map((x, j) => option(`block:${x.id}`, `Último quadro do bloco ${j + 1}`, current)),
    ...p.backgrounds.map((x) => option(`background:${x.id}`, `Fundo: ${x.name}`, current)),
    ...p.previews.map((x) => option(`preview:${x.id}`, previewLabel(x, scene), current)),
  ].join("");
}

function keyframeEditor(scene, b, i, start, { sceneLevel = false } = {}) {
  const file = state.project.previews.find((x) => x.id === start.id)?.file;
  return `<div class="keyframe">
      <label class="inline">Partindo de
        <select data-change="keyframe-ref" data-scene="${scene.id}" data-id="${b.id}" data-level="${sceneLevel ? "scene" : "block"}">${refOptions(scene, start.ref, i, { sceneLevel })}</select>
      </label>
      <textarea data-bind="k.${scene.id}.${b.id}.opening" rows="2" placeholder="Quadro de abertura (em inglês): enquadramento, quem está onde, o estado visível. Em branco usa o prompt.">${esc(b.opening || "")}</textarea>
      <div class="row">
        ${file ? `<img class="cut-thumb" src="${mediaUrl(file, file)}" alt="Abertura gerada"><button class="btn small ghost" data-action="reset-keyframe" data-scene="${scene.id}" data-id="${b.id}" title="Descarta esta imagem; a próxima geração do bloco cria outra">Gerar outra</button>` : `<span class="muted small">Gerada com o Z-Image antes do vídeo e salva nas prévias.</span>`}
      </div>
    </div>`;
}

function cutStartFile(scene, b) {
  const p = state.project;
  const start = b.start ?? { kind: "scene" };
  if (start.kind === "keyframe") return null;
  if (start.kind === "scene") return startImageFile(scene);
  if (start.kind === "background") return p.backgrounds.find((x) => x.id === start.id)?.image;
  if (start.kind === "preview") return p.previews.find((x) => x.id === start.id)?.file;
  if (start.kind === "block") {
    const src = scene.blocks.find((x) => x.id === start.id);
    return src ? { block: scene.blocks.indexOf(src) + 1, ready: Boolean(src.selectedTakeId) } : null;
  }
  return null;
}

function cutStartPicker(scene, b, i) {
  const file = cutStartFile(scene, b);
  const thumb =
    typeof file === "string"
      ? `<img class="cut-thumb" src="${mediaUrl(file, file)}" alt="Imagem inicial do corte">`
      : file?.block
        ? `<span class="muted small">${file.ready ? "O quadro é extraído na hora de gerar." : `O bloco ${file.block} ainda não foi gerado.`}</span>`
        : "";
  const start = b.start ?? { kind: "scene" };
  return `<div class="cut-start">
      <label class="inline">Imagem inicial do corte
        <select data-change="block-start" data-scene="${scene.id}" data-id="${b.id}">${cutStartOptions(scene, b, i)}</select>
      </label>
      ${thumb}
    </div>
    ${start.kind === "keyframe" ? keyframeEditor(scene, b, i, start) : ""}`;
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
  const ready = scene.blocks.filter((b) => b.state === "ready").length;
  const index = p.scenes.findIndex((s) => s.id === scene.id);
  let t = 0;
  const blocks = scene.blocks
    .map((b, i) => {
      const html = blockCard(scene, b, i, t, running);
      t += Number(b.duration || 0);
      return html;
    })
    .join("");
  return `<div class="card scene-card">
      <div class="scene-head">
        <span class="scene-num">Cena ${index + 1}</span>
        <input class="scene-title" data-bind="s.${scene.id}.title" value="${esc(scene.title)}" aria-label="Título da cena">
        <div class="icon-group">
          <button class="btn icon" data-action="move-scene" data-dir="-1" title="Mover a cena para cima">↑</button>
          <button class="btn icon" data-action="move-scene" data-dir="1" title="Mover a cena para baixo">↓</button>
          <button class="btn icon danger" data-action="delete-scene" title="Excluir a cena">✕</button>
        </div>
      </div>
      <div class="scene-actions">
        <button class="btn primary" data-action="generate-missing" ${job ? "disabled" : ""} title="Gera os blocos desta cena que ainda não têm vídeo">${job ? "Na fila…" : "Gerar pendentes"}</button>
        <button class="btn" data-action="generate-scene" ${job ? "disabled" : ""} title="Gera de novo todos os blocos desta cena">Gerar a cena toda</button>
        ${job ? `<button class="btn danger" data-action="cancel-job" data-id="${job.id}">Cancelar</button>` : ""}
        <span class="divider"></span>
        <button class="btn" data-action="play-scene">▶ Assistir</button>
        <button class="btn ghost" data-action="export-scene" ${allReady ? "" : "disabled"} title="Une todos os blocos em um MP4 para conferência">Exportar unida</button>
        <span class="grow"></span>
        <span class="total">${ready}/${scene.blocks.length} prontos · <strong data-total>${fmtTime(t)}</strong></span>
      </div>
      ${running ? `<div class="job-inline">${jobLine(running)}</div>` : ""}
      <details class="scene-setup-wrap" ${state.sceneSetupOpen ? "open" : ""} data-toggle="scene-setup">
        <summary>Ambiente, abertura e elenco <span class="muted small">${esc(p.backgrounds.find((b) => b.id === scene.backgroundId)?.name ?? "sem fundo")} · ${scene.characterIds.length} no elenco</span></summary>
        <div class="scene-setup">
          <div>
            <label><span>Sinopse <span class="muted small">referência sua e da IA; não entra no prompt</span></span>
              <textarea data-bind="s.${scene.id}.synopsis" rows="2">${esc(scene.synopsis)}</textarea>
            </label>
            <div class="form-grid two">
              <label><span>Fundo <span class="muted small">a descrição entra no prompt</span></span>
                <select data-change="scene-background">${option("", "Nenhum", scene.backgroundId ?? "")}${p.backgrounds.map((b) => option(b.id, b.name, scene.backgroundId ?? "")).join("")}</select>
              </label>
              <label><span>Abertura da cena <span class="muted small">imagem inicial do 1º bloco</span></span>
                <select data-change="scene-start">${startOptions(scene)}</select>
              </label>
            </div>
            ${scene.start.kind === "keyframe" && scene.blocks[0] ? keyframeEditor(scene, scene.blocks[0], 0, scene.start, { sceneLevel: true }) : ""}
            <div class="label">Elenco da cena</div>
            <div class="chips">${castChips(scene.characterIds, "toggle-scene-cast")}</div>
          </div>
          <div class="start-thumb">${start ? `<img src="${mediaUrl(start, start)}" alt="Imagem inicial">` : `<div class="placeholder">${scene.start.kind === "previous" ? "Último quadro da cena anterior" : scene.start.kind === "keyframe" ? "Gerada antes do 1º bloco" : "Sem imagem inicial"}</div>`}
            <button class="btn small" data-action="preview-for-scene">Gerar prévia do ambiente</button></div>
        </div>
      </details>
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
  const field = (title, hint, html) => `<div class="field"><div class="field-label">${title}${hint ? ` <span class="muted">${hint}</span>` : ""}</div>${html}</div>`;
  return `<article class="block card st-${st}">
    <div class="block-head">
      <span class="block-num">${i + 1}</span>
      <span class="range" data-range="${b.id}">${fmtTime(t)}–${fmtTime(t + Number(b.duration || 0))}</span>
      <span class="status ${st}">${label}</span>
      ${st === "stale" ? `<span class="hint">O bloco de origem mudou depois desta geração. Gere de novo para manter a continuidade.</span>` : ""}
      <span class="grow"></span>
      <div class="icon-group">
        <button class="btn icon" data-action="move-block" data-id="${b.id}" data-dir="-1" title="Subir">↑</button>
        <button class="btn icon" data-action="move-block" data-id="${b.id}" data-dir="1" title="Descer">↓</button>
        <button class="btn icon" data-action="duplicate-block" data-id="${b.id}" title="Duplicar">⧉</button>
        <button class="btn icon danger" data-action="delete-block" data-id="${b.id}" title="Excluir">✕</button>
      </div>
    </div>
    <div class="block-body">
      <div class="block-fields">
        ${b.review ? reviewBox(scene, b) : ""}
        <div class="form-row">
          ${
            i === 0
              ? `<span class="pill">Abre a cena · ${scene.start.kind === "previous" ? "do fim da cena anterior" : scene.start.kind === "keyframe" ? "imagem gerada" : startImageFile(scene) ? "imagem inicial" : "só pelo texto"}</span>`
              : `<label class="inline">Ligação <select data-bind="k.${scene.id}.${b.id}.continuity" data-rerender="1">${Object.entries(CONTINUITY_LABEL).map(([v, l]) => option(v, l, b.continuity)).join("")}</select></label>`
          }
          <label class="inline">Duração <input type="number" min="2" max="20" step="1" data-type="number" data-live="1" data-change="clamp-duration" data-bind="k.${scene.id}.${b.id}.duration" value="${b.duration}"> s</label>
        </div>
        ${i > 0 && b.continuity === "cut" ? cutStartPicker(scene, b, i) : ""}
        ${field("Prompt", "em inglês: ação, movimento, câmera, luz", `<textarea data-bind="k.${scene.id}.${b.id}.prompt" rows="4">${esc(b.prompt)}</textarea>`)}
        ${field("Estado atual", "em inglês; entra no prompt", `<textarea class="state" data-bind="k.${scene.id}.${b.id}.currentState" rows="1" placeholder="O que mudou no lugar e nos objetos. Ex.: The gate stands wide open.">${esc(b.currentState || "")}</textarea>`)}
        ${field("Nota de continuidade", "não entra no prompt", `<textarea class="note" data-bind="k.${scene.id}.${b.id}.note" rows="${b.note ? 2 : 1}" placeholder="O que conferir neste bloco.">${esc(b.note || "")}</textarea>`)}
        <div class="cast-row">
          <label class="check"><input type="checkbox" data-change="block-cast-custom" data-scene="${scene.id}" data-id="${b.id}" ${custom ? "checked" : ""}> Elenco próprio neste bloco</label>
          ${custom ? `<div class="chips">${castChips(b.characterIds, "toggle-block-cast", `data-block="${b.id}"`)}</div>` : `<span class="muted small">usa o elenco da cena</span>`}
        </div>
      </div>
      <div class="block-media">
        ${take ? `<video src="${mediaUrl(take.file, take.id)}" preload="metadata" muted controls></video>` : `<div class="placeholder">${isRunning ? (running.phase ? esc(running.phase) : "Gerando…") : "Sem vídeo"}</div>`}
        ${judgeLine(take)}
        <div class="take-actions">
          ${
            b.takes.length > 1
              ? `<select data-change="select-take" data-scene="${scene.id}" data-id="${b.id}" title="Take usado na cena">${b.takes.map((x, n) => option(x.id, `Take ${n + 1}${x.judge ? ` · ${x.judge.score}/10${x.judge.pass ? "" : " ✗"}` : ""}`, b.selectedTakeId)).join("")}</select>`
              : ""
          }
          <button class="btn small ${take ? "" : "primary"}" data-action="generate-block" data-id="${b.id}" ${running ? "disabled" : ""}>${take ? "Gerar outro take" : "Gerar"}</button>
          ${i < scene.blocks.length - 1 ? `<button class="btn small ghost" data-action="generate-from" data-index="${i}" ${running ? "disabled" : ""} title="Gera este bloco e todos os seguintes">Daqui em diante</button>` : ""}
        </div>
        ${take ? `<div class="take-tools"><button class="btn small ghost" data-action="save-frame" data-scene="${scene.id}" data-id="${b.id}" title="Salva o quadro em que o vídeo está parado como imagem, para abrir um corte, a cena ou virar fundo">📷 Salvar quadro</button><button class="btn small ghost" data-action="reveal" data-path="${esc(take.file)}">Mostrar no Finder</button></div>` : ""}
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
        <div class="row preview-meta">
          <small class="muted grow">${esc(previewLabel(x, p.scenes.find((s) => s.id === x.sceneId) ?? { id: null }))}</small>
          <button class="btn icon" data-action="reveal" data-path="${esc(x.file)}" title="Mostrar no Finder">⌕</button>
          <button class="btn icon danger" data-action="delete-preview" data-id="${x.id}" title="Remover da lista (o arquivo continua na pasta)">✕</button>
        </div>
        <details><summary>Prompt</summary><pre>${esc(x.prompt)}</pre></details>
        <div class="row">
          <select data-change="preview-to-scene" data-id="${x.id}"><option value="">Usar como abertura de…</option>${p.scenes.map((s) => option(s.id, s.title, "")).join("")}</select>
          <button class="btn small" data-action="preview-to-background" data-id="${x.id}">Salvar como fundo</button>
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

const JOB_STATUS = { queued: "Na fila", running: "Gerando", complete: "Concluída", error: "Erro", cancelled: "Cancelada", interrupted: "Interrompida" };
const RESUMABLE = ["interrupted", "error", "cancelled"];

function jobCard(j, { position = null } = {}) {
  const name = state.projects.find((p) => p.id === j.projectId)?.name ?? "";
  return `<div class="card job ${j.status}">
      <div class="row">
        ${position ? `<span class="job-pos">${position}</span>` : ""}
        <strong class="grow">${esc(j.title || j.kind)}</strong>
        <span class="muted small">${esc(name)}</span>
        <span class="status ${j.status}">${JOB_STATUS[j.status]}</span>
        ${["queued", "running"].includes(j.status) ? `<button class="btn small ghost danger" data-action="cancel-job" data-id="${j.id}">Cancelar</button>` : `<button class="btn small ghost" data-action="remove-job" data-id="${j.id}" title="Tira da lista; os arquivos continuam">Remover</button>`}
      </div>
      ${j.status === "running" ? jobLine(j) : ""}
      ${j.error ? `<pre class="error">${esc(j.error)}</pre>` : ""}
      ${j.reviews?.length ? `<small class="muted">Revisão de continuidade: ${j.reviews.filter((r) => r.changed).length} de ${j.reviews.length} bloco(s) ajustado(s).</small>` : ""}
      ${j.judged?.length ? `<small class="muted">Juiz: ${j.judged.filter((x) => x.pass).length} de ${j.judged.length} take(s) aprovado(s).</small>` : ""}
      ${(j.warnings ?? []).map((w) => `<small class="warn">${esc(w)}</small>`).join("")}
      ${j.kind === "film" && j.status === "complete" && j.result ? `<div class="row">${j.result.file ? `<button class="btn small" data-action="reveal" data-path="${esc(j.result.file)}">Mostrar o filme</button>` : ""}<button class="btn small ghost" data-action="reveal" data-path="${esc(j.result.report)}">Relatório</button><small class="muted">${esc(j.phase || "")}</small></div>` : ""}
      ${j.kind === "avatar" && j.result?.draft ? `<small>Foto pronta — abra o personagem para usar.</small>` : ""}
      ${(RESUMABLE.includes(j.status) && j.kind === "video") || j.steps?.length ? `<div class="row">
        ${RESUMABLE.includes(j.status) && j.kind === "video" ? `<button class="btn small primary" data-action="resume-job" data-id="${j.id}" title="Gera os blocos que faltaram">Retomar</button>` : ""}
        ${j.steps?.length ? `<small class="muted">${j.steps.length} bloco(s) salvo(s)</small>` : ""}
      </div>` : ""}
    </div>`;
}

// Fila em três partes: o que está gerando, o que vem depois (na ordem em que vai rodar) e o histórico.
function queue() {
  const running = state.jobs.filter((j) => j.status === "running");
  const queued = state.jobs.filter((j) => j.status === "queued"); // a fila roda na ordem em que as tarefas entraram
  const finished = state.jobs.filter((j) => !["running", "queued"].includes(j.status)).reverse();
  const section = (title, hint, body, extra = "") => `<section class="queue-section">
      <div class="section-head"><h3>${title}</h3>${extra}</div>
      ${hint ? `<p class="hint">${hint}</p>` : ""}
      ${body}
    </section>`;
  return `${section("Gerando agora", "", running.length ? running.map((j) => jobCard(j)).join("") : `<p class="muted empty-line">Nada gerando. Deixe o LTX Desktop aberto; o LTX gera uma coisa por vez.</p>`)}
    ${section(`Na fila${queued.length ? ` (${queued.length})` : ""}`, queued.length ? "Na ordem em que vão rodar, de cima para baixo." : "", queued.length ? queued.map((j, i) => jobCard(j, { position: i + 1 })).join("") : `<p class="muted empty-line">Fila vazia.</p>`)}
    ${section(`Concluídas${finished.length ? ` (${finished.length})` : ""}`, "", finished.length ? finished.map((j) => jobCard(j)).join("") : `<p class="muted empty-line">Nenhuma tarefa concluída.</p>`, finished.length ? `<button class="btn small ghost" data-action="clear-jobs">Limpar concluídas</button>` : "")}`;
}

// ---------- modais ----------
function renderModal() {
  const root = $("#modal-root");
  const m = state.modal;
  if (!m) {
    root.innerHTML = "";
    return;
  }
  const content = m.type === "character" ? characterModal(m) : m.type === "llm" ? scriptModal() : m.type === "settings" ? settingsModal(m) : "";
  root.innerHTML = `<div class="overlay" data-action="overlay-close">${content}</div>`;
}

function characterModal(m) {
  const c = state.project.characters.find((x) => x.id === m.id);
  if (!c) return "";
  const job = [...state.jobs].reverse().find((j) => j.kind === "avatar" && j.characterId === c.id);
  const active = job && ["queued", "running"].includes(job.status);
  const draft = job?.status === "complete" && job.result?.draft && !m.dismissed?.includes(job.id) ? job : null;
  const field = (key, label, rows, hint = "") =>
    `<label><span>${label}${hint ? ` <span class="muted small">${hint}</span></span>` : ""}<textarea data-bind="c.${c.id}.${key}" rows="${rows}">${esc(c[key])}</textarea></label>`;
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
          <h4>Fichas de referência</h4>
          <p class="hint">Frente, perfil e corpo inteiro, a partir da foto. O juiz usa para conferir se o personagem saiu parecido.</p>
          ${(c.refs ?? []).length ? `<div class="refs">${c.refs.map((r) => `<img src="${mediaUrl(r.file, r.file)}" alt="${esc(r.view)}" title="${esc(r.view)}">`).join("")}</div>` : ""}
          ${(() => {
            const rj = [...state.jobs].reverse().find((j) => j.kind === "charsheet" && j.characterId === c.id);
            const busy = rj && ["queued", "running"].includes(rj.status);
            return `<button class="btn small" data-action="char-references" data-id="${c.id}" ${busy ? "disabled" : ""}>${busy ? "Gerando…" : (c.refs ?? []).length ? "Gerar de novo" : "Gerar fichas"}</button>
              ${busy && rj.status === "running" ? `<div class="job-inline">${jobLine(rj)}</div>` : ""}
              ${rj?.status === "error" ? `<small class="error">${esc(rj.error)}</small>` : ""}`;
          })()}
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

const PHASE_SECONDS = (t) => Math.round((Date.now() - t.startedAt) / 1000);

const EFFORT_LABEL = { low: "Baixo", medium: "Médio", high: "Alto", xhigh: "Muito alto", max: "Máximo" };

// Lista de modelos dos provedores com chave. `value` no formato "provedor:id".
function modelOptions(current, { inherit = null } = {}) {
  const a = state.ai;
  const configured = (a.settings?.providers ?? []).filter((p) => p.configured);
  const groups = configured
    .map((p) => {
      const list = a.models.filter((m) => m.provider === p.id);
      return list.length ? `<optgroup label="${esc(p.name)}">${list.map((m) => option(`${m.provider}:${m.id}`, m.name, current)).join("")}</optgroup>` : "";
    })
    .join("");
  return `${option("", inherit ?? "Escolha o modelo…", current)}${groups}`;
}

const modelKey = (m) => (m ? `${m.provider}:${m.id}` : "");
const modelName = (m) => (m ? state.ai.models.find((x) => x.provider === m.provider && x.id === m.id)?.name ?? m.id : "");

// Assistente de roteiro: gera as cenas com o modelo das Configurações e importa sozinho.
function scriptModal() {
  const l = state.llm;
  const a = state.ai;
  const t = l.task;
  const running = t?.status === "running";
  const model = a.settings?.model;
  const p = state.project;
  const imported = t?.status === "complete" && t.imported;
  return `<div class="modal wide" role="dialog" aria-label="Gerar cenas com IA">
    <div class="modal-head"><h2>Gerar cenas com IA</h2><button class="icon-btn" data-action="close-modal" title="Fechar">✕</button></div>
    <div class="steps">
      <section>
        <div class="model-line">
          ${model ? `<span>Modelo: <strong>${esc(modelName(model))}</strong> · esforço ${esc((EFFORT_LABEL[a.settings.effort] ?? a.settings.effort).toLowerCase())}</span>` : `<span class="warn">Nenhum modelo escolhido.</span>`}
          <button class="btn small ghost" data-action="open-settings">${model ? "Alterar…" : "Configurar…"}</button>
        </div>
        <p class="hint">Cole o roteiro completo (cenas, ações e falas). A IA divide em cenas e blocos de até 20 s usando os personagens e fundos do projeto, confere o resultado e importa as cenas direto no projeto. A geração continua se você fechar esta janela.</p>
        <textarea data-focus="llm-full" data-llm="fullScript" rows="12" placeholder="Cole aqui o roteiro completo." ${running ? "disabled" : ""}>${esc(l.fullScript)}</textarea>
        <div class="script-options">
          <label class="inline">Duração total <input class="wide-num" type="number" min="2" data-focus="llm-full-seconds" data-llm="fullSeconds" value="${esc(l.fullSeconds)}" placeholder="opcional" ${running ? "disabled" : ""}> s</label>
          <label class="inline">Cenas geradas
            <select data-change="llm-mode" ${running ? "disabled" : ""}>${option("append", p.scenes.length ? `Adicionar depois ${p.scenes.length === 1 ? "da cena atual" : `das ${p.scenes.length} cenas atuais`}` : "Adicionar ao projeto", l.mode)}${p.scenes.length ? option("replace", p.scenes.length === 1 ? "Substituir a cena atual" : `Substituir as ${p.scenes.length} cenas atuais`, l.mode) : ""}</select>
          </label>
          <label class="check"><input type="checkbox" data-change="llm-film" ${l.film ? "checked" : ""} ${running ? "disabled" : ""}> Depois de importar, gerar o filme</label>
        </div>
      </section>
      <div class="action-bar">
        ${running ? `<div class="hint ai-running grow"><span class="spinner" aria-hidden="true"></span><p class="ai-progress">${aiProgress(t)}</p></div>` : `<span class="grow"></span>`}
        ${running ? `<button class="btn danger" data-action="ai-cancel">Cancelar</button>` : `<button class="btn primary" data-action="ai-generate" ${model ? "" : "disabled"}>Gerar e importar cenas</button>`}
      </div>
      ${t?.status === "error" ? `<section><pre class="error">${esc(t.error)}</pre>${t.text ? `<details><summary class="muted small">Ver a resposta da IA</summary><pre class="mono raw">${esc(t.text.slice(0, 20000))}</pre></details>` : ""}</section>` : ""}
      ${imported ? importedSummary(t) : ""}
    </div>
  </div>`;
}

function importedSummary(t) {
  const r = t.imported;
  const p = state.project;
  const scenes = r.sceneIds.map((id) => p.scenes.find((x) => x.id === id)).filter(Boolean);
  return `<section class="imported">
      <div class="section-head">
        <h3>✓ ${r.scenes} ${r.scenes === 1 ? "cena importada" : "cenas importadas"} · ${r.blocks} blocos</h3>
        <button class="btn primary small" data-action="goto-imported">Ver as cenas</button>
      </div>
      ${r.film?.error ? `<p class="error small">O filme não entrou na fila: ${esc(r.film.error)}</p>` : r.film ? `<p class="hint">O filme está na fila (${r.film.scenes} cena(s)). Acompanhe na aba Fila.</p>` : ""}
      ${r.warnings?.length ? `<ul class="warn small">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <ol class="script-preview">${scenes.map((s) => `<li><strong>${esc(s.title)}</strong> <span class="muted small">${s.blocks.length} blocos · ${fmtTime(sceneSeconds(s))}</span></li>`).join("")}</ol>
    </section>`;
}

// Configurações gerais: chaves de API, modelos de IA e padrões de projeto novo. Valem para todos os projetos.
function settingsModal(m) {
  const a = state.ai;
  const providers = a.settings?.providers ?? [];
  const d = m.defaults;
  const effortSelect = (field, value) => `<select data-settings="${field}">${Object.entries(EFFORT_LABEL).map(([v, l]) => option(v, l, value)).join("")}</select>`;
  return `<div class="modal wide" role="dialog" aria-label="Configurações">
    <div class="modal-head"><h2>Configurações</h2><button class="icon-btn" data-action="close-settings" title="Fechar">✕</button></div>
    <div class="steps settings">
      <section>
        <h3>Chaves de API</h3>
        <p class="hint">Ficam só neste Mac, na biblioteca do Takes, e valem para todos os projetos. Cada uso é cobrado na sua conta do provedor.</p>
        ${providers
          .map(
            (p) => `<div class="key-row">
              <span class="key-name">${esc(p.name)}</span>
              <input type="password" autocomplete="off" spellcheck="false" class="mono grow" data-focus="ai-key-${p.id}" data-ai-key="${p.id}" value="${esc(m.keys[p.id] ?? "")}" placeholder="${p.configured ? `Salva (${esc(p.hint)}). Cole outra para trocar.` : "Cole a chave aqui"}">
              ${p.configured ? `<button class="btn ghost danger small" data-action="remove-ai-key" data-id="${p.id}">Remover</button>` : `<a class="btn ghost small" href="${esc(p.keyUrl)}" target="_blank" rel="noopener">Criar chave</a>`}
            </div>`,
          )
          .join("")}
        ${a.errors.map((e) => `<p class="error small">${esc(e.error)}</p>`).join("")}
      </section>
      <section>
        <div class="section-head"><h3>Modelos de IA</h3><button class="btn ghost small" data-action="refresh-ai-models" title="Atualizar a lista de modelos">↻ Atualizar lista</button></div>
        ${
          a.models.length
            ? `<div class="settings-grid">
                <label><span>Roteiro <span class="muted small">divide o roteiro em cenas e blocos</span></span><select data-settings="model">${modelOptions(m.model)}</select></label>
                <label>Esforço do roteiro${effortSelect("effort", m.effort)}</label>
                <label><span>Revisão e juiz <span class="muted small">confere continuidade e takes, com imagens</span></span><select data-settings="reviewModel">${modelOptions(m.reviewModel, { inherit: "Igual ao do roteiro" })}</select></label>
                <label>Esforço da revisão e do juiz${effortSelect("reviewEffort", m.reviewEffort)}</label>
              </div>
              <p class="hint">Mais esforço pensa mais antes de responder: melhor resultado, mais tempo e custo. O roteiro costuma valer o esforço alto; a revisão e o juiz rodam a cada bloco, então o médio costuma bastar.</p>`
            : `<p class="hint">${a.loading ? "Buscando modelos…" : "Cadastre uma chave de API e salve para listar os modelos."}</p>`
        }
      </section>
      <section>
        <h3>Padrões de um projeto novo</h3>
        <p class="hint">Valem para os próximos projetos criados. Cada projeto muda os seus na aba Projeto.</p>
        <div class="form-grid">
          <label>Resolução<select data-default="resolution">${["360p", "540p", "720p", "1080p"].map((r) => option(r, r, d.resolution)).join("")}</select></label>
          <label>Proporção<select data-default="aspectRatio">${["16:9", "9:16", "1:1", "4:3", "3:2", "4:5", "21:9"].map((r) => option(r, r, d.aspectRatio)).join("")}</select></label>
          <label>FPS<select data-default="fps" data-type="number">${[24, 25, 48, 50].map((r) => option(r, r, d.fps)).join("")}</select></label>
          <label>Contexto da continuação<select data-default="contextSeconds" data-type="number">${[1, 2, 3, 4, 5].map((r) => option(r, `${r} s`, d.contextSeconds)).join("")}</select></label>
          <label>Retakes se o juiz reprovar<select data-default="retakes" data-type="number">${[0, 1, 2, 3].map((r) => option(r, r === 0 ? "nenhum" : `até ${r}`, d.retakes)).join("")}</select></label>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" data-default="audio" ${d.audio ? "checked" : ""}> Gerar áudio</label>
          <label class="check"><input type="checkbox" data-default="review" ${d.review ? "checked" : ""}> Revisar a continuidade</label>
          <label class="check"><input type="checkbox" data-default="judge" ${d.judge ? "checked" : ""}> Juiz depois de cada bloco</label>
        </div>
      </section>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-action="close-settings">Cancelar</button><button class="btn primary" data-action="save-settings">Salvar</button></div>
  </div>`;
}

function aiProgress(t) {
  const size = t.chars ? ` · ${(t.chars / 1000).toFixed(1)} mil caracteres` : "";
  const thought = t.thought && !t.chars ? `<br><small class="muted">…${esc(t.thought)}</small>` : "";
  const quiet = !t.chars && PHASE_SECONDS(t) > 30 ? " Um roteiro inteiro pode levar alguns minutos de raciocínio antes de o texto começar." : "";
  return `${esc(t.modelName)}: ${esc(t.phase)}${size} · ${fmtElapsed(PHASE_SECONDS(t))}${quiet ? `<br><small class="muted">${quiet}</small>` : ""}${thought}`;
}

const fmtElapsed = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`);

// O contador anda sozinho: durante o raciocínio podem passar minutos sem nenhum evento.
setInterval(() => {
  const t = state.llm?.task;
  const line = document.querySelector(".ai-progress");
  if (t?.status === "running" && line) line.innerHTML = aiProgress(t);
}, 1000);


// Campos de formulários locais (não salvos no projeto).
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset.llm) state.llm[el.dataset.llm] = el.value;
  if (el.dataset.aiKey && state.modal?.type === "settings") state.modal.keys[el.dataset.aiKey] = el.value;
  if (el.dataset.pf) state.previewForm[el.dataset.pf] = el.value;
  if (el.dataset.focus === "avatar-prompt" && state.modal) state.modal.avatarPrompt = el.value;
  if (el.dataset.focus === "avatar-from" && state.modal) state.modal.fromPhoto = el.checked;
});

// Configurações: modelos, esforço e padrões de projeto novo ficam no rascunho até salvar.
document.addEventListener("change", (e) => {
  const el = e.target;
  const m = state.modal;
  if (m?.type !== "settings") return;
  if (el.dataset.settings) m[el.dataset.settings] = el.value;
  if (el.dataset.default) {
    const v = el.type === "checkbox" ? el.checked : el.dataset.type === "number" ? Number(el.value) : el.value;
    m.defaults = { ...m.defaults, [el.dataset.default]: v };
  }
});

// <details> não dispara "input"; guarda se está aberto para sobreviver às renderizações.
document.addEventListener(
  "toggle",
  (e) => {
    if (e.target.dataset?.toggle === "scene-setup") state.sceneSetupOpen = e.target.open;
  },
  true,
);

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
  async "clone-project"() {
    const name = prompt("Nome do novo projeto:", `${state.project.name} (cópia)`);
    if (name === null) return;
    await saveNow();
    const copy = await api("POST", `/api/projects/${state.project.id}/clone`, { name });
    await loadProjects();
    await openProject(copy.id, copy);
    toast("Projeto clonado. Escolha a pasta de saída da cópia antes de gerar.");
  },
  async "clear-scenes"() {
    const n = state.project.scenes.length;
    if (!confirm(`Apagar as ${n} cenas de "${state.project.name}"? Personagens, fundos e configurações ficam. Os vídeos já gerados continuam na pasta de saída.`)) return;
    await saveNow();
    state.project = await api("DELETE", `/api/projects/${state.project.id}/scenes`);
    state.sceneId = null;
    await loadProjects();
    render();
    toast(`${n} cena(s) apagada(s).`);
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
  async "generate-film"() {
    await generateFilm();
  },
  "goto-block"({ scene, id }) {
    state.sceneId = scene;
    state.tab = "scenes";
    render();
    requestAnimationFrame(() => document.querySelector(`[data-range="${CSS.escape(id)}"]`)?.closest(".block")?.scrollIntoView({ block: "center" }));
  },
  async "char-references"({ id }) {
    await saveNow();
    await api("POST", `/api/projects/${state.project.id}/characters/${id}/references`);
    toast("Fichas de referência na fila: frente, perfil e corpo inteiro.");
  },
  async "generate-all"() {
    await generateAll({ missing: false });
  },
  async "generate-all-missing"() {
    await generateAll({ missing: true });
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
  async "resume-job"({ id }) {
    await api("POST", `/api/jobs/${id}/resume`);
    toast("Tarefa retomada.");
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
  async "reset-keyframe"({ scene, id }) {
    await saveNow();
    state.project = await api("POST", `/api/projects/${state.project.id}/scenes/${scene}/blocks/${id}/keyframe/reset`);
    render();
    toast("A próxima geração deste bloco cria uma nova imagem de abertura.");
  },
  async "undo-review"({ scene, id }) {
    await saveNow();
    state.project = await api("POST", `/api/projects/${state.project.id}/scenes/${scene}/blocks/${id}/review/undo`);
    render();
    toast("O bloco voltou ao plano anterior à revisão.");
  },
  async "save-frame"({ scene: sceneId, id }, el) {
    const video = el.closest(".block-media")?.querySelector("video");
    const s = state.project.scenes.find((x) => x.id === sceneId);
    const b = s?.blocks.find((x) => x.id === id);
    if (!video || !b) return;
    await saveNow();
    const r = await api("POST", `/api/projects/${state.project.id}/scenes/${sceneId}/blocks/${id}/frame`, { time: video.currentTime, takeId: b.selectedTakeId });
    absorb(r.project);
    toast(`Quadro de ${video.currentTime.toFixed(1)} s salvo nas prévias. Escolha-o em "Imagem inicial do corte" de um bloco ou como imagem inicial da cena.`);
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
    loadAi().catch(fail);
  },
  "open-settings"() {
    const a = state.ai.settings ?? {};
    state.modal = {
      type: "settings",
      back: state.modal?.type === "llm" ? "llm" : null,
      keys: {},
      model: modelKey(a.model),
      effort: a.effort ?? "high",
      reviewModel: modelKey(a.reviewModel),
      reviewEffort: a.reviewEffort ?? "medium",
      defaults: { ...(a.defaults ?? {}) },
    };
    render();
    loadAi().catch(fail);
  },
  "open-ai-keys"() {
    actions["open-settings"]();
  },
  "close-settings"() {
    state.modal = state.modal?.back ? { type: state.modal.back } : null;
    render();
  },
  async "save-settings"() {
    const m = state.modal;
    const ref = (v) => {
      if (!v) return null;
      const [provider, ...id] = v.split(":");
      return { provider, id: id.join(":") };
    };
    const keys = Object.fromEntries(Object.entries(m.keys).filter(([, v]) => v.trim()));
    const newKey = Object.keys(keys).length > 0;
    state.ai.settings = await api("PUT", "/api/ai", { ...(newKey ? { keys } : {}), model: ref(m.model), effort: m.effort, reviewModel: ref(m.reviewModel), reviewEffort: m.reviewEffort, defaults: m.defaults });
    if (newKey) {
      // Com chave nova, a lista de modelos muda: continua aberto para escolher o modelo.
      m.keys = {};
      await loadAi({ refresh: true });
      if (!state.ai.errors.length && !m.model && state.ai.models.length) return toast("Chave salva. Agora escolha o modelo do roteiro.");
      if (state.ai.errors.length) return toast("Chave salva, mas o provedor recusou. Veja a mensagem.", "error");
    }
    actions["close-settings"]();
    toast("Configurações salvas.");
  },
  async "remove-ai-key"({ id }) {
    state.ai.settings = await api("PUT", "/api/ai", { keys: { [id]: "" } });
    await loadAi({ refresh: true });
  },
  async "refresh-ai-models"() {
    await loadAi({ refresh: true });
  },
  async "ai-generate"() {
    const l = state.llm;
    if (!l.fullScript.trim()) return toast("Cole o roteiro completo.", "error");
    if (l.mode === "replace" && !confirm(`Substituir as ${state.project.scenes.length} cenas atuais pelas cenas geradas? Os vídeos já gerados continuam na pasta de saída.`)) return;
    await saveNow();
    l.task = await api("POST", `/api/projects/${state.project.id}/ai-script`, { script: l.fullScript, seconds: Number(l.fullSeconds) || null, mode: l.mode, film: l.film });
    render();
  },
  "goto-imported"() {
    const id = state.llm.task?.imported?.sceneIds?.[0];
    if (id) state.sceneId = id;
    state.tab = "scenes";
    state.modal = null;
    render();
  },
  async "ai-cancel"() {
    if (state.llm.task) await api("POST", `/api/ai-script/${state.llm.task.id}/cancel`, {});
  },
  "close-modal"() {
    if (state.modal?.type === "settings") return actions["close-settings"]();
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
  "keyframe-ref"(el) {
    const s = state.project.scenes.find((x) => x.id === el.dataset.scene);
    const b = s?.blocks.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const [kind, id] = el.value.split(":");
    const ref = { kind, id: id || null };
    if (el.dataset.level === "scene") s.start = { kind: "keyframe", id: null, ref };
    else b.start = { kind: "keyframe", id: null, ref };
    scheduleSave(0);
    render();
  },
  "scene-start"(el) {
    const s = currentScene();
    const [kind, id] = el.value.split(":");
    s.start =
      kind === "keyframe"
        ? { kind, id: null, ref: s.backgroundId ? { kind: "background", id: s.backgroundId } : { kind: "none", id: null } }
        : { kind, id: id || null };
    scheduleSave(0);
    render();
  },
  "block-start"(el) {
    const s = state.project.scenes.find((x) => x.id === el.dataset.scene);
    const b = s?.blocks.find((x) => x.id === el.dataset.id);
    if (!b) return;
    const [kind, id] = el.value.split(":");
    b.start = kind === "keyframe" ? { kind, id: null, ref: b.start?.kind === "keyframe" ? b.start.ref : { kind: "scene", id: null } } : { kind, id: id || null };
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
  "llm-mode"(el) {
    state.llm.mode = el.value;
  },
  "llm-film"(el) {
    state.llm.film = el.checked;
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

async function generateFilm() {
  await saveNow();
  const p = state.project;
  if (!p.outputDir) {
    actions.tab({ tab: "overview" });
    return toast("Escolha a pasta de saída do projeto antes de gerar.", "error");
  }
  const r = await api("POST", `/api/projects/${p.id}/film`, { missing: true });
  actions.tab({ tab: "queue" });
  const skipped = r.skipped.length ? ` ${r.skipped.length} cena(s) sem nada pendente.` : "";
  toast(`${r.added.length} cena(s) na fila; no fim o Takes une o filme e escreve o relatório.${skipped}`);
}

async function generateAll({ missing }) {
  await saveNow();
  const p = state.project;
  if (!p.outputDir) {
    actions.tab({ tab: "overview" });
    return toast("Escolha a pasta de saída do projeto antes de gerar.", "error");
  }
  const empty = p.scenes.flatMap((s, si) =>
    s.blocks.map((b, bi) => (!b.prompt.trim() && (!missing || !b.selectedTakeId) ? `cena ${si + 1} (${s.title}), bloco ${bi + 1}` : null)).filter(Boolean),
  );
  if (empty.length) return toast(`Blocos sem prompt: ${empty.slice(0, 5).join("; ")}${empty.length > 5 ? ` e mais ${empty.length - 5}` : ""}.`, "error");
  const r = await api("POST", `/api/projects/${p.id}/generate-all`, { missing });
  actions.tab({ tab: "queue" });
  const skipped = r.skipped.length ? ` ${r.skipped.length} pulada(s): ${r.skipped.map((x) => `${x.title} (${x.reason})`).join("; ")}` : "";
  toast(`${r.added.length} cena(s) na fila.${skipped}`);
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
// Chaves cadastradas e modelos disponíveis em cada provedor.
async function loadAi({ refresh = false } = {}) {
  state.ai.loading = true;
  render();
  try {
    state.ai.settings = await api("GET", "/api/ai");
    const r = await api("GET", `/api/ai/models${refresh ? "?refresh=1" : ""}`);
    state.ai.models = r.models;
    state.ai.errors = r.errors;
    if (state.project && !state.llm.task) {
      const tasks = await api("GET", `/api/projects/${state.project.id}/ai-script`);
      if (tasks[0]) applyAiTask(tasks[0]);
    }
  } finally {
    state.ai.loading = false;
    render();
  }
}

function applyAiTask(task) {
  const l = state.llm;
  const before = l.task?.status;
  l.task = task;
  if (task.status === "complete" && before === "running" && task.imported) {
    // O servidor já importou: troca o projeto inteiro (com "substituir", as cenas antigas somem).
    // Sem salvar antes: o rascunho local ainda tem as cenas antigas e as traria de volta.
    clearTimeout(saveTimer);
    saveTimer = null;
    api("GET", `/api/projects/${task.projectId}`)
      .then((fresh) => {
        if (state.project?.id !== fresh.id) return;
        state.project = fresh;
        state.sceneId = task.imported.sceneIds[0] ?? state.sceneId;
        render();
        loadProjects().catch(() => {});
      })
      .catch(fail);
    l.fullScript = "";
    toast(`${task.imported.scenes} cena(s) importada(s).${task.imported.film && !task.imported.film.error ? " O filme está na fila." : ""}`);
  }
}

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
  state.llm = newLlmState();
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
  let first = true;
  es.addEventListener("jobs", (e) => {
    state.jobs = JSON.parse(e.data);
    if (first) {
      first = false;
      const recovered = state.jobs.filter((j) => j.status === "running" && j.inflight);
      const interrupted = state.jobs.filter((j) => j.status === "interrupted");
      if (recovered.length) toast("O LTX continuou gerando enquanto o Takes estava fechado. Acompanhando o progresso.");
      if (interrupted.length) toast(`${interrupted.length} tarefa(s) interrompida(s). Veja a aba Fila para retomar.`, "error");
    }
    const finished = state.jobs.some((j) => previous.get(j.id) && previous.get(j.id) !== j.status && j.status !== "running");
    for (const j of state.jobs) {
      const was = previous.get(j.id);
      if (was && was !== j.status && (j.status === "error" || j.status === "interrupted")) toast(`${j.title}: ${j.error}`, "error");
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
  es.addEventListener("ai", (e) => {
    const task = JSON.parse(e.data);
    if (task.projectId !== state.project?.id) return;
    const changed = task.status !== state.llm.task?.status || task.id !== state.llm.task?.id;
    applyAiTask(task);
    if (state.modal?.type !== "llm") {
      if (changed && task.status === "error") toast(`Roteiro automático: ${task.error}`, "error");
      return;
    }
    // Durante a geração só a linha de progresso muda, para não atrapalhar a digitação.
    const line = document.querySelector(".ai-progress");
    if (!changed && line && task.status === "running") line.innerHTML = aiProgress(task);
    else render();
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
  loadAi().catch(() => {});
  pollLtx();
  setInterval(pollLtx, 15000);
})();
