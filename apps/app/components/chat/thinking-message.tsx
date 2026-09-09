import { Shimmer } from "@/components/ai-elements/shimmer";
import { AssistantMark } from "./assistant-mark";

/**
 * The template's waiting state: Helico's mark, and a line that shimmers until the answer
 * replaces it. The mark is shared with `turn.tsx`, so the face does not change when the answer
 * arrives.
 */
export const ThinkingMessage = ({
  label = "Waiting...",
}: {
  label?: string;
}) => (
  <div
    className="group/message w-full"
    data-role="assistant"
    data-testid="message-assistant-loading"
  >
    <div className="flex items-start gap-3">
      <AssistantMark />
      <div className="flex min-h-[calc(13px*1.65)] min-w-0 items-center text-[13px] leading-[1.65]">
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
