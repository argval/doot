import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";

export async function gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
  const connection = isTauriRuntime()
    ? await invoke<{ origin: string; token: string }>("gateway_connection")
    : { origin: "http://127.0.0.1:8787", token: "" };
  const headers = new Headers(init?.headers);
  if (connection.token) headers.set("Authorization", `Bearer ${connection.token}`);
  return fetch(`${connection.origin}${path}`, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(5000) });
}
