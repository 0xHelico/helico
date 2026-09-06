-- Conversations belong to an address. Every query carries the owner, so a row belonging to
-- someone else is not found rather than found-and-refused.
-- Timestamps are Unix seconds, matching the posts table.
CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT    PRIMARY KEY,
    owner      TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

-- The sidebar's query: this owner's conversations, most recent activity first.
CREATE INDEX IF NOT EXISTS conversations_owner ON conversations (owner, updated_at DESC, id DESC);

-- `seq` orders the turns, not `created_at`. A question and its answer land in the same second
-- routinely, and ordering by a second-resolution timestamp with a random id as the tiebreak
-- puts the answer before the question about half the time.
CREATE TABLE IF NOT EXISTS chat_messages (
    id              TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    role            TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    intent          TEXT    NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_conversation
    ON chat_messages (conversation_id, seq);
