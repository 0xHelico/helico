/**
 * A lending market's mark, drawn inline.
 *
 * Same reasoning as `token-mark.tsx`: no network request, nothing to pop in after the page, and
 * nothing to break when a CDN moves its files. Each one is the shape people recognise the protocol
 * by, in that protocol's own colour, at a size where more detail would be lost anyway.
 *
 * The list of markets was four rows of text a reader had to parse before they could tell one from
 * another. A mark in the protocol's colour sorts the column by eye before it is read, which is the
 * whole job here.
 */

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
      aria-label={label}
      height={size}
      role="img"
      viewBox="0 0 32 32"
      width={size}
    >
      <title>{label}</title>
      {children}
    </svg>
  );
}

/** Aave. The blue disc and the two wings of its 2024 mark. */
function Aave({ size }: { size: number }) {
  return (
    <Mark label="Aave" size={size}>
      <circle cx={16} cy={16} fill="#2F6BF6" r={16} />
      {/* Two thick wings sweeping from the shoulders down to the centre. The mark's pale lower
          halves are dropped on purpose: at 22px they read as a separate object sitting between
          the wings rather than as part of them, which is worse than not drawing them. */}
      <path
        d="M9.6 7.4c1.9-.8 4 .2 4.6 2.1L16 15.6v9.8L8 12.6c-1-1.7-.3-4 1.6-5.2Z"
        fill="#fff"
      />
      <path
        d="M22.4 7.4c-1.9-.8-4 .2-4.6 2.1L16 15.6v9.8L24 12.6c1-1.7.3-4-1.6-5.2Z"
        fill="#fff"
      />
    </Mark>
  );
}

/** Compound. The three leaning cards, green on near-black. */
function Compound({ size }: { size: number }) {
  return (
    <Mark label="Compound" size={size}>
      <circle cx={16} cy={16} fill="#070A0E" r={16} />
      {/* Three cards, parallel, each shorter than the one above and to its right. One `skewX`
          over the group keeps them parallel by construction; rotating each about its own centre
          slid them onto the same diagonal and merged the three into one blob. */}
      <g fill="#00D395" transform="translate(5.5 0) skewX(-20)">
        <rect height="15" rx="2.2" width="5" x="19" y="5" />
        <rect height="13" rx="2.2" width="5" x="13.5" y="9" />
        <rect height="11" rx="2.2" width="5" x="8" y="13" />
      </g>
    </Mark>
  );
}

/** Morpho. The horseshoe and its two eyes, on the lavender disc. */
function Morpho({ size }: { size: number }) {
  return (
    <Mark label="Morpho" size={size}>
      <circle cx={16} cy={16} fill="#8B87F5" r={16} />
      <path
        d="M5.8 22.4a10.2 10.2 0 1 1 20.4 0h-4a6.2 6.2 0 0 0-12.4 0Z"
        fill="#fff"
      />
      {/* Low, and clear of the horseshoe. Higher up they merged into its inner edge and the mark
          came out as a notched crown. */}
      <circle cx={12.8} cy={20.6} fill="#fff" r={1.7} />
      <circle cx={19.2} cy={20.6} fill="#fff" r={1.7} />
    </Mark>
  );
}

/** A market nothing here has a mark for. A disc with the protocol's first letter. */
function Unknown({ size, label }: { size: number; label: string }) {
  return (
    <Mark label={label} size={size}>
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
    </Mark>
  );
}

/**
 * Matched on the label the market list already carries, so nothing has to be renamed.
 *
 * `startsWith` rather than equality: the labels are "Aave v3", "Compound v3", "Morpho", and a
 * version bump should change a number rather than lose the logo.
 */
export function VenueMark({
  label,
  size = 22,
}: {
  label: string;
  size?: number;
}) {
  if (label.startsWith("Aave")) return <Aave size={size} />;
  if (label.startsWith("Compound")) return <Compound size={size} />;
  if (label.startsWith("Morpho")) return <Morpho size={size} />;
  return <Unknown label={label} size={size} />;
}
