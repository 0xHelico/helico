"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAccount, useSignTypedData } from "wagmi";
import { api, ApiError } from "@/lib/api";

type State = "unknown" | "signed-out" | "signing" | "signed-in";

type Session = {
  address?: `0x${string}`;
  isConnected: boolean;
  /** Signed in, and as the wallet that is connected right now. */
  ready: boolean;
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

  // What the cookie already says, which is the common case on a reload.
  useEffect(() => {
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
          setState("signed-out");
        }
      });
    return () => {
      live = false;
    };
  }, []);

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
