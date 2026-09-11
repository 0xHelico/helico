import { ONEINCH_API } from "@helico/plugin-1inch";
import { type NextRequest, NextResponse } from "next/server";
import { forwards, overLimit } from "@/lib/oneinch-proxy";

/**
 * The one place the 1inch key exists in this app, and it is the server.
 *
 * **Why a proxy at all.** The aggregation API needs a key, and a key the browser can see is a key
 * everyone has: `NEXT_PUBLIC_` inlines its value into the client bundle, so the prefix is not an
 * option here and never will be. The dapp asks this route, this route adds the header.
 *
 * **Why an allowlist rather than a pass-through.** A proxy that forwards any path is a way for
 * anybody to spend our quota on anything 1inch sells, with our key and without our knowledge. Six
 * shapes are allowed, matched whole, and everything else is answered 404 by us — not forwarded and
 * then refused by them.
 *
 * The ceiling on this is honest: the counter below is per instance and in memory, so it resets on
 * deploy and would not hold across several. One VM runs this, which is the case it is written for.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  // The path first, then the key. The path is a fact about the request and the key is a fact about
  // the deployment, so asking in this order is what makes the refusal honest: with the checks the
  // other way round, a deployment with no key answered 503 "no key" for `portfolio/v5/anything` —
  // which says "we would have forwarded this if we could", and that is false. It also means the
  // allowlist can be confirmed from outside without a key, which is the only way anybody but us
  // can see that it is there.
  const path = (await params).path.join("/");
  if (!forwards(path)) {
    return NextResponse.json(
      { code: "NOT_ALLOWED", description: "This proxy does not forward that." },
      { status: 404 },
    );
  }
  const key = process.env.ONEINCH_API_KEY;
  if (!key) {
    return NextResponse.json(
      { code: "NO_KEY", description: "This deployment has no 1inch API key." },
      { status: 503 },
    );
  }
  const who =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (overLimit(who)) {
    return NextResponse.json(
      {
        code: "RATE_LIMITED",
        description: "Too many requests. Wait a minute.",
      },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const upstream = `${ONEINCH_API}/${path}${request.nextUrl.search}`;
  const response = await fetch(upstream, {
    headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
  });
  // Their status and their body, unchanged. `NOT_ENOUGH_ALLOWANCE` is the difference between "fix
  // this in one transaction" and "this cannot be done", and rewriting it here would lose that.
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
