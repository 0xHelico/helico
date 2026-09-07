"use client";

import { useEffect, useRef } from "react";

/**
 * The gate's left panel: a lavender bloom across the top that falls away to black.
 *
 * Modelled on the reference video rather than shipping it — that file is somebody else's and it
 * is 13 MB. The shape matters more than the technique: one wide, soft band anchored to the top
 * edge, drifting slowly, over a hard fall to true black by the middle of the panel. Scattered
 * radial blobs read as fog; this reads as light coming from above, which is what the reference
 * does.
 *
 * The panel stays dark in both themes because it is artwork, not chrome — which is also why the
 * text over it is light in both.
 *
 * Drawn at a third size and scaled up; the effect is a blur either way. The grain is load
 * bearing: a wash this smooth bands badly on 8-bit displays, and noise is what hides it.
 */

/** From the landing's tokens: --lav #978eff and --lav-btn #695cff. */
const LAV = "151,142,255";
const DEEP = "105,92,255";

const SCALE = 3;

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
        image.data[i + 3] = 14;
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

    /** A wide ellipse of light, drawn by squashing a radial gradient. */
    const band = (
      cx: number,
      cy: number,
      rx: number,
      ry: number,
      colour: string,
      alpha: number,
    ) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, `rgba(${colour},${alpha})`);
      g.addColorStop(0.5, `rgba(${colour},${alpha * 0.45})`);
      g.addColorStop(1, `rgba(${colour},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      ctx.restore();
    };

    const draw = (t: number) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      ctx.globalCompositeOperation = "lighter";
      // The main band: wider than the panel, sitting just above the top edge so only its lower
      // half shows. It slides a little and breathes, slowly and out of phase.
      const slide = Math.sin(t * 0.000_06) * width * 0.12;
      const breathe = 1 + Math.sin(t * 0.000_09) * 0.06;
      band(
        width * 0.5 + slide,
        -height * 0.34,
        width * 1.45 * breathe,
        height * 0.95 * breathe,
        LAV,
        0.95,
      );
      // A second, deeper one offset the other way, for the colour shift across the top.
      band(
        width * 0.5 - slide * 1.4,
        -height * 0.06,
        width * 1.0,
        height * 0.5,
        DEEP,
        0.45,
      );

      // The fall to black. The reference is essentially pure black below the middle, and that
      // contrast is most of what makes the top read as light rather than as a purple wash.
      ctx.globalCompositeOperation = "source-over";
      const fade = ctx.createLinearGradient(0, 0, 0, height);
      fade.addColorStop(0, "rgba(0,0,0,0)");
      fade.addColorStop(0.3, "rgba(0,0,0,0.15)");
      fade.addColorStop(0.55, "rgba(0,0,0,0.82)");
      fade.addColorStop(0.75, "rgba(0,0,0,0.98)");
      fade.addColorStop(1, "rgb(0,0,0)");
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, width, height);

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
