import {
  type HistorySessionDetail,
  type HistorySessionListResponse,
  type HistorySessionSummary,
} from "@doot/protocol";

import { gatewayFetch } from "./gateway";

export class HistoryRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HistoryRequestError";
  }
}

export async function fetchHistorySessions(
  query = "",
  signal?: AbortSignal,
  offset = 0,
  limit = 20,
): Promise<HistorySessionSummary[]> {
  const params = new URLSearchParams();
  params.set("offset", String(offset));
  params.set("limit", String(limit));
  if (query.trim()) {
    params.set("q", query.trim());
  }
  const encoded = params.toString();
  const suffix = encoded ? `?${encoded}` : "";
  const body = await historyJson<HistorySessionListResponse>(
    `/v1/history/sessions${suffix}`,
    { signal },
  );
  return body.sessions;
}

export async function renameHistorySession(sessionId: string, title: string): Promise<void> {
  await historyRequest(`/v1/history/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }),
  });
}

export async function fetchHistorySession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<HistorySessionDetail> {
  return historyJson<HistorySessionDetail>(
    `/v1/history/sessions/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

export async function deleteHistorySession(sessionId: string): Promise<void> {
  await historyRequest(
    `/v1/history/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  );
}

async function historyJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await historyRequest(path, init);
  return await response.json() as T;
}

async function historyRequest(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await gatewayFetch(path, init);
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === "AbortError") {
      throw caught;
    }
    throw new HistoryRequestError("Caption service is not reachable.", 0);
  }
  if (!response.ok) {
    if (response.status === 503) {
      throw new HistoryRequestError("Caption history is not available.", 503);
    }
    if (response.status === 404) {
      throw new HistoryRequestError("That session is no longer saved.", 404);
    }
    throw new HistoryRequestError("Could not load caption history.", response.status);
  }
  return response;
}
