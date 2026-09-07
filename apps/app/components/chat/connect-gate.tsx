"use client";

import { useAppKit } from "@reown/appkit/react";
import Image from "next/image";
import { useAccount } from "wagmi";
import { Button } from "@/components/ui/button";
import { useHelicoSession } from "@/hooks/use-helico-session";
import { cn } from "@/lib/utils";

/**
 * The gate. Helico cannot price a swap without knowing whose balance it is pricing against, so
 * the wallet comes before the conversation rather than after it.
 *
 * Layout follows the reference: a hero panel on the left carrying the brand and the three steps,
 * the action column on the right. The reference fills its hero with a looping video; there is no
 * such asset here, and hot-linking the one in the reference would be borrowing someone else's
 * file, so the panel is a gradient of our own until a real one exists.
 */
const STEPS = [
  "Connect your wallet",
  "Verify it, once",
  "Say what you want to swap",
] as const;

export function ConnectGate() {
  const { open } = useAppKit();
  const { isConnected } = useAccount();
  const session = useHelicoSession();

  // Step 1 until a wallet is there, step 2 until it has proved itself.
  const current = isConnected ? 1 : 0;

  return (
    <main className="flex min-h-dvh w-full bg-background p-2 lg:h-dvh lg:overflow-hidden lg:p-4">
      <section className="relative hidden shrink-0 flex-col items-center justify-end overflow-hidden rounded-3xl bg-gradient-to-br from-secondary via-muted to-background px-12 pb-32 shadow-2xl lg:flex lg:w-[52%]">
        <div className="fade-in relative z-10 w-full max-w-80 animate-in space-y-8 duration-500">
          <div className="flex items-center gap-2">
            <Image alt="" height={22} src="/brand/mark.webp" width={22} />
            <span className="font-semibold text-xl tracking-tight">helico</span>
          </div>

          <div>
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
                  "flex items-center gap-3 rounded-xl px-4 py-3.5 font-medium text-sm",
                  i === current
                    ? "border border-foreground bg-foreground text-background"
                    : "bg-muted/60 text-foreground",
                )}
                key={label}
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

      <section className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-12 sm:px-12 lg:px-16 xl:px-24">
        <div className="fade-in w-full max-w-lg animate-in space-y-8 duration-700">
          <div>
            <h2 className="font-medium text-3xl tracking-tight">
              {isConnected ? "One signature to finish" : "Connect a wallet"}
            </h2>
            <p className="mt-2 text-muted-foreground text-sm">
              {isConnected
                ? "It costs no gas and proves the address is yours. Your conversations stay with that wallet and nobody else's."
                : "Helico quotes against what you actually hold, so it needs to know which wallet is asking."}
            </p>
          </div>

          {isConnected ? (
            <Button
              className="h-14 w-full rounded-xl text-[15px] font-semibold"
              disabled={session.signing}
              onClick={session.signIn}
            >
              {session.signing ? "Check your wallet…" : "Verify wallet"}
            </Button>
          ) : (
            <Button
              className="h-14 w-full rounded-xl text-[15px] font-semibold"
              onClick={() => open()}
            >
              Connect wallet
            </Button>
          )}

          {session.error ? (
            <p className="text-destructive text-sm">{session.error}</p>
          ) : null}

          <p className="text-center text-muted-foreground text-sm">
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
