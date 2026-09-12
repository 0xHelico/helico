import { NextResponse } from "next/server";

import { upstreamHeaders } from "@/lib/upstream";

// The thinking is not here. This hands the sentence to apps/be, which turns it into a checked
// swap intent or a question back, and returns exactly what it said. Going through the server
// keeps the backend's address out of the browser and avoids a cross-origin request.
const BE_API_URL = process.env.BE_API_URL ?? "https://api.helico.site";

export async function POST(request: Request) {
  let message: unknown;
  let history: unknown;
  let address: unknown;

  try {
    ({ message, history, address } = await request.json());
  } catch {
    return NextResponse.json(
      { error: 'send {"message": "…"}' },
      { status: 400 },
    );
  }

  if (typeof message !== "string" || message.trim() === "") {
    return NextResponse.json(
      { error: "say what you would like to swap" },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(`${BE_API_URL}/api/swap/intent`, {
      method: "POST",
      // Carries the caller's address, so the backend rate-limits per visitor rather than
      // counting the whole app as one client. See lib/upstream.ts.
      headers: upstreamHeaders(request.headers),
      // What was already on screen. The backend bounds it and only ever hands it to the model:
      // every token and amount still goes through the registry afterwards.
      body: JSON.stringify({
        message,
        history: Array.isArray(history) ? history : [],
        // The connected wallet, when there is one. The backend uses it for exactly one thing:
        // telling the index whose account a status question is about. It is public data and a
        // filter, not an identity — the session cookie is the identity, and this is not it.
        ...(typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address)
          ? { address }
          : {}),
      }),
      // A status question that reads the index makes several model and MCP calls in a row;
      // the backend bounds that at 40 seconds, so this has to outlast it.
      signal: AbortSignal.timeout(50_000),
    });

    const body = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      // The backend answers problem+json; its detail is written for a person to read.
      const detail =
        (body as { detail?: string } | null)?.detail ??
        "the swap service is not answering";
      return NextResponse.json({ error: detail }, { status: upstream.status });
    }

    return NextResponse.json(body);
  } catch {
    return NextResponse.json(
      { error: "the swap service could not be reached" },
      { status: 502 },
    );
  }
}
