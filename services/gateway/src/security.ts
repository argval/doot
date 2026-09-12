import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

const DESKTOP_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]);

export function protectGateway(app: FastifyInstance, token?: string): void {
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !DESKTOP_ORIGINS.has(origin)) return reply.code(403).send({ message: "This origin cannot access Doot." });
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
    reply.header("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    reply.header("Cache-Control", "no-store");
    if (request.method === "OPTIONS") return reply.code(204).send();
    if (!token) return; // Tests may construct an isolated server without credentials.
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return reply.code(401).send({ message: "Reconnect to the Doot desktop service." });
    }
  });
}
