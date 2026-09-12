import Image from "next/image";

/**
 * A lending market's mark, from the protocol's own file.
 *
 * **These were drawn by hand until 12 September, and hand-drawn was the wrong call.** The reasoning
 * for inline SVG was real enough: no request, nothing to pop in after the page, nothing to break
 * when a CDN moves a file. What it cost was accuracy, and a logo is the one thing on a page where
 * being close is worse than being absent. Aave shipped as a solid hump that swallowed its own eyes.
 * Morpho took three attempts and read as a V, then a heart, then an arrowhead, none of them a
 * butterfly. Each version was checked by rendering it, which is how I know.
 *
 * The files are served from `public/`, so there is still no CDN in the path and still nothing
 * third-party to break. They are 200px squares for a mark that renders at 14 to 22, which leaves
 * room for a retina screen without shipping a thousand pixels nobody sees: Compound's original was
 * 1053px and was resized rather than sent as it came.
 *
 * The list of markets was four rows of text a reader had to parse before they could tell one from
 * another. A mark in the protocol's own colour sorts the column by eye before it is read, which is
 * the whole job here.
 */

/** Matched on the label the market list already carries, so nothing has to be renamed. */
const FILES: { prefix: string; file: string; name: string }[] = [
  { prefix: "Aave", file: "aave.png", name: "Aave" },
  { prefix: "Compound", file: "compound.png", name: "Compound" },
  { prefix: "Morpho", file: "morpho.png", name: "Morpho" },
];

/** A market nothing here has a file for. A disc with the protocol's first letter. */
function Unknown({ label, size }: { label: string; size: number }) {
  return (
    <svg
      aria-label={label}
      height={size}
      role="img"
      viewBox="0 0 32 32"
      width={size}
    >
      <title>{label}</title>
      <circle cx={16} cy={16} fill="#e9e9e7" r={16} />
      <text
        dominantBaseline="central"
        fill="#6b6b68"
        fontFamily="system-ui, sans-serif"
        fontSize={14}
        fontWeight={600}
        textAnchor="middle"
        x={16}
        y={17}
      >
        {label.slice(0, 1).toUpperCase()}
      </text>
    </svg>
  );
}

/**
 * `startsWith` rather than equality: the labels are "Aave v3", "Compound v3", "Morpho", and
 * "Compound v3 (USDC)" where two markets share a name. A version bump should change a number
 * rather than lose the logo.
 */
export function VenueMark({
  label,
  size = 22,
}: {
  label: string;
  size?: number;
}) {
  const match = FILES.find((f) => label.startsWith(f.prefix));
  if (!match) return <Unknown label={label} size={size} />;
  return (
    // `next/image` because that is what the rest of this app uses and what the lint rule asks for.
    // `alt` carries the protocol rather than the label: "Compound v3 (USDC)" read aloud in the
    // middle of a row of amounts is noise, and the row already says which market it is.
    <Image
      alt={match.name}
      className="shrink-0 rounded-full"
      height={size}
      src={`/venues/${match.file}`}
      width={size}
    />
  );
}
