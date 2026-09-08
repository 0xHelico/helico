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
 * The blue disc, the dollar, and the two arcs around it.
 *
 * This is Circle's *native* USDC, which is the token this account holds — `0xaf88…5831`. The
 * variant with a purple-to-teal ring is bridged USDC.e, a different contract we do not show, and
 * drawing it here would put the wrong token's mark beside a real balance. That is the mistake
 * `token()` in lib/mandates.ts refuses everywhere else, and a picture makes it just as
 * confidently as a symbol does.
 */
function Usdc({ size }: { size: number }) {
  return <UsdcDisc label="USDC" size={size} />;
}

/** The disc on its own, so the Aave receipt can be drawn as this token wrapped. */
function UsdcDisc({ label, size }: { label: string; size: number }) {
  return (
    <Mark label={label} size={size}>
      <Circle fill="#2775ca" />
      <path
        d="M12.6 24.6a9.2 9.2 0 0 1 0-17.2M19.4 7.4a9.2 9.2 0 0 1 0 17.2"
        fill="none"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
      <text {...TEXT} fontSize="13" x="16" y="20.6">
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
/**
 * Aave's receipt: the underlying token's own mark, inside Aave's ring.
 *
 * The receipt is not a different asset — it is USDC at work — and a mark that shares nothing with
 * USDC's says otherwise. This is how Aave draws its own aTokens, and it is the difference that
 * matters here: same disc, so a reader sees one asset; a ring in Aave's colour, so they see which
 * of its two states they are looking at.
 */
function AUsdc({ size }: { size: number }) {
  return (
    <span
      aria-label="aUSDC"
      className="relative inline-flex items-center justify-center"
      role="img"
      style={{ height: size, width: size }}
    >
      <svg
        aria-hidden="true"
        className="absolute inset-0"
        height={size}
        viewBox="0 0 32 32"
        width={size}
      >
        <Circle fill="#b6509e" />
      </svg>
      <span className="relative">
        <UsdcDisc label="aUSDC" size={Math.round(size * 0.74)} />
      </span>
    </span>
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
      return <AUsdc size={size} />;
    default:
      return <Unknown size={size} />;
  }
}
