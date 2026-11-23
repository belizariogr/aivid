// Player da cena: toca todos os blocos em sequência sem pausa entre eles (dois <video> alternados)
// e tem um modo "transições" que mostra só o fim de cada bloco e o começo do seguinte.
const fmt = (t) => {
  const s = Math.max(0, Math.round(t));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const MODE = { start: "Início", continue: "Continua o movimento", frame: "Do último quadro", cut: "Corte" };

export function openPlayer({ title, items }) {
  const total = items.reduce((t, i) => t + i.duration, 0);
  const overlay = document.createElement("div");
  overlay.className = "overlay top";
  overlay.innerHTML = `
    <div class="modal player" role="dialog" aria-label="Assistir cena">
      <div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="icon-btn" data-p="close" title="Fechar (Esc)">✕</button></div>
      <div class="stage">
        <video playsinline preload="auto"></video>
        <video playsinline preload="auto"></video>
        <div class="stage-label"></div>
        <div class="stage-empty" hidden>Nenhum bloco gerado ainda.</div>
      </div>
      <div class="timeline">
        ${items
          .map(
            (it) =>
              `<button class="seg ${it.src ? "" : "missing"} ${it.state === "stale" ? "stale" : ""}" data-seg="${it.index}" style="flex:${it.duration}" title="Bloco ${it.index + 1} · ${it.duration}s${it.src ? "" : " (não gerado)"}"><span>${it.index + 1}</span></button>`,
          )
          .join("")}
        <div class="playhead"></div>
      </div>
      <div class="player-controls">
        <button class="btn" data-p="prev" title="Bloco anterior (←)">⏮</button>
        <button class="btn primary" data-p="toggle" title="Tocar/pausar (espaço)">▶</button>
        <button class="btn" data-p="next" title="Próximo bloco (→)">⏭</button>
        <span class="time">00:00 / ${fmt(total)}</span>
        <label class="check"><input type="checkbox" data-p="transitions"> Só as transições</label>
        <select data-p="window" title="Segundos antes e depois de cada emenda">
          <option value="1.5">±1,5 s</option><option value="2" selected>±2 s</option><option value="3">±3 s</option>
        </select>
        <select data-p="rate" title="Velocidade"><option value="0.5">0,5×</option><option value="1" selected>1×</option></select>
        <label class="check"><input type="checkbox" data-p="loop"> Repetir</label>
      </div>
    </div>`;
  document.body.append(overlay);

  const vids = [...overlay.querySelectorAll("video")];
  const label = overlay.querySelector(".stage-label");
  const head = overlay.querySelector(".playhead");
  const timeEl = overlay.querySelector(".time");
  const toggleBtn = overlay.querySelector('[data-p="toggle"]');
  let front = 0;
  let segments = [];
  let seg = 0;
  let playing = false;
  let raf = 0;
  let transitions = false;
  let win = 2;
  let rate = 1;
  let loop = false;

  function build() {
    const ready = items.filter((i) => i.src);
    if (!transitions) segments = ready.map((item) => ({ item, from: 0, to: null }));
    else {
      segments = [];
      for (let k = 1; k < items.length; k++) {
        const a = items[k - 1];
        const b = items[k];
        if (!a.src || !b.src) continue;
        segments.push({ item: a, from: Math.max(0, a.duration - win), to: null, pair: k });
        segments.push({ item: b, from: 0, to: Math.min(b.duration, win), pair: k });
      }
    }
    overlay.querySelector(".stage-empty").hidden = segments.length > 0;
    if (transitions && !segments.length) overlay.querySelector(".stage-empty").textContent = "Gere ao menos dois blocos seguidos para ver as transições.";
  }

  function prepare(video, s) {
    if (video.dataset.src !== s.item.src) {
      video.src = s.item.src;
      video.dataset.src = s.item.src;
    }
    video.playbackRate = rate;
    const seek = () => (video.currentTime = s.from);
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
  }

  function show(i, { offset = null, autoplay = playing } = {}) {
    if (!segments.length) return;
    seg = (i + segments.length) % segments.length;
    const s = segments[seg];
    const back = vids[1 - front];
    // Se o próximo trecho já estava carregado no vídeo de trás, troca sem recarregar.
    if (back.dataset.src === s.item.src && offset == null && Math.abs(back.currentTime - s.from) < 0.1) front = 1 - front;
    const v = vids[front];
    vids[1 - front].pause();
    if (offset != null || v.dataset.src !== s.item.src || Math.abs(v.currentTime - s.from) > 0.1) {
      prepare(v, s);
      if (offset != null) {
        const go = () => (v.currentTime = offset);
        if (v.readyState >= 1) go();
        else v.addEventListener("loadedmetadata", go, { once: true });
      }
    }
    vids.forEach((x, n) => x.classList.toggle("active", n === front));
    label.textContent = transitions
      ? `Emenda ${s.pair} → ${s.pair + 1} · bloco ${s.item.index + 1}`
      : `Bloco ${s.item.index + 1} · ${MODE[s.item.continuity] || ""}`;
    overlay.querySelectorAll(".seg").forEach((b) => b.classList.toggle("current", Number(b.dataset.seg) === s.item.index));
    if (autoplay) v.play().catch(() => {});
    const next = segments[seg + 1] ?? (loop ? segments[0] : null);
    if (next) prepare(vids[1 - front], next);
  }

  function advance() {
    if (seg + 1 >= segments.length && !loop) {
      setPlaying(false);
      return;
    }
    show(seg + 1, { autoplay: true });
  }

  function tick() {
    const s = segments[seg];
    const v = vids[front];
    if (s && playing) {
      if (s.to != null && v.currentTime >= s.to) advance();
      else if (v.ended) advance();
    }
    if (s) {
      const t = s.item.start + Math.min(v.currentTime || 0, s.item.duration);
      head.style.left = `${(t / total) * 100}%`;
      timeEl.textContent = `${fmt(t)} / ${fmt(total)}`;
    }
    raf = requestAnimationFrame(tick);
  }

  function setPlaying(value) {
    playing = value && segments.length > 0;
    toggleBtn.textContent = playing ? "⏸" : "▶";
    const v = vids[front];
    if (playing) {
      if (v.ended) show(seg + 1 >= segments.length ? 0 : seg, { autoplay: true });
      else v.play().catch(() => {});
    } else v.pause();
  }

  vids.forEach((v) => v.addEventListener("ended", () => playing && v === vids[front] && advance()));

  overlay.addEventListener("click", (e) => {
    const p = e.target.closest("[data-p]")?.dataset.p;
    const segBtn = e.target.closest("[data-seg]");
    if (p === "close" || e.target === overlay) return close();
    if (p === "toggle") setPlaying(!playing);
    if (p === "prev") show(transitions ? seg - (seg % 2) - 2 : seg - 1);
    if (p === "next") show(transitions ? seg - (seg % 2) + 2 : seg + 1);
    if (segBtn) {
      const index = Number(segBtn.dataset.seg);
      const rect = segBtn.getBoundingClientRect();
      const item = items[index];
      const offset = ((e.clientX - rect.left) / rect.width) * item.duration;
      const at = segments.findIndex((s) => s.item.index === index);
      if (at >= 0) show(at, { offset: transitions ? null : offset });
    }
  });
  overlay.addEventListener("change", (e) => {
    const p = e.target.dataset.p;
    if (p === "transitions") {
      transitions = e.target.checked;
      build();
      show(0);
    }
    if (p === "window") {
      win = Number(e.target.value);
      build();
      show(Math.min(seg, segments.length - 1));
    }
    if (p === "rate") {
      rate = Number(e.target.value);
      vids.forEach((v) => (v.playbackRate = rate));
    }
    if (p === "loop") loop = e.target.checked;
  });
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === " ") {
      e.preventDefault();
      setPlaying(!playing);
    }
    if (e.key === "ArrowRight") show(seg + 1);
    if (e.key === "ArrowLeft") show(seg - 1);
  };
  document.addEventListener("keydown", onKey);

  function close() {
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey);
    vids.forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
    overlay.remove();
  }

  build();
  show(0, { autoplay: false });
  tick();
  setPlaying(true);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
