/**
 * The browser's side of `apps/be`.
 *
 * These calls go to the backend directly rather than through a Next route, because the session
 * is a cookie and a cookie issued by one host cannot be proxied through another without
 * rewriting it. `credentials: "include"` is what carries it; the backend's CORS allow-list is
 * what permits it. The swap intent keeps going through `/api/chat`, which has its own reason.
 */
/**
 * A local run talks to a local backend, and that is correctness rather than convenience.
 *
 * The session is a cookie with `SameSite=Lax`, and `localhost` and `helico.site` are different
 * *sites*. A page on `http://localhost:3000` pointed at `https://api.helico.site` signs in, gets
 * the cookie, and never sends it again: every reload reads as a sign-out, and the sign-in that
 * looked like it worked is the reason that is confusing rather than obvious. Both sides on
 * `localhost` makes the request same-site, which is the only arrangement the session survives.
 *
 * `||` rather than `??` on purpose: an empty value in a `.env` file means "I did not set this",
 * and treating it as a base URL of `""` silently turns every call into a relative one.
 */
const BASE = (
  process.env.NEXT_PUBLIC_BE_API_URL ||
  (process.env.NODE_ENV === "development"
    ? "http://localhost:8787"
    : "https://api.helico.site")
).replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * How long any of these may take before it is treated as a failure.
 *
 * Not optional. Without it a backend that accepts the connection and never answers leaves the
 * promise pending forever — and the session read is what the whole app waits on, so a hung
 * request became a permanently blank page rather than an error.
 */
const TIMEOUT_MS = 12_000;

/**
 * The session read is on the app's critical path, so it gets a much shorter budget than the
 * rest. Twelve seconds of waiting to discover there is no cookie is indistinguishable from a
 * broken page.
 */
const SESSION_TIMEOUT_MS = 3000;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
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

export type SwapConfig = { available: boolean; model: string };

export const api = {
  /** What answers, and whether it can. Shown beside the composer. */
  swapConfig: () => call<SwapConfig>("/api/swap/config"),

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
  whoami: () =>
    call<{ address: string }>("/api/session", {
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    }),
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
