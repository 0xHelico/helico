// Package graph caches reads of a subgraph.
//
// It knows nothing about the schema, on purpose. The queries live in
// packages/plugins/thegraph, which is where this submission points for its Graph integration, and
// a second copy of them here — in another language, free to drift — would make that package no
// longer the answer to "what does Helico ask The Graph". What this adds is the one thing a
// browser cannot do on everyone's behalf: ask upstream less often than it is asked.
//
// The cache is in memory. That is right for one process, which is what we run, and wrong the
// moment there are two — at which point this is the shape Redis slots into, because the only
// state is a map of body hash to answer.
package graph

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// ErrRefused is a document this endpoint does not serve.
var ErrRefused = errors.New("that operation is not served here")

// maxEntries bounds the map. Each entry is one answer to one maker's question, so a few hundred
// is every wallet that will ever look at this in a week; past that the oldest go.
const maxEntries = 512

// maxAnswer is the largest upstream answer worth keeping. A mandate list is kilobytes.
const maxAnswer = 2 << 20

type Cache struct {
	url     string
	ttl     time.Duration
	allowed map[string]bool
	http    *http.Client
	nowFn   func() time.Time

	mu      sync.Mutex
	entries map[string]entry
}

type entry struct {
	body []byte
	at   time.Time
}

// New builds a cache in front of url, serving only the named operations.
func New(url string, ttl time.Duration, allowed []string, timeout time.Duration) *Cache {
	set := make(map[string]bool, len(allowed))
	for _, name := range allowed {
		set[name] = true
	}
	return &Cache{
		url:     url,
		ttl:     ttl,
		allowed: set,
		http:    &http.Client{Timeout: timeout},
		nowFn:   time.Now,
		entries: map[string]entry{},
	}
}

var operation = regexp.MustCompile(`(?m)^\s*(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)`)

// allow reports whether a document may be forwarded.
//
// One operation, of a name on the list, and nothing that writes. A subgraph has no mutations to
// call, so refusing them is not what closes anything — the allow-list is. Without it this is an
// open proxy onto our own rate limit, and the cheapest thing to spend is somebody else's quota.
func (c *Cache) allow(document string) error {
	found := operation.FindAllStringSubmatch(document, -1)
	if len(found) != 1 {
		return fmt.Errorf("%w: a document declares exactly one operation", ErrRefused)
	}
	if found[0][1] != "query" {
		return fmt.Errorf("%w: %s", ErrRefused, found[0][1])
	}
	if !c.allowed[found[0][2]] {
		return fmt.Errorf("%w: %s", ErrRefused, found[0][2])
	}
	return nil
}

// Query answers a GraphQL request body, from the cache when it can.
//
// The body is the key, hashed. Two callers asking the same question in the same words share one
// upstream request; asking it in different words does not, which is fine — the documents are
// constants in the client, not built per call.
func (c *Cache) Query(ctx context.Context, body []byte) (answer []byte, hit bool, err error) {
	var ask struct {
		Query string `json:"query"`
	}
	if err := json.Unmarshal(body, &ask); err != nil {
		return nil, false, fmt.Errorf("%w: not a GraphQL request", ErrRefused)
	}
	if err := c.allow(ask.Query); err != nil {
		return nil, false, err
	}

	sum := sha256.Sum256(body)
	key := hex.EncodeToString(sum[:])
	if cached, ok := c.get(key); ok {
		return cached, true, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader(body))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer res.Body.Close()
	fresh, err := io.ReadAll(io.LimitReader(res.Body, maxAnswer))
	if err != nil {
		return nil, false, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("subgraph: HTTP %d", res.StatusCode)
	}
	// A GraphQL error is a 200 with an `errors` key, and remembering one would serve a failure
	// for the whole TTL to everyone who asks. Pass it through; do not keep it.
	var maybe struct {
		Errors json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(fresh, &maybe) == nil && len(maybe.Errors) == 0 {
		c.put(key, fresh)
	}
	return fresh, false, nil
}

func (c *Cache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || c.nowFn().Sub(e.at) >= c.ttl {
		return nil, false
	}
	return e.body, true
}

func (c *Cache) put(key string, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.nowFn()
	if len(c.entries) >= maxEntries {
		for k, e := range c.entries {
			if now.Sub(e.at) >= c.ttl {
				delete(c.entries, k)
			}
		}
		// Still full: this is a cache, so dropping one live entry costs a request, not an answer.
		for k := range c.entries {
			if len(c.entries) < maxEntries {
				break
			}
			delete(c.entries, k)
		}
	}
	c.entries[key] = entry{body: body, at: now}
}

// TTL is how long an answer is served before it is asked for again.
func (c *Cache) TTL() time.Duration { return c.ttl }
