import Image from "next/image";

/**
 * Helico's mark, where the chat template put a sparkle.
 *
 * The identical block sat in `turn.tsx` and in `thinking-message.tsx`, which is two places for
 * one face: a mark that differs between waiting and answered is two assistants, and nothing in
 * either file would have said so.
 *
 * No plate and no ring behind it. The asset is a solid lavender tile with its own rounded
 * corners, so a background and a border would draw a second edge just outside the first. The
 * sidebar and the connect gate carry the dark mark; this is the same product in the colour it
 * uses when it is speaking.
 */
export function AssistantMark() {
  return (
    <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
      <Image
        alt=""
        className="size-7 rounded-lg"
        height={28}
        src="/brand/mark-lavender.webp"
        width={28}
      />
    </div>
  );
}
