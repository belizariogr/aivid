// Editor de foto: enquadrar (arrastar/zoom), girar, espelhar e ajustar brilho, contraste e saturação.
const VIEW = 400;

export function editPhoto(src, { output = 1024, title = "Editar foto" } = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => open();
    img.src = src;

    function open() {
      const s = { zoom: 1, x: 0, y: 0, rot: 0, flip: false, brightness: 100, contrast: 100, saturate: 100 };
      const overlay = document.createElement("div");
      overlay.className = "overlay top";
      overlay.innerHTML = `
        <div class="modal cropper" role="dialog" aria-label="${title}">
          <div class="modal-head"><h2>${title}</h2><button class="icon-btn" data-c="cancel" title="Fechar">✕</button></div>
          <div class="cropper-body">
            <canvas width="${VIEW}" height="${VIEW}"></canvas>
            <div class="cropper-controls">
              <label>Zoom <input type="range" data-k="zoom" min="1" max="5" step="0.01" value="1"></label>
              <label>Brilho <input type="range" data-k="brightness" min="40" max="160" value="100"></label>
              <label>Contraste <input type="range" data-k="contrast" min="40" max="160" value="100"></label>
              <label>Saturação <input type="range" data-k="saturate" min="0" max="200" value="100"></label>
              <div class="row">
                <button class="btn" data-c="left">⟲ Girar</button>
                <button class="btn" data-c="right">⟳ Girar</button>
                <button class="btn" data-c="flip">⇋ Espelhar</button>
                <button class="btn ghost" data-c="reset">Restaurar</button>
              </div>
              <p class="hint">Arraste a imagem para enquadrar. Use a roda do mouse para aproximar.</p>
            </div>
          </div>
          <div class="modal-foot"><button class="btn ghost" data-c="cancel">Cancelar</button><button class="btn primary" data-c="ok">Aplicar</button></div>
        </div>`;
      document.body.append(overlay);
      const canvas = overlay.querySelector("canvas");
      const ctx = canvas.getContext("2d");

      const baseScale = () => {
        const rotated = s.rot % 180 !== 0;
        const w = rotated ? img.height : img.width;
        const h = rotated ? img.width : img.height;
        return Math.max(VIEW / w, VIEW / h);
      };

      function paint(target, size, guide) {
        const k = size / VIEW;
        target.save();
        target.fillStyle = "#000";
        target.fillRect(0, 0, size, size);
        target.filter = `brightness(${s.brightness}%) contrast(${s.contrast}%) saturate(${s.saturate}%)`;
        target.translate(size / 2 + s.x * k, size / 2 + s.y * k);
        target.rotate((s.rot * Math.PI) / 180);
        target.scale((s.flip ? -1 : 1) * baseScale() * s.zoom * k, baseScale() * s.zoom * k);
        target.drawImage(img, -img.width / 2, -img.height / 2);
        target.restore();
        if (guide) {
          target.save();
          target.fillStyle = "rgba(0,0,0,.45)";
          target.beginPath();
          target.rect(0, 0, size, size);
          target.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2, true);
          target.fill("evenodd");
          target.strokeStyle = "rgba(255,255,255,.6)";
          target.beginPath();
          target.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
          target.stroke();
          target.restore();
        }
      }

      // Mantém a imagem cobrindo todo o quadro.
      function clamp() {
        const rotated = s.rot % 180 !== 0;
        const w = (rotated ? img.height : img.width) * baseScale() * s.zoom;
        const h = (rotated ? img.width : img.height) * baseScale() * s.zoom;
        const mx = Math.max(0, (w - VIEW) / 2);
        const my = Math.max(0, (h - VIEW) / 2);
        s.x = Math.min(mx, Math.max(-mx, s.x));
        s.y = Math.min(my, Math.max(-my, s.y));
      }
      const draw = () => (clamp(), paint(ctx, VIEW, true));
      draw();

      overlay.addEventListener("input", (e) => {
        const k = e.target.dataset.k;
        if (k) {
          s[k] = Number(e.target.value);
          draw();
        }
      });
      let drag = null;
      canvas.addEventListener("pointerdown", (e) => {
        drag = { x: e.clientX - s.x, y: e.clientY - s.y };
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener("pointermove", (e) => {
        if (!drag) return;
        s.x = e.clientX - drag.x;
        s.y = e.clientY - drag.y;
        draw();
      });
      canvas.addEventListener("pointerup", () => (drag = null));
      canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          s.zoom = Math.min(5, Math.max(1, s.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06)));
          overlay.querySelector('[data-k="zoom"]').value = s.zoom;
          draw();
        },
        { passive: false },
      );

      const close = (value) => {
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener("click", (e) => {
        const c = e.target.closest("[data-c]")?.dataset.c;
        if (!c) return;
        if (c === "cancel") return close(null);
        if (c === "left") s.rot = (s.rot + 270) % 360;
        if (c === "right") s.rot = (s.rot + 90) % 360;
        if (c === "flip") s.flip = !s.flip;
        if (c === "reset") {
          Object.assign(s, { zoom: 1, x: 0, y: 0, rot: 0, flip: false, brightness: 100, contrast: 100, saturate: 100 });
          overlay.querySelectorAll("[data-k]").forEach((el) => (el.value = s[el.dataset.k]));
        }
        if (c === "ok") {
          const out = document.createElement("canvas");
          out.width = out.height = output;
          paint(out.getContext("2d"), output, false);
          return close(out.toDataURL("image/jpeg", 0.92));
        }
        draw();
      });
    }
  });
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function pickFile(accept = "image/png,image/jpeg,image/webp") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
