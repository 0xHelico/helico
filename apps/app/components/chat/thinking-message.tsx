import { Shimmer } from "@/components/ai-elements/shimmer";
import { SparklesIcon } from "./icons";

/**
 * The template's waiting state, kept as it wrote it: the mark in a rounded square, and a line
 * that shimmers until the answer replaces it.
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
      <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
          <SparklesIcon size={13} />
        </div>
      </div>
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
