# The idle-capital workflow, run end to end on a fork

**8 September 2026.** A recorded run of `apps/cre/rehearse-idle.sh`, with its numbers checked
against the policy that produced them. This exists because "we ran it and it worked" is not
evidence — a judge should be able to clone the repository and get the same shape of answer.

Reproduce with:

```sh
cp apps/cre/.env.example apps/cre/.env    # then fill the IDLE_* values
cd apps/cre && ARBITRUM_RPC_URL=… ./rehearse-idle.sh
```

It forks `latest`, so the block numbers and addresses below differ every run. The **relationships**
between the numbers are what should reproduce.

## What the run did

```
1/7  fork Arbitrum One          block 502,809,682
2/7  deploy the account factory  0x4168C0d99BF376aDb3cb6A3DbfA562b2c96f3944
3/7  open the owner an account   0x92C8b3Cf8390B7A80A2743Af887F22D43A89D007
                                 (the address was predicted before it existed)
4/7  fund it, and set its rules  idle 50,000 USDC   working 0
                                 agent 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
5/7  point the workflow at it    pools ["0x794a…14aD"]  delivery "signature"
6/7  simulate                    ✓ Workflow compiled
7/7  carry the signed call
```

The simulator's answer:

```
SUPPLY 40000000000 to 0x794a61358d6845594f94dc1db02a252b5b4814ad
  [buffer 100000000: policy floor 100000000, 0 live Aqua balances could demand 0]
```

And after the signed call landed:

```
working  0 -> 39999999999
idle     10000000000
agent's own USDC 0
```

## The numbers, checked rather than quoted

**80% went to work, and the policy says 80%.** `SECRET_IDLE_TARGET_WORKING_BPS=8000`, and
40,000 / 50,000 = 80%. The remaining 10,000 stayed liquid.

**The buffer note explains itself.** `policy floor 100000000` is `SECRET_IDLE_MIN_IDLE_AMOUNT`
(100 USDC). `0 live Aqua balances could demand 0` is the subgraph's answer — a freshly deployed
account has shipped no mandate, so nothing raises the floor. Crucially this is `known: true`, not
a fallback: the GraphQL POST left the compiled QuickJS workflow and parsed. A failure would have
read `policy floor only`.

**The calldata is what it says it is.** The run emitted
`0x853112a5` + two addresses + `0x09502f9000`, which decodes as:

```
cast calldata-decode "supplyIdle(address,address,uint256)" 0x853112a5…
  0x794a61358D6845594F94dc1DB02A252b5b4814aD   Aave v3 Pool
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831   USDC
  40000000000                                  40,000 USDC
```

`cast sig "supplyIdle(address,address,uint256)"` is `0x853112a5`. The selector, the pool, the
asset and the amount can each be checked without trusting the transcript.

**One unit short of 40,000 aUSDC**, and that is correct. Aave rounds against the supplier, which
`contracts/test/ForkAaveIdle.t.sol` records as a property rather than a tolerance.

**The agent's own USDC is zero**, and that is the assertion that matters. A transaction that
succeeds and moves nothing reads in a log exactly like one that worked, so the balances are the
only thing worth believing — the same reason the vault's rehearsal checks the position rather
than the receipt.

## What it proves

- The workflow **compiles for the CRE runtime** and runs to completion in the TEE simulator.
- It reads an account's state from inside the handler, decides against thresholds released only
  there, and signs an EIP-712 statement.
- It queries the live Subgraph Studio endpoint from inside the compiled workflow.
- The signed call **lands and moves real capital** into the real Aave v3 pool on a fork of
  Arbitrum One.
- The agent gains nothing in the process.

## What it does not prove

- **The simulator is not a TEE.** It says so while running, and names the enclave it would use in
  production (AWS Nitro, us-west-2). This shows the code runs as a Confidential Workflow; it does
  not show DON authorisation or attestation.
- **It is a fork, not a live network.** No `HelicoAccount` is deployed on Arbitrum One yet.
- **The multi-market choice is not exercised here.** The account permits one venue, so the run
  demonstrates the decision, not the comparison. That half is covered by unit tests.

Chainlink's own qualification text accepts *"a Confidential Workflow simulation using the CRE CLI
**or** a live deployment"*, so this is evidence rather than a stand-in for it.
