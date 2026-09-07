import { describe, expect, test } from "bun:test";

import { upstreamHeaders } from "./upstream";

/**
 * The whole point of this function is a header that was missing, and the symptom of it missing
 * was not an error anywhere — it was every visitor sharing one rate-limit bucket on a paid
 * endpoint. Nothing would have failed; the app would just have stopped answering for everybody
 * at once, at six messages a minute, and looked like the backend was down.
 */
describe("upstreamHeaders", () => {
  test("carries the caller's address through, so the limiter counts visitors", () => {
    const headers = upstreamHeaders(
      new Headers({ "x-real-ip": "203.0.113.7" }),
    );
    expect(headers["X-Real-IP"]).toBe("203.0.113.7");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends nothing when the proxy did not set one, rather than inventing a value", () => {
    const headers = upstreamHeaders(new Headers());
    expect(headers["X-Real-IP"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("a blank header is treated as absent", () => {
    expect(
      upstreamHeaders(new Headers({ "x-real-ip": "   " }))["X-Real-IP"],
    ).toBeUndefined();
  });

  /**
   * `X-Forwarded-For` is deliberately not read. The backend ignores it for the reason recorded
   * in `apps/be/internal/httpapi/limit.go`: an appending proxy leaves its first entry in the
   * caller's hands, and a forged single-entry header is indistinguishable from a real one.
   */
  test("ignores X-Forwarded-For, which the backend does not trust either", () => {
    const headers = upstreamHeaders(
      new Headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }),
    );
    expect(headers["X-Real-IP"]).toBeUndefined();
  });
});
