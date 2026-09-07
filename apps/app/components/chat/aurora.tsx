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

/** The reference's centre column, sampled at 1/88ths and kept as measured. */
const RAMP: [number, string][] = [
  [0.0, "#bf99e0"],
  [0.05, "#a677d9"],
  [0.09, "#8a55cb"],
  [0.14, "#6e3aba"],
  [0.18, "#582ca5"],
  [0.23, "#44238b"],
  [0.27, "#331b6f"],
  [0.32, "#241452"],
  [0.36, "#19103a"],
  [0.41, "#110a29"],
  [0.45, "#0b091c"],
  [0.5, "#090714"],
  [0.55, "#07050c"],
  [0.64, "#040407"],
  [0.77, "#050508"],
  [0.86, "#08050e"],
  [1.0, "#10091a"],
];

const SCALE = 3;
/** How much further down the ramp sits at the very edge, as a fraction of the height. */
const ARC = 0.085;
/** Columns the ramp is drawn in. Enough that the arc reads as a curve, few enough to be free. */
const COLUMNS = 48;

export function Aurora({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

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
        image.data[i + 3] = 15;
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
      ctx.fillStyle = RAMP[RAMP.length - 1][1];
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
        for (const [stop, colour] of RAMP) {
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
