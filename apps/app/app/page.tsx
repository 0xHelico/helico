import { Chat } from "@/components/chat/chat";

export const metadata = {
  // Absolute, because the template would otherwise make this "Helico · Helico".
  title: { absolute: "Helico | Your Funds, on Autopilot" },
  alternates: { canonical: "/" },
};

/**
 * The front door is the conversation.
 *
 * It was the limits page, which meant the first thing a stranger met was a form for permissions
 * they had no reason to grant yet — the product's one sentence ("say it and it happens") was two
 * clicks away behind a page about what may not happen. The limits still matter and still live at
 * `/limit`; they are the second question, not the first.
 */
export default function Page() {
  return <Chat />;
}
