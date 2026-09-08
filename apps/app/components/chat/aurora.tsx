"use client";

import { useEffect, useRef } from "react";

/**
 * The gate's left panel: the reference's gradient, measured rather than guessed.
 *
 * A frame of the reference video was sampled to get both halves of this. The colour ramp below
 * is its centre column, top to bottom. The curve is the part that is easy to get backwards — I
 * built a centred bloom first, and the measurements say the opposite: the reference is
 * *brighter at the left and right edges*, and the violet reaches lower there. At a fifth of the
 * way down the edges are ~1.7x the centre's brightness, and each column crosses half its own
 * peak at y=0.22 at the edges against y=0.14 in the middle.
 *
 * So it is one vertical ramp, drawn column by column, pushed further down the nearer the column
 * is to an edge. That single offset produces the arc and the edge brightening together.
 *
 * Drawn at a third of the panel and scaled up, since the whole thing is a blur. The grain is
 * load bearing: a wash this smooth bands badly on 8-bit displays, and the reference has grain
 * for the same reason.
 */

/**
 * The same gradation the other way up: the lavender band still arcs down the edges, but it
 * falls to white instead of black. Not derived from the dark ramp by mixing — its lower half is
 * near-black with no chroma left, so mixing toward white gives grey. These keep the hue and
 * raise the lightness, which is what the light counterpart of "light from above" looks like.
 */
const LIGHT: [number, string][] = [
  [0.0, "#cbb4ec"],
  [0.05, "#bda4e6"],
  [0.09, "#ad91df"],
  [0.14, "#9d7ed7"],
  [0.18, "#a68ddd"],
  [0.23, "#b39ce4"],
  [0.27, "#c0aeea"],
  [0.32, "#cdbfef"],
  [0.36, "#d9cff4"],
  [0.41, "#e3dcf7"],
  [0.45, "#ebe6fa"],
  [0.5, "#f1eefc"],
  [0.55, "#f5f3fd"],
  [0.64, "#f8f7fe"],
  [0.77, "#faf9fe"],
  [0.86, "#fbfaff"],
  [1.0, "#f8f6ff"],
];

const SCALE = 3;
/** How much further down the ramp sits at the very edge, as a fraction of the height. */
const ARC = 0.085;
/** Columns the ramp is drawn in. Enough that the arc reads as a curve, few enough to be free. */
const COLUMNS = 48;

export function Aurora({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // Light only. This read the theme and picked a ramp; there is one ramp now.

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!(canvas && parent)) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const ramp = LIGHT;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;

    const grain = document.createElement("canvas");
    grain.width = 128;
    grain.height = 128;
    const gctx = grain.getContext("2d");
    if (gctx) {
      const image = gctx.createImageData(grain.width, grain.height);
      for (let i = 0; i < image.data.length; i += 4) {
        const v = 110 + Math.random() * 90;
        image.data[i] = v;
        image.data[i + 1] = v;
        image.data[i + 2] = v;
        image.data[i + 3] = 9;
      }
      gctx.putImageData(image, 0, 0);
    }

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width / SCALE));
      height = Math.max(1, Math.round(rect.height / SCALE));
      canvas.width = width;
      canvas.height = height;
    };

    const draw = (t: number) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = ramp[ramp.length - 1][1];
      ctx.fillRect(0, 0, width, height);

      // Breathing, slowly and out of phase, so the loop never visibly repeats. A still frame
      // would be a picture; the reference moves.
      const lift = Math.sin(t * 0.000_055) * 0.02;
      const sway = Math.sin(t * 0.000_037) * 0.06;
      const step = width / COLUMNS;

      for (let i = 0; i < COLUMNS; i++) {
        const x = i * step;
        const centre = (i + 0.5) / COLUMNS;
        // Distance from the middle, biased by the sway so the arc leans as it breathes.
        const d = Math.min(1, Math.abs(centre - (0.5 + sway)) * 2);
        const offset = (ARC * d * d + lift) * height;

        const g = ctx.createLinearGradient(0, offset, 0, offset + height);
        for (const [stop, colour] of ramp) {
          g.addColorStop(stop, colour);
        }
        ctx.fillStyle = g;
        // A hair of overlap, so the seams between columns never show.
        ctx.fillRect(x, 0, step + 1, height);
      }

      const pattern = ctx.createPattern(grain, "repeat");
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, width, height);
      }
    };

    resize();

    let frame = 0;
    if (still) {
      draw(0);
    } else {
      const loop = (t: number) => {
        draw(t);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
    }

    const observer = new ResizeObserver(() => {
      resize();
      if (still) {
        draw(0);
      }
    });
    observer.observe(parent);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      aria-hidden
      className={className}
      ref={ref}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}
