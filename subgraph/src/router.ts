import { Swapped } from "../generated/AquaSwapVMRouter/AquaSwapVMRouter";
import { Fill, Maker } from "../generated/schema";

/**
 * A fill through 1inch's SwapVM router — the fifth of the five events their own Aqua documentation
 * asks an indexer to cover, and the one this subgraph did not have.
 *
 * **What is written and what is deliberately not.** `Swapped` carries `orderHash`, which is the
 * router's identifier for the order it executed. It is *not* the `strategyHash` everything else
 * here is keyed on, and it is not derivable from the event. So there is no edge from `Fill` to
 * `Mandate`: a join on two hashes that are not the same hash would be a lie that reads as data.
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
