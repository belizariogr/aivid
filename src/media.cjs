const fs = require("node:fs");
const { Readable } = require("node:stream");
function byteRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return false;
  let start, end;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return false;
  return { start, end };
}
function mediaResponse(file, request) {
  if (!file || !fs.existsSync(file))
    return new Response("Não encontrado", { status: 404 });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405 });
  const size = fs.statSync(file).size;
  if (!size) return new Response(null, { status: 404 });
  const range = byteRange(request.headers.get("range"), size);
  if (range === false)
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  const start = range?.start || 0,
    end = range?.end ?? size - 1;
  const headers = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  const body =
    request.method === "HEAD"
      ? null
      : Readable.toWeb(fs.createReadStream(file, { start, end }));
  return new Response(body, { status: range ? 206 : 200, headers });
}
function playlist(project, jobs) {
  return (project.scenes || []).map((scene, index) => {
    const candidates = jobs
      .filter((j) => j.projectId === project.id)
      .slice()
      .reverse();
    for (const j of candidates) {
      const n = j.scenes.findIndex((s) => s.id === scene.id);
      if (n >= 0 && j.files[n] && fs.existsSync(j.files[n]))
        return {
          sceneId: scene.id,
          number: index + 1,
          title: scene.name,
          file: j.files[n],
        };
    }
    return {
      sceneId: scene.id,
      number: index + 1,
      title: scene.name,
      file: null,
    };
  });
}
module.exports = { byteRange, mediaResponse, playlist };
