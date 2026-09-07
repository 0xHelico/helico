import {
  assert, describe, test, clearStore, afterEach, newMockEvent, createMockedFunction,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import { Docked, Pulled, Pushed, Shipped } from "../generated/Aqua/Aqua";
import { handleDocked, handlePulled, handlePushed, handleShipped } from "../src/aqua";

const MAKER = "0xf54ec0f6996b46b71b8d0c05f8430d2e8ed9413c";
const APP = "0x2060e888ec465bc70b05c84b53d99bfbfd058821";
const HASH = "0x1702625f0d2530e39093ab2c5ac3b62ec2e00272b0fdc76dac2d6ebcb7defb17";
const ARB = "0x912ce59144191c1204e64559fe8253a0e49e6548";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

function mandateId(): string {
  return MAKER + APP.slice(2) + HASH.slice(2);
}
function balanceId(token: string): string {
  return mandateId() + token.slice(2);
}

function shipped(strategy: string): Shipped {
  const e = changetype<Shipped>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER))));
  e.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP))));
  e.parameters.push(new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HASH))));
  e.parameters.push(new ethereum.EventParam("strategy", ethereum.Value.fromBytes(Bytes.fromHexString(strategy))));
  return e;
}
function docked(): Docked {
  const e = changetype<Docked>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER))));
  e.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP))));
  e.parameters.push(new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HASH))));
  return e;
}
function pushed(token: string, amount: string): Pushed {
  const e = changetype<Pushed>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER))));
  e.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP))));
  e.parameters.push(new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HASH))));
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(Address.fromString(token))));
  e.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString(amount))));
  return e;
}
function pulled(token: string, amount: string): Pulled {
  const e = changetype<Pulled>(newMockEvent());
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER))));
  e.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP))));
  e.parameters.push(new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(Bytes.fromHexString(HASH))));
  e.parameters.push(new ethereum.EventParam("token", ethereum.Value.fromAddress(Address.fromString(token))));
  e.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(BigInt.fromString(amount))));
  return e;
}

/**
 * `tokensCount` is read from the contract, so every test has to say what the ledger would
 * answer. That is not scaffolding — it is the point. The handlers used to trust the event, and
 * trusting the event is what made them wrong.
 *
 * 0 = never shipped, 1..254 = active, 255 = docked.
 */
function mockLedger(token: string, amount: string, tokensCount: i32): void {
  createMockedFunction(
    newMockEvent().address,
    "rawBalances",
    "rawBalances(address,address,bytes32,address):(uint248,uint8)",
  )
    .withArgs([
      ethereum.Value.fromAddress(Address.fromString(MAKER)),
      ethereum.Value.fromAddress(Address.fromString(APP)),
      ethereum.Value.fromFixedBytes(Bytes.fromHexString(HASH)),
      ethereum.Value.fromAddress(Address.fromString(token)),
    ])
    .returns([
      ethereum.Value.fromUnsignedBigInt(BigInt.fromString(amount)),
      ethereum.Value.fromI32(tokensCount),
    ]);
}

describe("Aqua handlers", () => {
  afterEach(() => {
    clearStore();
  });

  test("a ship and its pushes land, keyed by maker, app and hash together", () => {
    mockLedger(ARB, "1000000000000000000", 2);
    mockLedger(USDC, "1000000", 2);

    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(ARB, "1000000000000000000"));
    handlePushed(pushed(USDC, "1000000"));

    assert.entityCount("Mandate", 1);
    assert.entityCount("Balance", 2);
    assert.fieldEquals("Balance", balanceId(ARB), "amount", "1000000000000000000");
    assert.fieldEquals("Balance", balanceId(USDC), "amount", "1000000");
    assert.fieldEquals("Balance", balanceId(ARB), "tokensCount", "2");
    assert.fieldEquals("Mandate", mandateId(), "active", "true");
    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "1");
  });

  test("docking zeroes the balance, because the chain did", () => {
    mockLedger(ARB, "1000000000000000000", 1);
    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(ARB, "1000000000000000000"));

    // What Aqua's ledger says after `dock`: zeroed, and flagged 255.
    mockLedger(ARB, "0", 255);
    handleDocked(docked());

    assert.fieldEquals("Mandate", mandateId(), "active", "false");
    assert.fieldEquals("Balance", balanceId(ARB), "amount", "0");
    assert.fieldEquals("Balance", balanceId(ARB), "tokensCount", "255");
    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "0");
  });

  test("an empty dock revokes nothing, and the mandate stays live", () => {
    mockLedger(ARB, "1000", 1);
    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(ARB, "1000"));

    // `dock` emits Docked outside its loop, so an empty token array revokes nothing. The ledger
    // is unchanged, and that is the only thing the handler is allowed to believe.
    handleDocked(docked());

    assert.fieldEquals("Mandate", mandateId(), "active", "true");
    assert.fieldEquals("Balance", balanceId(ARB), "amount", "1000");
    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "1");
  });

  test("a partial dock leaves the mandate live on the tokens it did not close", () => {
    mockLedger(ARB, "1000", 1);
    mockLedger(USDC, "2000", 1);
    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(ARB, "1000"));
    handlePushed(pushed(USDC, "2000"));

    // ARB closed, USDC still spendable — permitted, because a mandate shipped with disjoint
    // token sets docks one subset at a time.
    mockLedger(ARB, "0", 255);
    handleDocked(docked());

    assert.fieldEquals("Balance", balanceId(ARB), "tokensCount", "255");
    assert.fieldEquals("Balance", balanceId(USDC), "tokensCount", "1");
    assert.fieldEquals("Mandate", mandateId(), "active", "true");
    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "1");
  });

  test("re-shipping the same hash with a disjoint token counts one mandate, not two", () => {
    mockLedger(ARB, "10", 1);
    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(ARB, "10"));
    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "1");

    mockLedger(USDC, "30", 1);
    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(USDC, "30"));

    assert.entityCount("Mandate", 1);
    assert.fieldEquals("Maker", MAKER, "mandateCount", "1");
    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "1");
    assert.fieldEquals("App", APP, "activeMandateCount", "1");
  });

  test("a second Docked does not decrement twice", () => {
    mockLedger(ARB, "1000", 1);
    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(ARB, "1000"));

    mockLedger(ARB, "0", 255);
    handleDocked(docked());
    handleDocked(docked());

    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "0");
  });

  test("a pull naming a mandate we never saw shipped is dropped", () => {
    // `pull` takes `maker` as an argument rather than using msg.sender and has no active-strategy
    // guard, so anyone can emit `Pulled` naming any maker. Recording those would be an
    // unauthenticated way to write rows into this index.
    handlePulled(pulled(ARB, "1"));

    assert.entityCount("Mandate", 0);
    assert.entityCount("Movement", 0);
    assert.entityCount("Balance", 0);
  });

  test("a movement is recorded once per log, and counted", () => {
    mockLedger(ARB, "1000", 1);
    handleShipped(shipped("0xdeadbeef"));
    handlePushed(pushed(ARB, "1000"));
    handlePulled(pulled(ARB, "400"));

    assert.fieldEquals("Balance", balanceId(ARB), "amount", "600");
    assert.fieldEquals("Balance", balanceId(ARB), "totalPushed", "1000");
    assert.fieldEquals("Balance", balanceId(ARB), "totalPulled", "400");
    assert.fieldEquals("Mandate", mandateId(), "movementCount", "2");
  });
});
