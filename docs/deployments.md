# Deployments

Arbitrum One, chain id 42161. Every address below was read back from the chain after the
broadcast, not copied from a script's output — the third column is what the contract answers when
asked about itself.

## 8 September 2026 — the accounts and the Aqua app

| Contract | Address | Answers | Source |
|---|---|---|---|
| `HelicoAccount` (implementation) | [`0x0842BB3f773A8Ee9732b229327b79CCB2Ce54847`](https://arbiscan.io/address/0x0842BB3f773A8Ee9732b229327b79CCB2Ce54847#code) | `UPGRADER()` → `0xaeE1F9d2…` | verified |
| `HelicoAccountFactory` | [`0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081`](https://arbiscan.io/address/0x01CC7d9FE8da79B61bcc5d3f7e3f0433DCE7E081#code) | `IMPLEMENTATION()` → `0x0842BB3f…` | verified |
| `HelicoMandateSwap` | [`0xA16D313816247628DeB7d89DC7a3Cf4aDb5287Ed`](https://arbiscan.io/address/0xA16D313816247628DeB7d89DC7a3Cf4aDb5287Ed#code) | `AQUA()` → `0x1111113CCf…` | verified |

```
HelicoAccount         tx 0xc9517828f595dc6e563b3702da51f70f9823497c3790b8fb8130a59ca5039163
                      block 502,979,387   gas 1,963,574
HelicoAccountFactory  tx 0x033277a7101fcd2f9d3a30ebedad467032f82542a169eb28e4916b057630b320
                      block 502,979,401   gas   898,469
HelicoMandateSwap     tx 0x5ea76409ca2172755cb1fb9aff69ee82d5a8a0461a03eda853986744ed09ee1f
                      block 502,979,513   gas 1,728,989
```

**Deployer** `0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E`, and the whole thing cost
**0.0000929 ETH** at 0.02 gwei — the balance went from 0.0079167 to 0.0078237. The figure that
gated this deploy for four days was 0.02 ETH, which is two hundred times what it took.

### What each deployment checked before it was believed

Both scripts assert after broadcasting rather than assuming beforehand, and both printed their
checks. `DeployAccountFactory` additionally proves the property the whole factory exists for: it
predicts an address for an owner, opens it inside a state snapshot, compares, and reverts the
snapshot. A counterfactual address that does not match what the factory produces would be a
quiet lie, and it is checked at the moment of deployment rather than trusted.

### Verified, and checked from the other side

All three carry their source on Arbiscan. Read back from Etherscan's API rather than taken from
`forge verify-contract`'s own report — a tool saying it succeeded is not the same claim as the
explorer serving the source:

```
0x0842BB3f…  HelicoAccount         231,503 chars  v0.8.30+commit.73712a01  optimizer on, 200 runs
0x01CC7d9F…  HelicoAccountFactory  194,621 chars  v0.8.30+commit.73712a01  optimizer on, 200 runs
0xA16D3138…  HelicoMandateSwap      83,601 chars  v0.8.30+commit.73712a01  optimizer on, 200 runs
```

Compiler and optimizer settings match `foundry.toml`'s default profile, which is what makes the
verification mean the bytecode came from the source in this repository rather than from something
that merely compiles to the same thing.

Verification needs `ETHERSCAN_API_KEY` in the source-of-truth `.env`. One key serves every chain
on Etherscan's v2 API, so `--chain-id 42161` is all that points it at Arbiscan.

## 8 September 2026 — the SwapVM router

| Contract | Address | Answers | Source |
|---|---|---|---|
| `HelicoAquaSwapVMRouter` | [`0xb8c9f14d46bf387a6d70d796df30f11a0eb8c3be`](https://arbiscan.io/address/0xb8c9f14d46bf387a6d70d796df30f11a0eb8c3be) | `AQUA()` → `0x1111113CCf…`, `AQUA_YIELD_COVER_OPCODE()` → `34` | verified |

```
tx 0x074ad590cc29214e2a12667f538f8a0fb1d1cb87d39b4a4e878340abfa943ab7
block 502,984,884   gas 4,186,682   cost 0.0000839 ETH
constructor(aqua, weth, rescuer, "Helico SwapVM", "1")
rescuer 0x6DCd7485aB17e0CBD0723b8435a35bb8d029439E
```

The EIP-712 domain reads back as `"Helico SwapVM"` version `"1"`, which is how you tell this
router apart from 1inch's `"1inch SwapVM v1.0"` / `"1.0.2"` at
`0x111111338c5091E8440b67B168bAe16a668AC0De`. **Ship strategies carrying opcode 34 to the address
above, not to that one** — see the runbook for what happens if you do not, and the fork test that
measures it.

### Verifying it took six attempts, and the sixth is the one to remember

Every submission came back `Compiled contract deployment bytecode does NOT match`, while the
other three verified first time with the same compiler and key. The settings were not the
problem — they were copied from the artifact's own metadata and still failed.

**Sourcify named it.** Its rejection carries an error code the Etherscan API does not:

```
extra_file_input_bug
It seems your contract's metadata hashes match but not the bytecodes.
Use the original full standard JSON input file that has all files including
those not needed by this contract.
```

The metadata hash matching while the bytecode does not is the whole diagnosis. **solc's IR
pipeline produces different bytecode depending on which files are in the compilation unit**, even
when the extra files contribute nothing to the contract. Foundry compiles the whole project — 155
sources here — while `forge verify-contract --show-standard-json-input` submits the dependency
closure, 64. Same settings, same solc, 50 bytes of difference.

The fix is to submit what was actually compiled. `out-swapvm/build-info/*.json` carries
`source_id_to_path` for the real unit; rebuilding the standard JSON from all 155 and compiling it
locally reproduced the deployed creation bytecode **exactly**, and Arbiscan then accepted it on
the first try.

This only bites contracts built with `via_ir`, which is why the other three never met it.

### The deployment was faithful, and that was checked before any of this

Worth keeping separate from the verification story, because it is what made it safe to keep
trying rather than assume a bad deploy:

- the creation bytecode in the deploy transaction **starts with the local artifact's exactly**,
  and the tail is the constructor arguments byte for byte;
- the runtime differs by ~377 bytes against **16 declared immutable slots** — 512 bytes of
  placeholder the constructor fills;
- a clean `FOUNDRY_PROFILE=swapvm forge build` from `main` reproduces the deployed creation
  bytecode, checked by deleting `out-swapvm` and rebuilding.

### Deliberately not deployed

- **`HelicoVault` and the Uniswap v4 path.** CRE no longer drives it. See
  [#175](https://github.com/0xHelico/helico/issues/175).

### Not done yet

- **No account has been opened on mainnet.** The factory is live and permissionless; nothing has
  used it, and nothing holds anyone's funds. See [the runbook](deploy-runbook.md) for the two
  calls that prove a deployed account can be acted on and escaped from.
