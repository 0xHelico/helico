package blog

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Cursor marks where a page of the newest-first listing stopped: the last item's time and
// slug, which together are unique. Keyset pagination, so a page costs one indexed range scan
// however far in it sits.
type Cursor struct {
	PublishedAt time.Time
	Slug        string
}

// IsZero reports an absent cursor, the first page.
func (c Cursor) IsZero() bool { return c.Slug == "" }

// Encode makes the cursor an opaque, URL-safe string.
func (c Cursor) Encode() string {
	raw := strconv.FormatInt(c.PublishedAt.Unix(), 10) + "|" + c.Slug
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// DecodeCursor parses what Encode produced. An empty string is the first page.
func DecodeCursor(s string) (Cursor, error) {
	if s == "" {
		return Cursor{}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return Cursor{}, fmt.Errorf("cursor: %w", err)
	}
	at, slug, ok := strings.Cut(string(raw), "|")
	if !ok {
		return Cursor{}, fmt.Errorf("cursor: malformed")
	}
	unix, err := strconv.ParseInt(at, 10, 64)
	if err != nil {
		return Cursor{}, fmt.Errorf("cursor: %w", err)
	}
	if err := ValidateSlug(slug); err != nil {
		return Cursor{}, fmt.Errorf("cursor: %w", err)
	}
	return Cursor{PublishedAt: time.Unix(unix, 0).UTC(), Slug: slug}, nil
}
