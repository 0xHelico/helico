import { Chat } from "@/components/chat/chat";

/**
 * **Never indexed.** A conversation URL is one person's transcript: thin for a crawler, near
 * duplicate of every other one, and not ours to publish. `robots.ts` disallows the whole prefix as
 * well, so this is the second of two locks rather than the only one.
 */
export const metadata = {
  title: "Conversation",
  robots: { index: false, follow: false, nocache: true },
};

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Chat conversationId={id} />;
}
