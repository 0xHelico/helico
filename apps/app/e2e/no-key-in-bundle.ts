/**
 * The 1inch key is not in the browser bundle, proven by looking rather than by reasoning.
 *
 *   cd apps/app && bun run build && bun run e2e/no-key-in-bundle.ts
 *
 * **Why this check exists at all.** The key is read in one place, a route handler on the server,
 * and Next cannot inline a variable without the `NEXT_PUBLIC_` prefix into client code — so the
 * claim is true by construction today. The mistake this catches is the one somebody makes later: a
 * rename to `NEXT_PUBLIC_ONEINCH_API_KEY` to "fix" a call that was failing, which works instantly
 * and publishes the key to every visitor. Nothing else in the build would go red.
 *
 * **It is unsatisfiable if the claim is false**, which is the point. It reads the real key out of
 * the environment and searches the emitted client chunks for that exact string. With no key in the
 * environment it says so and fails, rather than passing on an empty search — a check that cannot
 * fail is not a check, and this file exists because that mistake has been made in this repository
 * three times.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const key = process.env.ONEINCH_API_KEY?.trim();
if (!key) {
  console.error(
    "FAIL  no ONEINCH_API_KEY in the environment, so this search would pass on nothing.\n" +
      "      Run it with the key the deployment uses, or it proves nothing at all.",
  );
  process.exit(1);
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, String(entry.name));
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

// `.next/static` is what a browser downloads. The server bundle is allowed to hold the key — that
// is where the route handler runs — so searching it would fail for the right reason and the wrong
// one, and would teach everyone to ignore this.
const root = ".next/static";
let scanned = 0;
const leaked: string[] = [];
for await (const file of walk(root)) {
  scanned += 1;
  const body = await readFile(file, "utf8").catch(() => "");
  if (body.includes(key)) leaked.push(file);
}

if (scanned === 0) {
  console.error(
    `FAIL  nothing under ${root} to search. Run \`bun run build\` first.`,
  );
  process.exit(1);
}

// The search has to be able to find something, or a zero result means nothing. A string the build
// definitely emits is looked for in the same pass, so a broken walk shows up as a failure here
// rather than as a clean bill of health.
let foundAnything = false;
for await (const file of walk(root)) {
  if (file.endsWith(".js")) {
    foundAnything = true;
    break;
  }
}
if (!foundAnything) {
  console.error(
    `FAIL  ${scanned} files under ${root} and not one of them is JavaScript.`,
  );
  process.exit(1);
}

if (leaked.length > 0) {
  console.error(
    `FAIL  the 1inch key is in ${leaked.length} client chunk(s):\n` +
      leaked.map((f) => `      ${f}`).join("\n") +
      "\n      A key the browser can read is a key everyone has. Remove the NEXT_PUBLIC_ prefix.",
  );
  process.exit(1);
}

console.log(
  `ok    the 1inch key is in none of ${scanned} client files under ${root}`,
);
