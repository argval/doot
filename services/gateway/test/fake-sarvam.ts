import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import {
  WebSocket,
  WebSocketServer,
} from "ws";
import { isRecord } from "../src/util.js";

interface FakeConnection {
  socket: WebSocket;
  request: IncomingMessage;
  messages: unknown[];
}

interface FakeSarvamServerOptions {
  /** Reject these paths during the WebSocket upgrade, before a connection opens. */
  rejectPaths?: readonly string[];
  /** Delay acceptance for selected paths to exercise client-side handoff queues. */
  acceptDelayMsByPath?: Readonly<Record<string, number>>;
}

export class FakeSarvamServer {
  private readonly server: WebSocketServer;
  readonly connections: FakeConnection[] = [];

  constructor(options: FakeSarvamServerOptions = {}) {
    const rejectedPaths = new Set(options.rejectPaths ?? []);
    const acceptDelayMsByPath = options.acceptDelayMsByPath ?? {};
    this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (
        info: { req: IncomingMessage },
        accept: (accepted: boolean) => void,
      ) => {
        const path = new URL(info.req.url ?? "/", "ws://127.0.0.1").pathname;
        const delayMs = acceptDelayMsByPath[path] ?? 0;
        const accepted = !rejectedPaths.has(path);
        if (delayMs > 0) {
          setTimeout(() => accept(accepted), delayMs);
        } else {
          accept(accepted);
        }
      },
    });
    this.server.on("connection", (socket, request) => {
      const connection: FakeConnection = { socket, request, messages: [] };
      this.connections.push(connection);
      socket.on("message", (raw) => {
        try {
          connection.messages.push(JSON.parse(raw.toString()));
        } catch {
          connection.messages.push(raw.toString());
        }
      });
    });
  }

  async endpoint(path = "/speech-to-text/ws"): Promise<string> {
    if (!this.server.address()) {
      await new Promise<void>((resolve) => {
        this.server.once("listening", resolve);
      });
    }
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}${path}`;
  }

  send(connectionIndex: number, payload: unknown): void {
    const connection = this.connections[connectionIndex];
    if (!connection) throw new Error(`Missing fake Sarvam connection ${connectionIndex}`);
    connection.socket.send(JSON.stringify(payload));
  }

  terminate(connectionIndex: number): void {
    const connection = this.connections[connectionIndex];
    if (!connection) throw new Error(`Missing fake Sarvam connection ${connectionIndex}`);
    connection.socket.terminate();
  }

  async waitForConnections(count: number): Promise<void> {
    await waitForFakeSarvam(() => (
      this.connections.length >= count ? true : undefined
    ));
  }

  async waitForAudioFrames(connectionIndex: number, count: number): Promise<unknown[]> {
    return waitForFakeSarvam(() => {
      const connection = this.connections[connectionIndex];
      if (!connection) return undefined;
      const audioFrames = connection.messages.filter(isAudioMessage);
      return audioFrames.length >= count ? audioFrames : undefined;
    });
  }

  async waitForFlush(connectionIndex: number): Promise<void> {
    await waitForFakeSarvam(() => {
      const connection = this.connections[connectionIndex];
      if (!connection) return undefined;
      return connection.messages.some(isFlushMessage) ? true : undefined;
    });
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      if (connection.socket.readyState !== WebSocket.CLOSED) {
        connection.socket.terminate();
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function waitForFakeSarvam<T>(
  read: () => T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("Timed out waiting for fake Sarvam state");
}

export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  await waitForFakeSarvam(() => (condition() ? true : undefined), timeoutMs);
}

function isAudioMessage(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.audio)
    && typeof value.audio.data === "string";
}

function isFlushMessage(value: unknown): boolean {
  return isRecord(value) && value.type === "flush";
}
