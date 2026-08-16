import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

interface FakeGeminiConnection {
  socket: WebSocket;
  request: IncomingMessage;
  messages: unknown[];
}

export class FakeGeminiServer {
  private readonly server: WebSocketServer;
  readonly connections: FakeGeminiConnection[] = [];

  constructor(rejectConnections = false) {
    this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (_info, accept) => accept(!rejectConnections),
    });
    this.server.on("connection", (socket, request) => {
      const connection: FakeGeminiConnection = { socket, request, messages: [] };
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
      await new Promise<void>((resolve) => this.server.once("listening", resolve));
    }
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
  }

  send(payload: unknown, connectionIndex = 0): void {
    const connection = this.connections[connectionIndex];
    if (!connection) throw new Error(`Missing fake Gemini connection ${connectionIndex}`);
    connection.socket.send(JSON.stringify(payload));
  }

  terminate(connectionIndex = 0): void {
    const connection = this.connections[connectionIndex];
    if (!connection) throw new Error(`Missing fake Gemini connection ${connectionIndex}`);
    connection.socket.terminate();
  }

  async waitForConnection(): Promise<FakeGeminiConnection> {
    return waitForGemini(() => this.connections[0]);
  }

  async waitForConnectionCount(count: number): Promise<FakeGeminiConnection> {
    return waitForGemini(() => this.connections[count - 1]);
  }

  async waitForMessage(
    predicate: (message: unknown) => boolean,
    connectionIndex = 0,
  ): Promise<unknown> {
    return waitForGemini(() => {
      const connection = this.connections[connectionIndex];
      return connection?.messages.find(predicate);
    });
  }

  async close(): Promise<void> {
    for (const connection of this.connections) {
      if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

export async function waitForGemini<T>(
  read: () => T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = read();
    if (result !== undefined) return result;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for fake Gemini state");
}
