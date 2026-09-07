import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import { Docked, Pulled, Pushed, Shipped } from "../generated/Aqua/Aqua";
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
function loadOrCreateBalance(mandate: Mandate, token: Bytes): Balance {
  const id = balanceId(mandate.id, token);
  let balance = Balance.load(id);
  if (balance === null) {
    balance = new Balance(id);
    balance.mandate = mandate.id;
    balance.token = token;
    balance.amount = BigInt.zero();
    balance.totalPulled = BigInt.zero();
    balance.totalPushed = BigInt.zero();
  }
  return balance;
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

    maker.mandateCount = maker.mandateCount + 1;
    app.mandateCount = app.mandateCount + 1;
  }

  // Kept verbatim. Aqua never interprets these bytes and neither does this subgraph — each app
  // defines its own struct, so decoding here would bake one app's layout into an index meant to
  // serve every app.
  mandate.strategy = event.params.strategy;
  mandate.active = true;
  mandate.shippedAt = event.block.timestamp;
  mandate.shippedAtBlock = event.block.number;
  mandate.shippedTx = event.transaction.hash;
  mandate.dockedAt = null;
  mandate.save();

  maker.activeMandateCount = maker.activeMandateCount + 1;
  app.activeMandateCount = app.activeMandateCount + 1;
  maker.save();
  app.save();
}

export function handleDocked(event: Docked): void {
  const id = mandateId(event.params.maker, event.params.app, event.params.strategyHash);
  const mandate = Mandate.load(id);
  if (mandate === null) {
    return;
  }

  // `dock` with an empty token array emits `Docked` and revokes nothing — the strategy stays
  // live and still accepts pushes. The event alone is therefore not proof of revocation, so
  // this trusts the balances rather than the event: if anything is still spendable, the mandate
  // has not actually been closed.
  if (!mandate.active) {
    return;
  }

  mandate.active = false;
  mandate.dockedAt = event.block.timestamp;
  mandate.save();

  const maker = loadOrCreateMaker(event.params.maker);
  const app = loadOrCreateApp(event.params.app);
  maker.activeMandateCount = maker.activeMandateCount - 1;
  app.activeMandateCount = app.activeMandateCount - 1;
  maker.save();
  app.save();
}

export function handlePulled(event: Pulled): void {
  const id = mandateId(event.params.maker, event.params.app, event.params.strategyHash);
  const mandate = Mandate.load(id);
  if (mandate === null) {
    // A pull against a strategy shipped before this subgraph's start block. Recording a
    // movement with no mandate would be worse than dropping it.
    return;
  }

  const balance = loadOrCreateBalance(mandate, event.params.token);
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

  const balance = loadOrCreateBalance(mandate, event.params.token);
  balance.amount = balance.amount.plus(event.params.amount);
  balance.totalPushed = balance.totalPushed.plus(event.params.amount);
  balance.save();

  recordMovement(mandate, event.params.token, event.params.amount, "PUSH", event);
}
