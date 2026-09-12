import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "../src/server.js";
import { connect } from "node:net";
import { once } from "node:events";

test("denied WebSocket upgrades close their sockets so the service can stop", { timeout: 3000 }, async () => {
  const app = await buildServer(undefined, undefined, { authToken: "test-desktop-token" });
  const address = new URL(await app.listen({ host: "127.0.0.1", port: 0 }));
  const socket = connect(Number(address.port), "127.0.0.1");
  let response = "";
  socket.on("data", (data) => { response += data.toString(); });
  socket.setTimeout(1000, () => socket.destroy(new Error("Rejected upgrade stayed open")));
  try {
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write("GET /v1/realtime HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await closed;
    assert.match(response, /HTTP\/1.1 401/);
  } finally { socket.destroy(); await app.close(); }
});

test("gateway authenticates requests and rejects foreign browser origins before upgrading", async (context) => {
  const app = await buildServer(undefined, undefined, { authToken: "test-desktop-token" });
  context.after(() => app.close());
  assert.equal((await app.inject({ url: "/v1/history/sessions" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/v1/realtime", headers: { origin: "https://untrusted.example", authorization: "Bearer test-desktop-token" } })).statusCode, 403);
  assert.equal((await app.inject({ url: "/health", headers: { authorization: "Bearer wrong" } })).statusCode, 401);
  assert.equal((await app.inject({ url: "/health", headers: { authorization: "Bearer test-desktop-token" } })).statusCode, 200);
  const preflight = await app.inject({ method: "OPTIONS", url: "/v1/route", headers: { origin: "tauri://localhost", "access-control-request-headers": "authorization" } });
  assert.equal(preflight.statusCode, 204);
  assert.match(String(preflight.headers["access-control-allow-headers"]), /Authorization/);
});
