// Cliente do LTX contra um servidor HTTP falso (descoberta de processo simulada).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { LtxClient } from "../server/ltx.js";

async function fakeLtx(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const exec = async (bin, args) => {
    if (bin === "/bin/ps" && args[0] === "-axo") return { stdout: "  4242 /Applications/LTX Desktop.app/Contents/Resources/python/bin/python3 -u ltx2_server.py\n" };
    if (bin === "/bin/ps") return { stdout: "python3 ltx2_server.py LTX_AUTH_TOKEN=segredo LTX_PORT=1" };
    return { stdout: `python3 4242 me 8u IPv4 0x0 0t0 TCP 127.0.0.1:${port} (LISTEN)\n` };
  };
  return { client: new LtxClient({ exec }), close: () => server.close() };
}

const json = (res, status, data) => (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(data)));

test("sends the session token and waits for slow responses", async () => {
  const { client, close } = await fakeLtx((req, res) => {
    assert.equal(req.headers.authorization, "Bearer segredo");
    if (req.url === "/api/generation/progress") return json(res, 200, { status: "idle", id: null });
    setTimeout(() => json(res, 200, { status: "complete", video_path: "/tmp/v.mp4" }), 300);
  });
  try {
    assert.deepEqual(await client.generateVideo({ prompt: "x" }), { status: "complete", video_path: "/tmp/v.mp4" });
  } finally {
    close();
  }
});

test("recovers the result through progress when the connection drops", async () => {
  let polls = 0;
  const { client, close } = await fakeLtx((req, res) => {
    if (req.url === "/api/extend") return req.socket.destroy();
    if (polls++ === 0) return json(res, 200, { status: "complete", id: "old", result: "/tmp/old.mp4" });
    if (polls < 3) return json(res, 200, { status: "running", id: "new", progress: 50 });
    return json(res, 200, { status: "complete", id: "new", result: "/tmp/ext.mp4" });
  });
  try {
    const r = await client.extend({ video_path: "/tmp/c.mp4", duration: 5 });
    assert.deepEqual(r, { status: "complete", video_path: "/tmp/ext.mp4" });
  } finally {
    close();
  }
});

test("reports LTX errors and does not recover a generation that never started", async () => {
  const { client, close } = await fakeLtx((req, res) => {
    if (req.url === "/api/generate") return json(res, 409, { error: { message: "NO_DOWNLOADED_LTX_MODEL" } });
    if (req.url === "/api/extend") return req.socket.destroy();
    return json(res, 200, { status: "complete", id: "same", result: "/tmp/old.mp4" });
  });
  try {
    await assert.rejects(client.generateVideo({ prompt: "x" }), /NO_DOWNLOADED_LTX_MODEL/);
    await assert.rejects(client.extend({ video_path: "/x.mp4", duration: 3 }), /conexão/);
  } finally {
    close();
  }
});
