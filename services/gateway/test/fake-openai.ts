import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

interface FakeConnection {
  socket: WebSocket;
  request: IncomingMessage;
  messages: unknown[];
}

export class FakeOpenAITranslateServer {
  private readonly server: WebSocketServer;
  readonly connections: FakeConnection[] = [];

  constructor() {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
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
    return `ws://127.0.0.1:${address.port}/v1/realtime/translations`;
  }

  send(connectionIndex: number, payload: unknown): void {
    const connection = this.connections[connectionIndex];
    if (!connection) throw new Error(`Missing fake OpenAI connection ${connectionIndex}`);
    connection.socket.send(JSON.stringify(payload));
  }

  async waitForConnections(count: number): Promise<void> {
    await waitForOpenAI(() => (
      this.connections.length >= count ? true : undefined
    ));
  }

  async waitForMessage(
    connectionIndex: number,
    predicate: (message: unknown) => boolean,
  ): Promise<unknown> {
    return waitForOpenAI(() => (
      this.connections[connectionIndex]?.messages.find(predicate)
    ));
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

async function waitForOpenAI<T>(
  probe: () => T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake OpenAI condition");
}
