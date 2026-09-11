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
      <circle cx={16} cy={16} fill="#8C8AF0" r={16} />
      {/* An arch rather than a dome: the ring is open at the bottom and its legs stop level with
          the eyes, which is the shape the brand mark actually has. Drawn as one path so the
          opening is part of the geometry instead of a second shape painted over it. */}
      <path
        d="M6.1 21.2A9.9 9.9 0 0 1 25.9 21.2L22.7 21.2A6.7 6.7 0 0 0 9.3 21.2Z"
        fill="#fff"
      />
      <circle cx={12.9} cy={18.5} fill="#fff" r={2.2} />
      <circle cx={19.1} cy={18.5} fill="#fff" r={2.2} />
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
      <g fill="#00D395" transform="translate(6 0) skewX(-21)">
        <rect height="15.5" rx="2.7" width="6.2" x="18.2" y="4.6" />
        <rect height="12.8" rx="2.7" width="6.2" x="11.8" y="8.9" />
        <rect height="10.1" rx="2.7" width="6.2" x="5.4" y="13.2" />
      </g>
    </Mark>
  );
}

/** Morpho. A blue butterfly, which is what the name means. */
function Morpho({ size }: { size: number }) {
  return (
    <Mark label="Morpho" size={size}>
      <circle cx={16} cy={16} fill="#2C6BF6" r={16} />
      {/* **Four lobes, and both notches.** Two white wings above, two paler ones below, all four
          radiating from the same centre — so there is a notch at the top *and* at the bottom.
          That is what makes it read as a butterfly.

          Three earlier attempts are the reason this is spelled out. Flat white with a single
          bottom point read as a **V**; rounding the tops turned it into a **heart**; sharpening
          them gave an arrowhead. Each was checked by rendering it at 150px and at the 22px it
          actually ships at, rather than by looking at the path. */}
      <g fill="#fff">
        <path d="M16 17.2 15.3 6.6C13.6 4.6 9.4 5 8 7.6 6.6 10.4 7.2 14.2 9.2 16.4Z" />
        <path d="M16 17.2 16.7 6.6C18.4 4.6 22.6 5 24 7.6 25.4 10.4 24.8 14.2 22.8 16.4Z" />
      </g>
      <g fill="#BFD3FC">
        <path d="M16 17.2 9.5 15.9C8.6 18.6 10 22 12.4 23.6 14 24.6 15.4 24 16 22.4Z" />
        <path d="M16 17.2 22.5 15.9C23.4 18.6 22 22 19.6 23.6 18 24.6 16.6 24 16 22.4Z" />
      </g>
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
