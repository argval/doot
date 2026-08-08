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

export class FakeSarvamServer {
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  readonly connections: FakeConnection[] = [];

  constructor() {
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

  async endpoint(): Promise<string> {
    if (!this.server.address()) {
      await new Promise<void>((resolve) => {
        this.server.once("listening", resolve);
      });
    }
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}/speech-to-text/ws`;
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
    await waitFor(() => (
      this.connections.length >= count ? true : undefined
    ));
  }

  async waitForAudioFrames(connectionIndex: number, count: number): Promise<unknown[]> {
    return waitFor(() => {
      const connection = this.connections[connectionIndex];
      if (!connection) return undefined;
      const audioFrames = connection.messages.filter(isAudioMessage);
      return audioFrames.length >= count ? audioFrames : undefined;
    });
  }

  async waitForFlush(connectionIndex: number): Promise<void> {
    await waitFor(() => {
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

async function waitFor<T>(
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

function isAudioMessage(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.audio)
    && typeof value.audio.data === "string";
}

function isFlushMessage(value: unknown): boolean {
  return isRecord(value) && value.type === "flush";
}
