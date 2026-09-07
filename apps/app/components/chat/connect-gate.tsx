"use client";

import { useAppKit } from "@reown/appkit/react";
import { MoonIcon, SunIcon } from "lucide-react";
import Image from "next/image";
import { useTheme } from "next-themes";
import { useAccount, useDisconnect } from "wagmi";
import { Button } from "@/components/ui/button";
import { useHelicoSession } from "@/hooks/use-helico-session";
import { cn } from "@/lib/utils";

/**
 * The gate. Helico prices a swap against what somebody actually holds, so the wallet comes
 * before the conversation rather than after it.
 *
 * Layout and motion follow the reference: the hero panel on the left, its content rising into
 * place a beat at a time, and the action column on the right. The reference fills its hero with
 * a looping video; there is no such asset here and hot-linking the one in its markup would be
 * borrowing someone else's file, so the panel drifts slowly instead of sitting still.
 */
const STEPS = [
  "Connect your wallet",
  "Verify it, once",
  "Say what you want to swap",
] as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ConnectGate() {
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { address, isConnected } = useAccount();
  const session = useHelicoSession();
  const { resolvedTheme, setTheme } = useTheme();

  const current = isConnected ? 1 : 0;

  // A cookie for one address while a different wallet is connected: the person is signed in,
  // just not as who they are now. Worth saying, because otherwise the gate looks stuck.
  const mismatch =
    session.signedInAs !== null &&
    address !== undefined &&
    session.signedInAs !== address.toLowerCase();

  /** Pick a different wallet. The old session goes with it — the cookie was that address's. */
  const useAnother = async () => {
    await session.signOut();
    disconnect();
    open({ view: "Connect" });
  };

  return (
    <main className="flex min-h-dvh w-full bg-background p-2 lg:h-dvh lg:overflow-hidden lg:p-4">
      {/* The reference anchors this block to the bottom because a video fills the panel behind
          it. With a gradient there is nothing to sit under, so it is centred. */}
      <section className="relative hidden shrink-0 flex-col items-center justify-center overflow-hidden rounded-3xl px-12 shadow-2xl lg:flex lg:w-[52%]">
        <div className="drift absolute inset-0 bg-gradient-to-br from-secondary via-muted to-background" />
        <div className="relative z-10 w-full max-w-80 space-y-8">
          <div
            className="stagger flex items-center gap-2"
            style={{ animationDelay: "0.2s" }}
          >
            <Image alt="" height={22} src="/brand/mark.webp" width={22} />
            <span className="font-semibold text-xl tracking-tight">helico</span>
          </div>

          <div className="stagger" style={{ animationDelay: "0.35s" }}>
            <h1 className="font-medium text-4xl tracking-tight">
              Your wallet is the account
            </h1>
            <p className="mt-3 text-muted-foreground text-sm leading-relaxed">
              No email, no password, nothing to remember. Three steps, and
              nothing moves until you sign it.
            </p>
          </div>

          <ol className="space-y-3">
            {STEPS.map((label, i) => (
              <li
                className={cn(
                  "stagger flex items-center gap-3 rounded-xl px-4 py-3.5 font-medium text-sm",
                  i === current
                    ? "border border-foreground bg-foreground text-background"
                    : "bg-muted/60 text-foreground",
                )}
                key={label}
                style={{ animationDelay: `${0.5 + i * 0.15}s` }}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full font-semibold text-xs",
                    i === current
                      ? "bg-background text-foreground"
                      : "bg-foreground/10 text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="relative flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-12 sm:px-12 lg:px-16 xl:px-24">
        {/* The only theme control before the gate; the rest live in the sidebar behind it. */}
        <Button
          aria-label="Toggle theme"
          className="absolute top-4 right-4"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          size="icon"
          variant="ghost"
        >
          {resolvedTheme === "dark" ? (
            <SunIcon className="size-4" />
          ) : (
            <MoonIcon className="size-4" />
          )}
        </Button>

        <div className="w-full max-w-lg space-y-8">
          <div className="stagger" style={{ animationDelay: "0.2s" }}>
            <h2 className="font-medium text-3xl tracking-tight">
              {isConnected ? "One signature to finish" : "Connect a wallet"}
            </h2>
            <p className="mt-2 text-muted-foreground text-sm">
              {isConnected
                ? "It costs no gas and proves the address is yours. Your conversations stay with that wallet and nobody else's."
                : "Helico quotes against what you actually hold, so it needs to know which wallet is asking."}
            </p>
          </div>

          <div
            className="stagger space-y-3"
            style={{ animationDelay: "0.35s" }}
          >
            {isConnected ? (
              <>
                <Button
                  className="h-14 w-full rounded-xl font-semibold text-[15px]"
                  disabled={session.signing}
                  onClick={session.signIn}
                >
                  {session.signing ? "Check your wallet…" : "Verify wallet"}
                </Button>
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {address ? short(address) : null}
                  </span>
                  <button
                    className="font-medium text-foreground hover:underline"
                    onClick={useAnother}
                    type="button"
                  >
                    Use a different wallet
                  </button>
                </div>
                {mismatch ? (
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    You are signed in as{" "}
                    <span className="font-mono">
                      {short(session.signedInAs as string)}
                    </span>
                    , which is not the wallet connected now. Verifying this one
                    replaces it.
                  </p>
                ) : null}
              </>
            ) : (
              <Button
                className="h-14 w-full rounded-xl font-semibold text-[15px]"
                onClick={() => open()}
              >
                Connect wallet
              </Button>
            )}

            {session.error ? (
              <p className="text-destructive text-sm">{session.error}</p>
            ) : null}
          </div>

          <p
            className="stagger text-center text-muted-foreground text-sm"
            style={{ animationDelay: "0.5s" }}
          >
            Helico never holds your funds.{" "}
            <a
              className="font-medium text-foreground hover:underline"
              href="https://docs.helico.site/docs/introduction"
              rel="noreferrer"
              target="_blank"
            >
              How it works
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
