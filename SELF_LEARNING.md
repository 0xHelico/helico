# Self-learning

Mistakes made building Helico, what caught each one, and the check that would have caught it
sooner. Written by the AI that made them, at the request of the human who kept finding them.

This is not a confessional. Every entry ends in a rule, and the rules are the point — a mistake
that produces no check is just a story. Where an entry names a pull request or an issue, the
evidence is there and can be read.

> **How to use this file.** Before opening a pull request, read the rules in
> [At a glance](#at-a-glance). If a change touches something an entry below is about, read that
> entry. It takes two minutes and each one of them cost hours.

## At a glance

| # | Rule |
|---|---|
| 1 | Check the record before making a claim about the record — especially about your own conduct |
| 2 | Never merge your own pull request |
| 3 | An ignore rule with a trailing slash does not stop a symlink |
| 4 | Read your own notes before calling something a blocker |
| 5 | A mutation that changes no output has not been applied — verify it landed |
| 6 | A mock may decline to model something; it may not answer wrongly |
| 7 | Fix the whole of a defect, and write the test for the half you were not thinking about |
| 8 | State means a state read, not a receipt |
| 9 | Do not delete a branch another pull request is stacked on |
| 10 | A number written by hand drifts; derive it or expect to be wrong |
| 11 | Verify a change does something before landing it as a fix |
| 12 | Say what is true, in both directions — understating is also a false claim |

---

## 1. I made a false claim about my own conduct, in the document about my conduct

**What happened.** Told that the reviewer should merge rather than the author, I wrote the rule
into `CONTRIBUTING.md` (#82) and justified it like this:

> *"#64, #69, #70 and #75, each one as soon as CI went green, each one with a reviewer
> requested and none of them yet read."*

Then I checked. Every one had been **approved before I merged it**:

| PR | Approved | Merged | Gap |
|---|---|---|---|
| #64 | 04:59:12Z | 06:44:54Z | 1h 45m |
| #69 | 06:49:35Z | 09:36:28Z | 2h 47m |
| #70 | 07:25:02Z | 09:36:31Z | 2h 11m |
| #75 | 09:59:19Z | 10:09:37Z | 10m |

Ten pull requests were merged by their own author, and **all ten carry an approval submitted
before the merge**. What I described did not happen.

**Why it is the worst entry here.** Every other mistake in this file is a thing I got wrong
while trying to get it right. This one is a claim I made about the record, from memory, without
looking — inside a document whose entire purpose was to fix my own carelessness. It went into a
public issue, a pull request body, and a commit message now in `main`.

The rule itself survives and is right. The reasoning under it was invented.

> **Rule.** One command separated me from the truth:
> `gh api repos/0xHelico/helico/pulls/N/reviews`. Any sentence containing a pull request
> number, a count, a timestamp or "never" is a claim about the record. Run the query. This
> applies hardest to claims about yourself, because those feel like memory rather than
> research.

Corrected on #82 and #81.

## 2. I merged ten of my own pull requests

**What happened.** #52, #54, #56, #57, #59, #60, #64, #69, #70, #75 — all authored and merged by
me. Approved first, as above, but the author still closed the loop.

**What caught it.** The human, directly: *"PR ku rifky yang merge, PR rifky aku yang merge."*

**Why it matters even with an approval.** The finalist track judges branch and pull request
practice. A history where authors merge their own work does not show what we want it to show,
and the moment a review is slow, "approved first" quietly becomes "approved later".

> **Rule.** After pushing and seeing CI green, **stop**. Request the reviewer, write what needs
> checking, and wait. If a reviewer is unreachable and something is genuinely blocking, that is
> escalated to the human — it is not the author's call to skip.

Rule in `CONTRIBUTING.md`; every pull request since has been merged by the reviewer.

## 3. I committed a symlink to my home directory, twice, to a public repository

**What happened.** To avoid reinstalling dependencies in throwaway worktrees:

```bash
ln -s /…/helico/contracts/lib  "$W/contracts/lib"
ln -s /…/helico/node_modules   "$W/node_modules"
```

`git add -A` took both. They reached public branches on #89 and #90 with an absolute home path
inside them, and dangled on any other machine — `forge build` could not resolve a single import.

**Why `.gitignore` did not stop it.** The rules were `contracts/lib/` and `node_modules/`. **A
trailing slash matches a directory only.** A symlink of the same name is a file of mode
`120000`, so it walks straight past. The rules had been correct and had worked for months; what
was misunderstood was what they matched.

**What caught it.** The collaborator, checking out #89 to review it. Not CI, which had not run;
not me, who had created it. #90 had the same defect and was `MERGEABLE` at the time.

```bash
# committed symlinks on this branch
git ls-tree -r HEAD | awk '$1=="120000"'

# ever, anywhere in a branch's history
for c in $(git rev-list origin/main); do
  git ls-tree -r "$c" | awk -v c="$c" '$1=="120000"{print c, $4}'
done
```

`main` was checked commit by commit and was clean. Both branches were **rewritten**, not
patched — removing a path in a later commit leaves it in the history of a branch that is
already public.

> **Rule.** No trailing slashes in `.gitignore` for anything a symlink could impersonate — done
> for every directory rule in this repository, with the reason written above them. And the
> deeper one: the habit was the bug, not the ignore rule. Build in a worktree with a real
> install, not a link into a home directory.

## 4. I called something a blocker for days while my own notes said it was not

**What happened.** "Confidential Workflows beta enrolment" sat on the human's blocked list for
days. Chainlink's qualification text:

> *"Demonstrate a successful execution through either **a Confidential Workflow simulation
> using the CRE CLI** or a live deployment on the CRE network."*

Simulation qualifies. The beta gates deployment to a DON, which the prize does not require.

**What makes it bad.** Both the rules file and the strategy note in the private repository
already recorded this on 5 September, in a sentence each. Written down, then not read back.

> **Rule.** Before adding anything to a blocked list, grep the notes for it. Evidence you
> already hold and have not read is the same as not having it — a rule that was already in
> `CLAUDE.md` before this happened, which is why the correction lives next to it rather than
> quietly replacing it.

## 5. A mutation that reported "your test is vacuous" had never been applied

**What happened.** Testing whether a new assertion really bit, a string replacement was made and
the suite run. All tests passed — which reads as *the test proves nothing*.

It was not true. The replacement had not matched the source after `forge fmt` reflowed it, so
the contract never changed. What got measured was a mutation that never happened.

**The tell.** Gas figures identical to the byte across runs: `6028472`, twice. Changed code
almost always changes gas.

Applied properly, the mutation killed exactly one test with exactly the expected error.

> **Rule.** Confirm the mutation landed before believing its result — `git diff`, or a changed
> gas figure. A mutation that silently fails to apply reports "your test proves nothing" and is
> **indistinguishable from a real finding**. Mutation testing has its own version of the disease
> it exists to cure.

## 6. A mock returned zero, and covered a new code path with nothing

**What happened.** `MockStateView.getSlot0` returned `0` for the price, because nothing had ever
read it. When the vault started sizing a mint from that price, **85 tests passed with the new
line covered by nothing** — zero sends the calculation down a branch that produces a number too
large to bind, so the line never ran. It passed because it was never asked.

It now returns `TickMath.getSqrtPriceAtTick(tick)` — not a second stored value that can drift,
but the identity v4 itself holds.

> **Rule.** A mock may decline to model something, and declining to model a price curve is
> right — a fake curve makes tests look more authoritative than they are. What a mock may not do
> is **answer wrongly**. Zero is not "unmodelled"; it is an answer, and it was false. When code
> starts reading a field the mock has been ignoring, that field becomes honest in the same
> change.

This is the fourth member of a family that runs through the whole project — see
[The shape that keeps coming back](#the-shape-that-keeps-coming-back).

## 7. I fixed half a defect and wrote a test that could not see the other half

**What happened.** #80 stopped the vault trusting the enclave's `liquidityToMint`, then passed
the enclave's guess about its own post-swap balances to Uniswap one line later as the mint's
ceiling. Same mistake, same function.

Worse, the test written for it passed `type(uint128).max` for both maxima — so it covered the
half I was thinking about and left the other **untestable by construction**.

**What caught it.** The reviewer, who ran the code and read the test rather than the diff:

> *"the new fork test uses `uint128.max` for both, so it does not exercise that."*

Fixed in #88, with a test that sets both to one wei.

> **Rule.** After fixing a defect, ask what else in the same function trusts the same wrong
> thing. Then check the new test can fail for the reason it claims — pick inputs that make the
> assertion impossible to satisfy without the fix, not inputs that make it convenient.

## 8. I nearly shipped a transaction hash as evidence, for a transaction that did nothing

**What happened.** The first version of `apps/cre/rehearse.sh` printed what the workflow printed:

```
✓ Workflow Simulation Result:
"RECENTER 94520..94720 tx 0xc63176d9…f06c283"
```

`cast receipt … status` said **1**. `positionOf(owner)` was **unchanged**. Nothing had moved.

`KeystoneForwarder` calls the receiver inside a `try`. A reverting `onReport` is caught and the
outer transaction still succeeds. Neither the hash nor the receipt status says anything about
whether a position moved.

The status check was also wrong on its own terms — `cast receipt … status` prints
`1 (success)`, so a string comparison against `1` never matched and the script took the failure
branch on every run, including the successful ones.

**What caught it.** Reading the state back because it was cheap, not because anything was
suspected. That is what found #78.

> **Rule.** Evidence is a state read: `positionOf`, `ownerOf`, `getPositionLiquidity`, the
> event. Never a hash, never a receipt status. Quoting a hash as "the partner integration
> works" is the shape of disqualification reasons 2 and 4.

## 9. I deleted a base branch with another pull request stacked on it

**What happened.** Merging #67 with `--delete-branch` closed **#76** automatically, because #76
was based on it. GitHub will not reopen a pull request whose base branch is gone; restoring the
branch did not help. The work was rebased and reopened as #77, losing the number and the thread.

> **Rule.** Before `--delete-branch`, check for pull requests based on it:
> `gh pr list --json number,baseRefName`. Retarget them first, or merge without deleting.

## 10. Hand-written counts drifted three times in one day, twice past my own review

**What happened.** The fork-test count appeared as 9, then 10, then 11 in the same afternoon as
tests landed. I flagged "9 should be 10" in a review; #88 made it 11 before that review was
addressed. The contracts README said *"78 tests, 9 of them on a fork"* four lines below the
command that prints the real numbers — so a reader following its own instructions got a
different answer from its own claim.

> **Rule.** Any number in a document is stale from the moment it is typed. Derive it at build
> time where the surface supports it — the landing page already renders `_checkRange` from the
> vault source, and the same trick over the test directory would end this. Where it cannot be
> derived, state the command beside it so the reader can see the drift, and re-run it before
> quoting it.

## 11. I nearly landed a redundant change as a recovered bug fix

**What happened.** A survey found a branch a commit ahead of `main`, never opened as a pull
request, carrying what read as a dropped fix: shave one unit off the swap bound so a fill cannot
land on the range's exclusive upper edge.

Before adopting it, I mutated it. Reverting the change altered **no output in any case that
could be constructed** — three pool depths, identical to the wei. The test shipped with it could
not tell the two apart either.

The vault's own swap already passes `sqrtPriceLimitX96 = getSqrtPriceAtTick(tickUpper) - 1`, and
a fork test already asserts the pool halts at `tickUpper - 1`. The change was redundant, which
is presumably why it was abandoned.

What landed (#90) was the reasoning, not the arithmetic.

> **Rule.** Before adopting a change as a fix — including someone else's, including one whose
> commit message is convincing — demonstrate that reverting it changes an output. Unobservable
> arithmetic under a comment claiming it prevents something is worse than the plain expression.

## 12. The README understated what had been built

**What happened.** The root README carried:

> ⚠️ *"Not yet claimed. The workflow's verdict does not yet drive the vault on chain."*

That had stopped being true two merges earlier. #70 gave the vault `onReport`; #72 ran a report
through a forwarder that re-centred a real position on a fork.

> **Rule.** Understating is a false claim too. A caveat is not permanently safe just because it
> is cautious — it has an expiry, and a judge reading it concludes the integration does not
> work. Re-read every ⚠️ block after anything it describes changes.

---

## The shape that keeps coming back

Five of these are the same mistake wearing different clothes: **evidence that can be satisfied
without the thing it claims ever happening.**

| Instance | What it looked like | What it was |
|---|---|---|
| A mock that could not refuse | twenty green tests | a drainable vault |
| `after_ >= lower && after_ < upper` | the swap stayed in range | a swap that never started |
| A forwarder that swallows a revert | `status 1`, a transaction hash | a position that never moved |
| A mock answering `0` | 85 tests passing | a new line never executed |
| A mutation that never applied | "your test is vacuous" | a test that was fine |

One question breaks all five:

> **What would have to be different in the world if this were true — and have I actually read
> that thing?**

Not "did the test pass". Not "did the command exit zero". *What changed, and did I look.*

---

## What did not go wrong, and why

Worth recording, because the same discipline produced both halves.

- **Cross-review caught what CI could not.** The reviewer's independent mutation on #70; five
  untrue claims on the landing page in #67; the symlink in #89; the untestable maxima in #88.
  None of those come from a green tick.
- **CI reports `SKIP` rather than `PASS` for fork tests without an endpoint.** A green tick for
  tests that never ran is worth less than an honest gap.
- **Plans committed before implementation**, in `docs/plans/`, and every AI-assisted change
  logged in [`AI-USAGE.md`](AI-USAGE.md) with what was verified and how.
- **Corrections are made in public, attached to the thing they correct**, rather than edited
  away — #78 carries two of my own reversals, and #82 carries the correction to entry 1 above.

---

*Kept current: an entry is added when a mistake costs more than ten minutes or reaches a branch
other than the author's. Entries are not deleted — a rule with no story behind it stops being
followed.*
