-- Posts, with the rendered HTML stored beside the Markdown so a read never renders.
-- Timestamps are Unix seconds; the listing index matches the newest-first keyset query.
CREATE TABLE IF NOT EXISTS posts (
    slug            TEXT    PRIMARY KEY,
    title           TEXT    NOT NULL,
    summary         TEXT    NOT NULL DEFAULT '',
    author          TEXT    NOT NULL,
    cover           TEXT    NOT NULL DEFAULT '',
    tags            TEXT    NOT NULL DEFAULT '[]',
    markdown        TEXT    NOT NULL,
    html            TEXT    NOT NULL,
    reading_minutes INTEGER NOT NULL,
    published_at    INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS posts_published ON posts (published_at DESC, slug DESC);
