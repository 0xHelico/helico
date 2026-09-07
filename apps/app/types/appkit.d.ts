import type { HTMLAttributes } from "react";

// Reown AppKit renders its button as a custom element rather than a React component.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "appkit-button": HTMLAttributes<HTMLElement> & {
        balance?: "show" | "hide";
        size?: "md" | "sm";
        label?: string;
      };
    }
  }
}
