# Demo video: script and shot list

Issue: #22. Target **3:30**, inside the 2–4 minute window. 720p or better.

## The rules that reject an upload

| Rule | Consequence |
|---|---|
| Under 2:00 or over 4:00 | Upload rejected automatically |
| Below 720p | Upload fails |
| **Sped up** | **Automatic disqualification** |
| Recorded on a phone | Rejected |
| Text-to-speech or AI voiceover | Rejected |
| Music with on-screen text instead of speech | Rejected |

Editing to cut waiting is allowed. Speeding up the footage is not. Where something takes two
minutes, cut to the result — do not accelerate the clip.

## What can honestly be shown

Nothing is on a live network yet. Two versions of the same script, and the only difference is
one shot:

- **If the vault is deployed by recording day** — shot 4 runs against Arbitrum One and the
  Arbiscan transaction is on screen.
- **If it is not** — shot 4 runs `apps/cre/rehearse.sh` against a fork, and the words "on a
  fork of Arbitrum One" are spoken while it runs. That sentence is not a disclaimer to be
  rushed; it is the reason the rest of the video is believable.

Record the fork version first regardless. It is the version that exists today, and #22 says to
have a full-length take two days early rather than the night before.

## Shot list

### 0:00–0:18 — What it is

*Screen: the landing page hero.*

> A Uniswap v4 position only earns while the price is inside its range. When the price leaves,
> it stops earning and starts holding one token.
>
> Helico moves it back. Not on trust: on rules you sign once, that the contract enforces.

Under 20 seconds, as the guidance asks. No logo animation, no title card.

### 0:18–0:50 — The mandate

*Screen: the eight rule cards in the Enforcement section, then `Mandate.sol` in the editor.*

> The mandate is seven numbers. Which pool. How wide a band. How much closer a move has to
> get. How often. How much of your liquidity a move must keep. When it expires. A cap.
>
> Each one is a line in the vault that refuses a move that breaks it. Those are the lines on
> screen — not a diagram of them.

Scroll `_checkRange`. Do not read the code aloud; let it sit while the sentence lands.

### 0:50–1:30 — Where the decision happens

*Screen: `packages/plugins/cre/src/index.ts`, `cre.handlerInTee` visible.*

> The decision runs inside a Chainlink CRE confidential workflow — in an enclave. Six of the
> seven mandate fields are secrets released only in there, because they are your strategy.
>
> What comes out is a verdict and the hash of the mandate it was decided against. The vault
> refuses any verdict whose hash is not the one it stored. So the enclave can be wrong, and it
> still cannot move you outside your own terms.

### 1:30–2:40 — Run it

*Screen: terminal. `cd apps/cre && ./rehearse.sh`.*

Speak over the run. Cut the waiting, never speed it up.

> This forks Arbitrum One, deploys the vault, and mints a position that has drifted below the
> market, so it holds one token and cannot fund a two-sided range.
>
> Now the workflow. It reads the pool from inside the enclave, decides to re-centre, and
> writes the report through the Chainlink forwarder.

*Screen: `RECENTER 94520..94720 tx 0x…`, then the state read-back.*

> The position moved. Ninety-three units of liquidity in, seventy-four out, and the vault holds
> nothing afterwards.
>
> And that number is why we check the position rather than the transaction. The forwarder calls
> the vault inside a try — a re-centre that reverts still leaves a transaction marked
> successful. We found a real bug that way.

*Screen: second run printing `HOLD (cooldown)`.*

> Run it again and the cooldown you signed refuses it.

### 2:40–3:10 — Why it is safe

*Screen: `contracts/README.md`, "What a rogue agent can do".*

> Your position NFT never leaves your wallet. No path in the vault pays an agent. The swap can
> only spend what the burn returned, and the only addresses in the plan are yours and the
> pool's.
>
> A rogue agent can move you inside your own terms, and nothing else. Withdraw the approval and
> it stops — nothing we control can block that.

### 3:10–3:30 — What is and is not done

*Screen: the README's caveat block.*

> Nothing is on a live network yet. What you saw ran on a fork, through the simulator, which is
> not a real enclave, and through a mock forwarder that verifies no signatures.
>
> Chainlink's own criteria accept a CLI simulation as evidence, and every number in this video
> is in the repository with the command that reproduces it.

End on the repo URL. No outro music.

## Before recording

- [ ] `bun install`, `cp apps/cre/.env.example apps/cre/.env` — the run must be warm, so the
      first take is not spent on a dependency download
- [ ] Run `rehearse.sh` once beforehand: it forks `latest`, so the tick and the numbers differ
      every time and the spoken figures must match the take that ships
- [ ] Terminal font large enough to read at 720p
- [ ] Close anything with a wallet, a key, or a private repository in it
- [ ] One rough full-length take by **11 September**, two days before the deadline

## What must not be said

- "Deployed", "live", or "in production" — none of it is
- "Audited" — twelve AI agents reviewed the vault, and that is not an audit
- "Runs in a TEE" — it runs in the simulator, which announces that it is not a TEE
- Any figure not read off the take being recorded
