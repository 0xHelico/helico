-- When each event happened, beside what happened.
--
-- `eth_getLogs` does not carry a timestamp, so it is one `eth_getBlockByNumber` per block — and
-- exactly once per block ever, because a block's timestamp cannot change. Storing it here is what
-- makes that true: without the column the header would be fetched again on every read.
--
-- Zero means the endpoint would not say. The dapp renders that as no date rather than as 1970,
-- which is what a NULL-less STRICT table would otherwise invite.
ALTER TABLE account_activity ADD COLUMN block_time INTEGER NOT NULL DEFAULT 0;
