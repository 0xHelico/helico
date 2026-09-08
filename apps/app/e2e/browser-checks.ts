/**
 * The behaviours that only a browser can show, and that each cost a real bug.
 *
 *   bun run build && bun run dev -p 3100
 *   bun run e2e
 *
 * No wallet, no backend, no anvil. Everything the front door shows is public — a mandate ledger
 * anyone can read, an account address anyone can derive — so the checks run as a visitor who
 * arrived from a link, which is who a judge is.
 */
import { chromium } from "playwright";

const APP = process.env.APP_URL ?? "http://localhost:3100";
const _FORK = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  console.log(
    `${ok ? "  ok  " : "FAIL  "}${name}${detail ? `  — ${detail}` : ""}`,
  );
  if (!ok) {
    failures.push(name);
  }
}

// The injected wallet and its signer went with the session checks. Nothing left needs a
// connected wallet to render: the account panel says what it would show and the mandate panel
// takes an address typed in. Recovering them is `git log` away if a check ever needs one.

const browser = await chromium.launch();

// The session gate is gone with the chat: nothing here is private. A mandate ledger is
// readable by anyone and an account address is derivable by anyone, so asking a visitor to
// sign before showing them either was a habit from when this app was a conversation that had
// to be kept to one address. Four checks went with it — they tested a cookie that is no longer
// set, on a gate that no longer stands.

// 5. The front door leads with the mandate, not with a box offering to swap. This is the one a
//    judge sees first, and it regressed once already by being the conversation.
{
  const page = await (await browser.newContext()).newPage();
  // No wallet, no signature. Everything below has to be visible to somebody who arrived from a
  // link, because that is who a judge is.
  await page.goto(APP, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: /limits it works inside/ })
    .waitFor({ timeout: 30_000 });

  const text = (await page.locator("body").innerText()).trim();
  check(
    "the front door leads with the mandate",
    /limits it works inside/.test(text),
  );
  check(
    "it lists the authority on offer",
    /What it may be allowed to do/.test(text),
  );
  check("where the capital sits", /Where your capital sits/.test(text));
  // The three empty states look alike from outside and one of them is a broken build. With no
  // factory address configured, the panel has to say that rather than render a figure — a screen
  // that invents a balance is the failure the rules name, and an empty one is the smaller cost.
  check(
    "and it says so rather than inventing a balance",
    /No account factory is deployed yet/.test(text),
  );
  // The panel that could not exist without an indexer. It renders for a wallet-less visitor too,
  // because the claim is about any address rather than about theirs.
  check(
    "the mandates nobody can list are on the front door",
    /What this wallet may spend/.test(text),
  );
  check(
    "and it says why an indexer is the only way",
    /no on-chain way to ask this/.test(text),
  );
  check("the limits themselves", /The limits you set/.test(text));
  check("and which capabilities are not wired", /not wired yet/.test(text));
  check(
    "the composer is not on it",
    (await page.getByPlaceholder(/Ask anything/i).count()) === 0,
  );

  // A grant nobody has wired must be genuinely unmovable rather than merely dimmed. At most one
  // switch on this page is operable — the real one — and it is only operable when a vault and a
  // wallet are both present, so "none" is also correct here.
  const switches = page.getByRole("switch");
  const total = await switches.count();
  let operable = 0;
  for (let i = 0; i < total; i++) {
    if (await switches.nth(i).isEnabled()) {
      operable++;
    }
  }
  check("more than one capability is shown", total > 1, `${total} switches`);
  check(
    "and at most one of them can be operated",
    operable <= 1,
    `${operable} operable`,
  );

  // What used to be here: clicking an ask and landing in the conversation. There is no
  // conversation. The composer check above is now the whole of it — the front door must not
  // grow one back.
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nall browser checks passed");
