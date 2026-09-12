import { Swapped } from "../generated/AquaSwapVMRouter/AquaSwapVMRouter";
import { Fill, Maker } from "../generated/schema";

/**
 * A fill through 1inch's SwapVM router — the fifth of the five events their own Aqua documentation
 * asks an indexer to cover, and the one this subgraph did not have.
 *
 * **`orderHash` is the `strategyHash`.** For an order that settles through Aqua, SwapVM hashes
 * `keccak256(abi.encode(order))`, and the bytes the maker shipped to Aqua are that encoding, so
 * Aqua's `strategyHash` is the same number (1inch, Aqua → Data & Analytics; measured 12 September:
 * 60 of 60 distinct `orderHash` values on Arbitrum One match a shipped mandate). An earlier
 * version of this comment said they differed and drew no edge for that reason. The edge is still
 * not drawn, now for a smaller reason: it is a schema change, and the deployed version is kept as
 * it is until after the hackathon. Join on `fills.orderHash == mandates.strategyHash` meanwhile.
 * The maker edge is real, because the event carries the address.
 *
 * `Maker` is created here when it does not exist. A fill against a maker whose `Shipped` predates
 * this data source's start block is a real fill, and dropping it to keep the entity tidy would
 * lose a row to protect a counter.
 */
export function handleSwapped(event: Swapped): void {
  let maker = Maker.load(event.params.maker);
  if (maker === null) {
    maker = new Maker(event.params.maker);
    maker.mandateCount = 0;
    maker.activeMandateCount = 0;
    maker.fillCount = 0;
  }
  maker.fillCount = maker.fillCount + 1;
  maker.save();

  // The transaction hash alone is not unique: one transaction may fill several orders, and the
  // router emits one event per fill. The log index is what separates them.
  const fill = new Fill(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
  );
  fill.maker = maker.id;
  fill.taker = event.params.taker;
  fill.orderHash = event.params.orderHash;
  fill.tokenIn = event.params.tokenIn;
  fill.tokenOut = event.params.tokenOut;
  fill.amountIn = event.params.amountIn;
  fill.amountOut = event.params.amountOut;
  fill.timestamp = event.block.timestamp;
  fill.block = event.block.number;
  fill.tx = event.transaction.hash;
  fill.save();
}
