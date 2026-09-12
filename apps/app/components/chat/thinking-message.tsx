"use client";

import { ThinkingOrb } from "thinking-orbs";

import { Shimmer } from "@/components/ai-elements/shimmer";
import { AssistantMark } from "./assistant-mark";

/**
 * The nine states `thinking-orbs` ships, in the order they are shown.
 *
 * Every one of them is a different animation rather than the same orb recoloured, so cycling is
 * what stops a wait looking like the wait before it. The order is the package's own; there is
 * nothing to be gained from rearranging it.
 */
export const ORB_STATES = [
  "working",
  "searching",
  "solving",
  "listening",
  "connecting",
  "weaving",
  "composing",
  "breathing",
  "shaping",
] as const;

/**
 * Which orb a wait gets, from how many turns are already on screen.
 *
 * **Derived rather than random, and derived from something that changes.** Random would repeat
 * itself often enough to notice, and a counter kept inside the component would be a side effect on
 * render that React's double-invoke in development advances twice. A turn count is already there
 * and already correct.
 *
 * It also happens to visit all nine before repeating. A wait begins once the person's own message
 * is on screen, so the count is odd every time — 1, 3, 5, 7 — and stepping by two through nine
 * lands on every state before coming back, because two and nine share no factor.
 */
export const orbStateFor = (turns: number) =>
  ORB_STATES[
    ((turns % ORB_STATES.length) + ORB_STATES.length) % ORB_STATES.length
  ] ?? ORB_STATES[0];

/**
 * The waiting state: Helico's mark, an orb that is actually moving, and a line that shimmers
 * until the answer replaces it.
 *
 * **The mark stays.** It is shared with `turn.tsx` so that the face does not change when the
 * answer arrives — a mark that differs between waiting and answered is two assistants, and
 * nothing in either file would have said so. The orb is the activity, not the identity, which is
 * why it goes where the spinner was rather than where the face is. That is also why it is the
 * 20px preset: the package tunes 64 for an avatar and 20 for inline text, and this is inline text.
 *
 * **The label does not change with the orb.** The animations have names — searching, solving,
 * connecting — and writing those beside the orb would tell somebody the backend was doing a thing
 * it may well not be doing. What is true of every wait is that a sentence has been sent and
 * nothing has come back, so that is what it says. The orb varies because a wait should not look
 * identical every time; the words do not, because they are a claim.
 */
export const ThinkingMessage = ({
  label = "Waiting...",
  /** How many turns are on screen. Picks the orb, so consecutive waits do not look alike. */
  nth = 0,
}: {
  label?: string;
  nth?: number;
}) => (
  <div
    className="group/message w-full"
    data-role="assistant"
    data-testid="message-assistant-loading"
  >
    <div className="flex items-start gap-3">
      <AssistantMark />
      <div className="flex min-h-[calc(13px*1.65)] min-w-0 items-center gap-2 text-[13px] leading-[1.65]">
        {/* `theme="auto"` reads a `data-theme` attribute or a `dark` class off an ancestor and
            follows the OS otherwise, which is the arrangement this app already uses. */}
        <ThinkingOrb
          aria-hidden
          data-testid="thinking-orb"
          data-orb-state={orbStateFor(nth)}
          size={20}
          state={orbStateFor(nth)}
        />
        <Shimmer
          as="span"
          className="whitespace-normal break-words font-medium"
          duration={1}
        >
          {label}
        </Shimmer>
      </div>
    </div>
  </div>
);
