/**
 * The browser's side of `apps/be`.
 *
 * These calls go to the backend directly rather than through a Next route, because the session
 * is a cookie and a cookie issued by one host cannot be proxied through another without
 * rewriting it. `credentials: "include"` is what carries it; the backend's CORS allow-list is
 * what permits it. The swap intent keeps going through `/api/chat`, which has its own reason.
 */
const BASE = (
  process.env.NEXT_PUBLIC_BE_API_URL ?? "https://api.helico.site"
).replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // The backend answers problem+json, whose detail is written for a person to read.
    throw new ApiError(
      res.status,
      (body as { detail?: string } | null)?.detail ?? res.statusText,
    );
  }
  return body as T;
}

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  intent?: unknown;
  createdAt: string;
};

export type Challenge = {
  nonce: string;
  issuedAt: number;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  };
};

export const api = {
  challenge: (address: string) =>
    call<Challenge>(
      `/api/session/nonce?address=${encodeURIComponent(address)}`,
    ),
  signIn: (body: {
    wallet: string;
    nonce: string;
    issuedAt: number;
    signature: string;
  }) =>
    call<{ address: string }>("/api/session", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  whoami: () => call<{ address: string }>("/api/session"),
  signOut: () => call<void>("/api/session", { method: "DELETE" }),

  conversations: () =>
    call<{ conversations: Conversation[] }>("/api/chats").then(
      (r) => r.conversations,
    ),
  startConversation: (message?: string) =>
    call<Conversation>("/api/chats", {
      method: "POST",
      body: JSON.stringify({ message: message ?? "" }),
    }),
  messages: (id: string) =>
    call<{ messages: StoredMessage[] }>(`/api/chats/${id}`).then(
      (r) => r.messages,
    ),
  append: (
    id: string,
    body: { role: "user" | "assistant"; body: string; intent?: unknown },
  ) =>
    call<StoredMessage>(`/api/chats/${id}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteConversation: (id: string) =>
    call<void>(`/api/chats/${id}`, { method: "DELETE" }),
  deleteConversations: () =>
    call<{ deleted: number }>("/api/chats", { method: "DELETE" }),
};
