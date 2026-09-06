---
title: "Liquidity that stays in range"
summary: "What Helico is, in plain words: a mandate you sign once, an enclave that decides, and a vault that refuses everything else."
author: "Helico"
tags: ["product", "uniswap-v4", "chainlink-cre"]
published_at: 2026-09-06T09:40:00Z
---

A concentrated liquidity position on Uniswap v4 earns fees only while the market price sits inside its range. The moment the price leaves, the position stops earning and starts holding one token. Keeping it in range means moving it, and moving it means someone has to be trusted to do the moving.

Helico's answer is to make that trust small and precise. You commit a **mandate**: seven fields that say exactly what a move may look like. A Chainlink CRE **enclave** watches the pool and decides when a move is worth it. A **vault** on the chain checks every field of the mandate before anything happens, and reverts anything that does not fit.

## The three parts

**The mandate** is the contract between you and the automation. It names the pool, the exact width of the range you want, the minimum improvement a move must bring, a cooldown between moves, a cap on how much liquidity one move may touch, an expiry, and the share of your liquidity every move must keep. You sign it once; its hash lives in the vault.

**The enclave** is where the deciding happens. A Chainlink CRE confidential workflow reads the pool and your position from inside a trusted execution environment, recomputes the mandate's hash from thresholds released only into the enclave, and works out whether a new range would satisfy the mandate. Most of the time it decides to do nothing. When it does decide to move, it sizes the swap and the mint and sends the verdict out. Only the verdict leaves.

**The vault** is the part that does not trust the enclave. It holds the mandate's hash, checks the verdict's hash against it, and then runs every rule again on chain: the pool, the width, the improvement, the cooldown, the cap, the expiry, the retained share, and that the new range contains the current price. A verdict that fails any of them reverts. There is no other entry point.

## What you keep

Your position stays yours. The position NFT never leaves your wallet; you approve the vault as an operator, and a re-centre mints the new position straight back to you. Between the burn and the mint the vault holds the tokens for exactly one call, and it asserts on chain that it kept none of them before that call returns.

A rogue agent can move you inside your own terms, and nothing else. That sentence is the product.

## Where it stands

Helico is a hackathon submission for ETHOnline 2026. The vault has a rehearsed deploy script, the workflow runs in the CRE simulator, and the forwarder path has been run end to end on a fork of Arbitrum One. Nothing is on a live network yet, and nothing on this site says otherwise.
