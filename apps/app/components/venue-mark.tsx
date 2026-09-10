/**
 * A lending market's mark, drawn inline.
 *
 * Same reasoning as `token-mark.tsx`: no network request, nothing to pop in after the page, and
 * nothing to break when a CDN moves its files. Each one is the shape people recognise the protocol
 * by, in that protocol's own colour, at a size where more detail would be lost anyway.
 *
 * **Aave is the violet one and Morpho is the blue one.** They shipped the other way round for a
 * day. Aave's mark is the ghost — a rounded top and two eyes — and Morpho's is a butterfly, which
 * is what the genus name means.
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

/** Aave. The ghost: a lavender disc, a white arch, and its two eyes. */
function Aave({ size }: { size: number }) {
  return (
    <Mark label="Aave" size={size}>
      <circle cx={16} cy={16} fill="#9896F0" r={16} />
      {/* The ghost, simplified to the two things it is recognised by: a rounded top and two eyes.
          These were on Morpho for a day, which is the wrong way round — Aave's mark is the pale
          violet one. */}
      <path
        d="M5.8 22.4a10.2 10.2 0 1 1 20.4 0h-4a6.2 6.2 0 0 0-12.4 0Z"
        fill="#fff"
      />
      <circle cx={12.8} cy={20.6} fill="#fff" r={1.9} />
      <circle cx={19.2} cy={20.6} fill="#fff" r={1.9} />
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
        <rect height="15" rx="2.6" width="6" x="18.6" y="5" />
        <rect height="12.5" rx="2.6" width="6" x="12.3" y="9" />
        <rect height="10" rx="2.6" width="6" x="6" y="13" />
      </g>
    </Mark>
  );
}

/** Morpho. A blue butterfly, which is what the name means. */
function Morpho({ size }: { size: number }) {
  return (
    <Mark label="Morpho" size={size}>
      <circle cx={16} cy={16} fill="#2F6BF6" r={16} />
      {/* Two wings sweeping from the shoulders down to the centre. `Morpho` is a genus of blue
          butterflies, which is the whole of the mark and the reason it is not the violet one. */}
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
