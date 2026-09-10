import { redirect } from "next/navigation";

/** The chat moved to the front door. Kept so links and bookmarks that predate the move still land. */
export default function ChatPage() {
  redirect("/");
}
