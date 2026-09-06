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

CREATE TABLE IF NOT EXISTS chat_messages (
    id              TEXT    PRIMARY KEY,
    conversation_id TEXT    NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role            TEXT    NOT NULL,
    body            TEXT    NOT NULL,
    intent          TEXT    NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS chat_messages_conversation
    ON chat_messages (conversation_id, created_at, id);
