/**
 * A token's mark, drawn inline.
 *
 * Simplified renditions rather than fetched logo files: no network request, nothing to pop in
 * after the page, and nothing to break when a CDN moves. Each one is the shape people recognise
 * the token by — the ETH diamond, Tether's ₮, USDC's ring — at a size where detail beyond that
 * would be lost anyway.
 *
 * The wrapping colour is the token's own, so a column of these sorts by eye before it is read.
 */

const RING = { cx: 16, cy: 16, r: 16 } as const;

function Circle({ fill }: { fill: string }) {
  return <circle {...RING} fill={fill} />;
}

function Mark({
  size,
  label,
  children,
}: {
  size: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <svg
      height={size}
      role="img"
      viewBox="0 0 32 32"
      width={size}
      aria-label={label}
    >
      <title>{label}</title>
      {children}
    </svg>
  );
}

const TEXT = {
  fill: "#fff",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontWeight: 700,
  textAnchor: "middle" as const,
};

/**
 * The blue disc, the gradient ring around it, and the dollar between two arcs.
 *
 * The ring is the part that identifies it at this size — the disc and the `$` alone are a dozen
 * dollar-stablecoins. SVG has no conic gradient, so the sweep is a linear one laid across the
 * same diagonal, which is indistinguishable at 24 pixels and is one element rather than twelve.
 *
 * The gradient id is fixed, not generated. Every instance draws the same three stops, so the
 * first definition in the document is the right one for all of them, and a per-instance id would
 * put a unique `<defs>` in the page for each row of a table.
 */
function Usdc({ size }: { size: number }) {
  return (
    <Mark label="USDC" size={size}>
      <defs>
        <linearGradient id="usdc-ring" x1="0.15" x2="0.5" y1="0" y2="1">
          <stop offset="0%" stopColor="#7b4bd0" />
          <stop offset="45%" stopColor="#c8459d" />
          <stop offset="100%" stopColor="#2ec4c4" />
        </linearGradient>
      </defs>
      <Circle fill="url(#usdc-ring)" />
      <circle cx="16" cy="16" fill="#fff" r="14.4" />
      <circle cx="16" cy="16" fill="#2775ca" r="13.2" />
      <path
        d="M12.9 23.9a8.4 8.4 0 0 1 0-15.8M19.1 8.1a8.4 8.4 0 0 1 0 15.8"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="1.7"
      />
      <text {...TEXT} fontSize="12.5" x="16" y="20.4">
        $
      </text>
    </Mark>
  );
}

/** Tether's bar-and-stem. */
function Usdt({ size }: { size: number }) {
  return (
    <Mark label="USDT" size={size}>
      <Circle fill="#26a17b" />
      <path
        d="M9 10h14v3.2h-5.2v2.1c3.6.2 6.3 1 6.3 2s-2.7 1.8-6.3 2v5.3h-3.6v-5.3c-3.6-.2-6.3-1-6.3-2s2.7-1.8 6.3-2v-2.1H9z"
        fill="#fff"
      />
    </Mark>
  );
}

/** The MakerDAO diamond, flattened to two chevrons. */
function Dai({ size }: { size: number }) {
  return (
    <Mark label="DAI" size={size}>
      <Circle fill="#f5ac37" />
      <path
        d="M11 9h5.6c3.7 0 6.4 2.1 7.3 5.2H26v2h-1.8v1.6H26v2h-1.9c-.9 3.1-3.6 5.2-7.3 5.2H11v-5.2H8v-2h3v-1.6H8v-2h3z"
        fill="#fff"
        opacity="0.95"
      />
      <path
        d="M14 12h2.4c2.2 0 3.8 1.6 3.8 4s-1.6 4-3.8 4H14z"
        fill="#f5ac37"
      />
    </Mark>
  );
}

/** Ether's octahedron. */
function Weth({ size }: { size: number }) {
  return (
    <Mark label="WETH" size={size}>
      <Circle fill="#627eea" />
      <path d="M16 5.5v8.2l6.9 3.1z" fill="#fff" opacity="0.7" />
      <path d="M16 5.5 9.1 16.8l6.9-3.1z" fill="#fff" />
      <path d="M16 22.2v4.3l6.9-9.6z" fill="#fff" opacity="0.7" />
      <path d="M16 26.5v-4.3l-6.9-5.3z" fill="#fff" />
      <path d="m16 20.9 6.9-4.1-6.9-3.1z" fill="#fff" opacity="0.4" />
      <path d="m9.1 16.8 6.9 4.1v-7.2z" fill="#fff" opacity="0.6" />
    </Mark>
  );
}

/** Arbitrum's nested chevrons. */
function Arb({ size }: { size: number }) {
  return (
    <Mark label="ARB" size={size}>
      <Circle fill="#213147" />
      <path d="m16 7 7.4 12.8-2.6 1.5L16 12.4l-4.8 8.9-2.6-1.5z" fill="#fff" />
      <path d="m16 17.4 3.6 6.3-3.6 2-3.6-2z" fill="#12aaff" />
    </Mark>
  );
}

/** Aave's receipt, in Aave's colour with the underlying's letter. */
function AToken({ size, under }: { size: number; under: string }) {
  return (
    <Mark label={`a${under}`} size={size}>
      <circle {...RING} fill="#b6509e" />
      <circle
        cx="16"
        cy="16"
        fill="none"
        r="11"
        stroke="#fff"
        strokeWidth="1.6"
        opacity="0.55"
      />
      <text {...TEXT} fontSize="12" x="16" y="20.4">
        {under[0]}
      </text>
    </Mark>
  );
}

/** Anything this file cannot name: a shape rather than a wrong letter. */
function Unknown({ size }: { size: number }) {
  return (
    <Mark label="Unknown token" size={size}>
      <Circle fill="#c8ccd0" />
      <circle cx="16" cy="16" fill="none" r="6" stroke="#fff" strokeWidth="2" />
    </Mark>
  );
}

export function TokenMark({
  symbol,
  size = 26,
}: {
  symbol: string;
  size?: number;
}) {
  switch (symbol) {
    case "USDC":
      return <Usdc size={size} />;
    case "USDT":
      return <Usdt size={size} />;
    case "DAI":
      return <Dai size={size} />;
    case "WETH":
    case "ETH":
      return <Weth size={size} />;
    case "ARB":
      return <Arb size={size} />;
    case "aUSDC":
      return <AToken size={size} under="USDC" />;
    default:
      return <Unknown size={size} />;
  }
}
