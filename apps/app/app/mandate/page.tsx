import { redirect } from "next/navigation";

/**
 * The mandate used to live on its own page while the conversation held the front door. They have
 * swapped, and this stays so that links already written — the greeting's, the sidebar's, and
 * anything a judge or a reviewer has bookmarked — still land somewhere true.
 */
export default function MandatePage() {
  redirect("/");
}
