import { NextResponse } from "next/server";

// The thinking is not here. This hands the sentence to apps/be, which turns it into a checked
// swap intent or a question back, and returns exactly what it said. Going through the server
// keeps the backend's address out of the browser and avoids a cross-origin request.
const BE_API_URL = process.env.BE_API_URL ?? "https://api.helico.site";

export async function POST(request: Request) {
  let message: unknown;

  try {
    ({ message } = await request.json());
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(30_000),
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
