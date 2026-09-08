import { AccountOpened } from "../generated/HelicoAccountFactory/HelicoAccountFactory";
import { Account } from "../generated/schema";

/**
 * One entity per account, written once.
 *
 * `immutable: true` in the schema is the honest shape: an account's owner is an `immutable` in
 * the proxy's bytecode, and `open` is idempotent — it returns the existing address rather than
 * redeploying — so nothing here can ever be updated. A mutable entity would invite a handler
 * that pretends otherwise.
 *
 * The account address is not read from the event's second parameter for safety, it is read
 * because it is the same thing: `accountFor` and `open` compute it from the same salt and init
 * code, and `DeployAccountFactory` asserts that at deploy time inside a state snapshot.
 */
export function handleAccountOpened(event: AccountOpened): void {
  const account = new Account(event.params.account);
  account.owner = event.params.owner;
  account.openedAt = event.block.timestamp;
  account.openedAtBlock = event.block.number;
  account.openedTx = event.transaction.hash;
  account.save();
}
