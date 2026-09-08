/**
 * The mark of whoever would answer, rather than a star that says nothing.
 *
 * The files are models.dev's, and every one of them is drawn in `currentColor` — but an SVG
 * loaded through `<img>` is its own document and inherits nothing, so it would render black on a
 * black composer. Masking is what keeps the promise the file makes: the element is painted in the
 * current text colour and the SVG decides only its shape, so the logo follows the theme the way
 * the rest of the row does.
 *
 * A provider with no file here gets no logo and, deliberately, no row — an invented mark would be
 * worse than none. `KNOWN_MODELS` and this map change together.
 */
const FILES: Record<string, string> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Google: "google",
  DeepSeek: "deepseek",
  xAI: "xai",
  Alibaba: "alibaba",
  Meta: "meta",
  Mistral: "mistral",
};

export function ProviderLogo({
  provider,
  size = 14,
}: {
  provider: string;
  size?: number;
}) {
  const file = FILES[provider];
  if (!file) {
    return null;
  }
  const mask = `url(/providers/${file}.svg) center / contain no-repeat`;
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 bg-current"
      style={{ height: size, mask, WebkitMask: mask, width: size }}
    />
  );
}
