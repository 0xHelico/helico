import {
  afterEach, assert, clearStore, describe, newMockEvent, test,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";

import { Swapped } from "../generated/AquaSwapVMRouter/AquaSwapVMRouter";
import { Shipped } from "../generated/Aqua/Aqua";
import { handleShipped } from "../src/aqua";
import { handleSwapped } from "../src/router";

const MAKER = "0xcdbde4f92af8be2117afae94f4ef3f5d3b3b39d8";
const TAKER = "0x1111111254eeb25477b68fb85ed929f73a960582";
const APP = "0x111111338c5091e8440b67b168bae16a668ac0de";
const ORDER = "0xb3e3120b63dabfc5008cee84b5d74454b3d44269ee1cb35641fc90065edf9a44";
const STRATEGY_HASH = "0x1702625f0d2530e39093ab2c5ac3b62ec2e00272b0fdc76dac2d6ebcb7defb17";
const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

function swapped(logIndex: i32, amountIn: string, amountOut: string): Swapped {
  const e = changetype<Swapped>(newMockEvent());
  e.logIndex = BigInt.fromI32(logIndex);
  e.parameters = new Array<ethereum.EventParam>();
  e.parameters.push(new ethereum.EventParam("orderHash", ethereum.Value.fromFixedBytes(Bytes.fromHexString(ORDER))));
  e.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER))));
  e.parameters.push(new ethereum.EventParam("taker", ethereum.Value.fromAddress(Address.fromString(TAKER))));
  e.parameters.push(new ethereum.EventParam("tokenIn", ethereum.Value.fromAddress(Address.fromString(WETH))));
  e.parameters.push(new ethereum.EventParam("tokenOut", ethereum.Value.fromAddress(Address.fromString(USDC))));
  e.parameters.push(new ethereum.EventParam("amountIn", ethereum.Value.fromUnsignedBigInt(BigInt.fromString(amountIn))));
  e.parameters.push(new ethereum.EventParam("amountOut", ethereum.Value.fromUnsignedBigInt(BigInt.fromString(amountOut))));
  return e;
}

function fillId(e: Swapped): string {
  return e.transaction.hash.concatI32(e.logIndex.toI32()).toHexString();
}

describe("Swapped, the fifth event", () => {
  afterEach(clearStore);

  test("writes what the log carries, and nothing it does not", () => {
    const e = swapped(0, "10000000000000000", "24660613");
    handleSwapped(e);

    const id = fillId(e);
    assert.fieldEquals("Fill", id, "maker", MAKER);
    assert.fieldEquals("Fill", id, "taker", TAKER);
    assert.fieldEquals("Fill", id, "orderHash", ORDER);
    assert.fieldEquals("Fill", id, "tokenIn", WETH);
    assert.fieldEquals("Fill", id, "tokenOut", USDC);
    assert.fieldEquals("Fill", id, "amountIn", "10000000000000000");
    assert.fieldEquals("Fill", id, "amountOut", "24660613");
    assert.entityCount("Fill", 1);
  });

  test("keeps a maker whose first appearance is a fill, rather than dropping the row", () => {
    // A fill against a maker who shipped before this data source's start block is a real fill.
    // Dropping it to keep the entity tidy would lose a row to protect a counter.
    handleSwapped(swapped(0, "1", "2"));
    assert.fieldEquals("Maker", MAKER, "fillCount", "1");
    assert.fieldEquals("Maker", MAKER, "mandateCount", "0");
    assert.entityCount("Maker", 1);
  });

  test("counts two fills in one transaction separately", () => {
    // The transaction hash alone is not unique: one transaction may fill several orders and the
    // router emits one event per fill. Keyed on the hash alone, the second would overwrite the
    // first and the count would disagree with the rows.
    handleSwapped(swapped(0, "1", "2"));
    handleSwapped(swapped(7, "3", "4"));
    assert.entityCount("Fill", 2);
    assert.fieldEquals("Maker", MAKER, "fillCount", "2");
  });

  test("does not disturb a maker that already shipped", () => {
    const ship = changetype<Shipped>(newMockEvent());
    ship.parameters = new Array<ethereum.EventParam>();
    ship.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString(MAKER))));
    ship.parameters.push(new ethereum.EventParam("app", ethereum.Value.fromAddress(Address.fromString(APP))));
    ship.parameters.push(new ethereum.EventParam("strategyHash", ethereum.Value.fromFixedBytes(Bytes.fromHexString(STRATEGY_HASH))));
    ship.parameters.push(new ethereum.EventParam("strategy", ethereum.Value.fromBytes(Bytes.fromHexString("0x00"))));
    handleShipped(ship);
    assert.fieldEquals("Maker", MAKER, "mandateCount", "1");
    assert.fieldEquals("Maker", MAKER, "fillCount", "0");

    handleSwapped(swapped(0, "1", "2"));
    // The fill counter moves and the mandate counters do not. They are different questions and a
    // handler that touched both would make "how many strategies" depend on how many fills.
    assert.fieldEquals("Maker", MAKER, "fillCount", "1");
    assert.fieldEquals("Maker", MAKER, "mandateCount", "1");
    assert.fieldEquals("Maker", MAKER, "activeMandateCount", "1");
  });
});
