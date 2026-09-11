-- What an account did, and how far its log has been read.
--
-- **Append-only, which is why this is a table rather than a cache.** An account's history never
-- changes below the head, so once `cursor` says block N has been read, the rows below it are final
-- and the next read starts at N+1. That turns a scan over twenty-three million blocks, which every
-- visitor was paying for on every page load, into one narrow query.
--
-- The primary key is (account, block, log_index) rather than the transaction hash: one transaction
-- may emit several of these — the onboarding batch emits five — and keyed on the hash alone four of
-- them would overwrite each other and the count would disagree with the rows.
CREATE TABLE IF NOT EXISTS account_activity (
    account   TEXT    NOT NULL,
    block     INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    kind      TEXT    NOT NULL,
    tx        TEXT    NOT NULL,
    pool      TEXT    NOT NULL DEFAULT '',
    asset     TEXT    NOT NULL DEFAULT '',
    amount    TEXT    NOT NULL DEFAULT '',
    supplied  INTEGER NOT NULL DEFAULT 0,
    allowed   INTEGER NOT NULL DEFAULT 0,
    agent     TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (account, block, log_index)
) STRICT;

-- Newest first, which is the only order this is ever read in.
CREATE INDEX IF NOT EXISTS account_activity_recent
    ON account_activity (account, block DESC, log_index DESC);

-- One row per account. `read_to` is the last block whose logs are in the table above; `checked_at`
-- is when that was established, so a second visitor inside the window is served without a call.
CREATE TABLE IF NOT EXISTS account_activity_cursor (
    account    TEXT    PRIMARY KEY,
    read_to    INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
) STRICT;
