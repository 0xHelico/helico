import { cn } from "@/lib/utils";

/**
 * Deterministic, name-coloured fallback avatar — a soft cluster of circles
 * instead of bare initials. The same name always renders the same avatar, and
 * the hue is derived from the name so different users get different colors.
 * Pure inline SVG, no dependency.
 */

function hash(str: string): number {
  let h = 0;

  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0; // keep it a 32-bit int
  }

  return Math.abs(h);
}

export function GeneratedAvatar({
  name,
  size = 40,
  className,
}: {
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const seed = hash((name || "?").toLowerCase());
  const hue = seed % 360;

  // A handful of overlapping circles clustered near the centre; positions,
  // sizes and lightness are all derived from the same seed (stable per name).
  const circles = Array.from({ length: 5 }, (_, i) => {
    const s = seed >> (i * 4);
    const angle = ((s % 360) * Math.PI) / 180;
    const dist = 10 + (s % 12);

    return {
      cx: 50 + Math.cos(angle) * dist,
      cy: 50 + Math.sin(angle) * dist,
      r: 20 + ((s >> 5) % 10),
      light: 28 + ((s >> 3) % 42),
    };
  });

  return (
    <svg
      aria-label={name || "avatar"}
      className={cn("shrink-0 rounded-full", className)}
      height={size}
      role="img"
      viewBox="0 0 100 100"
      width={size}
    >
      <title>{name || "avatar"}</title>
      <rect fill={`hsl(${hue} 60% 90%)`} height="100" width="100" />
      {circles.map((c) => (
        <circle
          cx={c.cx}
          cy={c.cy}
          fill={`hsl(${hue} 55% ${c.light}%)`}
          key={`${c.cx}-${c.cy}-${c.r}`}
          opacity={0.85}
          r={c.r}
        />
      ))}
    </svg>
  );
}
