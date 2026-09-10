"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAccount, useSignTypedData } from "wagmi";
import { api, ApiError } from "@/lib/api";

type State = "unknown" | "signed-out" | "signing" | "signed-in";

type Session = {
  address?: `0x${string}`;
  isConnected: boolean;
  /** False only while the cookie is still being read, so a reload does not flash the gate. */
  knows: boolean;
  /** Signed in, and as the wallet that is connected right now. */
  ready: boolean;
  /** The address the cookie belongs to, which is not always the one now connected. */
  signedInAs: string | null;
  signing: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
};

// One session for the whole app. It was per-component once, and signing in from the sidebar
// left the chat still believing it was signed out — the conversation was never saved.
const SessionContext = createContext<Session | null>(null);

export function HelicoSessionProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [state, setState] = useState<State>("unknown");
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which address the cookie has already been read for, so it is read once per wallet.
  const asked = useRef<string | null>(null);

  // Only worth asking once a wallet is connected. Without one the answer changes nothing —
  // `ready` needs the cookie to match the connected address — so asking would be a 401 on every
  // cold load for information the page cannot use.
  useEffect(() => {
    if (!address) {
      asked.current = null;
      setSignedInAs(null);
      // Nothing to find out, rather than not yet found out: the gate can render immediately.
      setState("signed-out");
      return;
    }
    if (asked.current === address) {
      return;
    }
    asked.current = address;
    setState("unknown");
    let live = true;
    api
      .whoami()
      .then(({ address: who }) => {
        if (live) {
          setSignedInAs(who.toLowerCase());
          setState("signed-in");
        }
      })
      .catch(() => {
        if (live) {
          setSignedInAs(null);
          setState("signed-out");
        }
      });
    return () => {
      live = false;
      // Cleared with the request it guards, and that is the whole fix. React mounts every effect
      // twice in dev, so the first run sets the ref, fires `whoami`, and is then cleaned up —
      // discarding its answer. Leave the ref set and the second run returns early, nothing ever
      // asks again, and `state` stays "unknown" for the life of the page; `AppShell` waits 700ms
      // and then shows the gate, so a signed-in wallet lands back on "Verify wallet" after every
      // refresh. Production never double-mounts, which is why only dev saw it.
      asked.current = null;
    };
  }, [address]);

  const signIn = useCallback(async () => {
    if (!address) {
      return;
    }
    setError(null);
    setState("signing");
    try {
      const { nonce, issuedAt, typedData } = await api.challenge(address);
      // The backend builds the payload, so what is signed is what it will verify.
      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      } as never);
      const { address: who } = await api.signIn({
        wallet: address,
        nonce,
        issuedAt,
        signature,
      });
      setSignedInAs(who.toLowerCase());
      setState("signed-in");
    } catch (e) {
      setState("signed-out");
      setError(
        e instanceof ApiError || e instanceof Error
          ? e.message.split("\n")[0]
          : "Could not sign in",
      );
    }
  }, [address, signTypedDataAsync]);

  const signOut = useCallback(async () => {
    await api.signOut().catch(() => undefined);
    setSignedInAs(null);
    setState("signed-out");
  }, []);

  const value = useMemo<Session>(
    () => ({
      address,
      isConnected,
      knows: state !== "unknown",
      signedInAs,
      // A cookie for a different wallet than the one now connected is worse than none: it
      // would show someone else's conversations.
      ready:
        state === "signed-in" &&
        signedInAs !== null &&
        address?.toLowerCase() === signedInAs,
      signing: state === "signing",
      error,
      signIn,
      signOut,
    }),
    [address, isConnected, state, signedInAs, error, signIn, signOut],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useHelicoSession(): Session {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useHelicoSession needs HelicoSessionProvider above it");
  }
  return value;
}
