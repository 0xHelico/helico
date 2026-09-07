import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import { Aqua, Docked, Pulled, Pushed, Shipped } from "../generated/Aqua/Aqua";
import { App, Balance, Maker, Mandate, Movement } from "../generated/schema";

/**
 * Aqua keys every balance by (maker, app, strategyHash, token), so a strategy hash alone does
 * not identify a strategy — the same bytes shipped by two makers, or to two apps, are different
 * things with the same hash. The id concatenates all three rather than hashing them, because a
 * reader can then pull the three back out of it.
 */
function mandateId(maker: Bytes, app: Bytes, strategyHash: Bytes): Bytes {
  return maker.concat(app).concat(strategyHash);
}

function balanceId(mandate: Bytes, token: Bytes): Bytes {
  return mandate.concat(token);
}

function loadOrCreateMaker(address: Bytes): Maker {
  let maker = Maker.load(address);
  if (maker === null) {
    maker = new Maker(address);
    maker.mandateCount = 0;
    maker.activeMandateCount = 0;
    maker.save();
  }
  return maker;
}

function loadOrCreateApp(address: Bytes): App {
  let app = App.load(address);
  if (app === null) {
    app = new App(address);
    app.mandateCount = 0;
    app.activeMandateCount = 0;
    app.save();
  }
  return app;
}

/**
 * Balances arrive through `Pushed`, including the initial ones: `ship` emits `Shipped` and then
 * one `Pushed` per token in the same transaction. So this is created on the way past rather
 * than up front, and the mandate is looked up rather than assumed.
 */
function loadOrCreateBalance(
  mandate: Mandate,
  token: Bytes,
  event: ethereum.Event,
): Balance {
  const id = balanceId(mandate.id, token);
  let balance = Balance.load(id);
  if (balance === null) {
    balance = new Balance(id);
    balance.mandate = mandate.id;
    balance.token = token;
    balance.amount = BigInt.zero();
    balance.totalPulled = BigInt.zero();
    balance.totalPushed = BigInt.zero();
    // Read once, when the row appears. No event carries `tokensCount`, and it does not change
    // again until the token is docked -- which is handled where that happens.
    balance.tokensCount = readTokensCount(mandate, token, event.address);
  }
  return balance;
}

/**
 * Aqua's three-state sentinel for one token: 0 never shipped, 1-254 active, 255 docked.
 *
 * Nothing in the event stream carries it, so it is read from the contract. A reverted call
 * leaves the previous value rather than inventing one -- being wrong here means claiming a
 * revoked allowance is spendable, which is the failure mode this field exists to prevent.
 */
function readTokensCount(mandate: Mandate, token: Bytes, aquaAddress: Address): i32 {
  const aqua = Aqua.bind(aquaAddress);
  const result = aqua.try_rawBalances(
    Address.fromBytes(mandate.maker),
    Address.fromBytes(mandate.app),
    mandate.strategyHash,
    Address.fromBytes(token),
  );
  return result.reverted ? 0 : result.value.value1;
}

function recordMovement(
  mandate: Mandate,
  token: Bytes,
  amount: BigInt,
  direction: string,
  event: ethereum.Event,
): void {
  const movement = new Movement(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
  );
  movement.mandate = mandate.id;
  movement.token = token;
  movement.amount = amount;
  movement.direction = direction;
  movement.timestamp = event.block.timestamp;
  movement.block = event.block.number;
  movement.tx = event.transaction.hash;
  movement.save();

  mandate.movementCount = mandate.movementCount + 1;
  mandate.save();
}

export function handleShipped(event: Shipped): void {
  const maker = loadOrCreateMaker(event.params.maker);
  const app = loadOrCreateApp(event.params.app);
  const id = mandateId(event.params.maker, event.params.app, event.params.strategyHash);

  // Aqua refuses to re-ship a hash it has seen, so this is normally new. It is loaded rather
  // than assumed anyway: the same bytes shipped to a *different* app is a different mandate and
  // must not collide, and that is what the composite id is for.
  let mandate = Mandate.load(id);
  if (mandate === null) {
    mandate = new Mandate(id);
    mandate.maker = maker.id;
    mandate.app = app.id;
    mandate.strategyHash = event.params.strategyHash;
    mandate.movementCount = 0;
    mandate.shippedAt = event.block.timestamp;
    mandate.shippedAtBlock = event.block.number;
    mandate.shippedTx = event.transaction.hash;

    maker.mandateCount = maker.mandateCount + 1;
    app.mandateCount = app.mandateCount + 1;
    maker.activeMandateCount = maker.activeMandateCount + 1;
    app.activeMandateCount = app.activeMandateCount + 1;
  }

  // Kept verbatim. Aqua never interprets these bytes and neither does this subgraph — each app
  // defines its own struct, so decoding here would bake one app's layout into an index meant to
  // serve every app.
  // Set every time: a second ship of the same hash with a disjoint token set is permitted by
  // Aqua, and it makes the mandate live again. The ship fields above are not touched, so the
  // mandate keeps the origin it actually had.
  mandate.strategy = event.params.strategy;
  mandate.active = true;
  mandate.dockedAt = null;
  mandate.save();

  maker.save();
  app.save();
}

/**
 * `Docked` is not proof that anything was revoked.
 *
 * `dock` iterates the tokens it was handed and emits the event outside that loop, so an empty
 * array emits `Docked` and revokes nothing — the strategy stays live and still accepts pushes.
 * A mandate shipped with disjoint token sets can also be docked one subset at a time, leaving
 * some tokens at 255 and others still spendable. Neither case is visible in the event.
 *
 * And `dock` zeroes the ledger on chain (`balance.store(0, _DOCKED)`) while emitting no
 * per-token event at all, so an index that only flips a flag keeps advertising an allowance the
 * maker has revoked. That was measured against this chain before this was rewritten: two docked
 * mandates, four balances, showing 3.57 ARB and 1.4 USDC of spendable allowance that Aqua had
 * already taken away.
 *
 * So this reads the ledger. It is exact, it tells empty, partial and full docks apart without
 * guessing, and it costs almost nothing: Aqua has seen two `Docked` events in its entire
 * history on this chain.
 */
export function handleDocked(event: Docked): void {
  const id = mandateId(event.params.maker, event.params.app, event.params.strategyHash);
  const mandate = Mandate.load(id);
  if (mandate === null) {
    return;
  }

  const wasActive = mandate.active;
  const balances = mandate.balances.load();
  let anyStillSpendable = false;

  for (let i = 0; i < balances.length; i++) {
    const balance = balances[i];
    const aqua = Aqua.bind(event.address);
    const result = aqua.try_rawBalances(
      Address.fromBytes(mandate.maker),
      Address.fromBytes(mandate.app),
      mandate.strategyHash,
      Address.fromBytes(balance.token),
    );
    if (result.reverted) {
      // Leave the row alone rather than guess. Claiming a revoked allowance is spendable is the
      // failure this handler exists to prevent, and guessing could produce exactly that.
      continue;
    }
    balance.amount = result.value.value0;
    balance.tokensCount = result.value.value1;
    balance.save();

    // 0 is never-shipped and 255 is docked. Anything between is a live token count.
    if (balance.tokensCount > 0 && balance.tokensCount < 255) {
      anyStillSpendable = true;
    }
  }

  mandate.active = anyStillSpendable;
  mandate.dockedAt = anyStillSpendable ? null : event.block.timestamp;
  mandate.save();

  if (wasActive && !anyStillSpendable) {
    const maker = loadOrCreateMaker(event.params.maker);
    const app = loadOrCreateApp(event.params.app);
    maker.activeMandateCount = maker.activeMandateCount - 1;
    app.activeMandateCount = app.activeMandateCount - 1;
    maker.save();
    app.save();
  }
}

export function handlePulled(event: Pulled): void {
  const id = mandateId(event.params.maker, event.params.app, event.params.strategyHash);
  const mandate = Mandate.load(id);
  if (mandate === null) {
    // A pull against a strategy shipped before this subgraph's start block. Recording a
    // movement with no mandate would be worse than dropping it.
    return;
  }

  const balance = loadOrCreateBalance(mandate, event.params.token, event);
  balance.amount = balance.amount.minus(event.params.amount);
  balance.totalPulled = balance.totalPulled.plus(event.params.amount);
  balance.save();

  recordMovement(mandate, event.params.token, event.params.amount, "PULL", event);
}

export function handlePushed(event: Pushed): void {
  const id = mandateId(event.params.maker, event.params.app, event.params.strategyHash);
  const mandate = Mandate.load(id);
  if (mandate === null) {
    return;
  }

  const balance = loadOrCreateBalance(mandate, event.params.token, event);
  balance.amount = balance.amount.plus(event.params.amount);
  balance.totalPushed = balance.totalPushed.plus(event.params.amount);
  balance.save();

  recordMovement(mandate, event.params.token, event.params.amount, "PUSH", event);
}
