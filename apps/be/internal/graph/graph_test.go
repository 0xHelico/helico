package graph

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// upstream counts what actually reached the subgraph, which is the number this package exists to
// make smaller.
func upstream(t *testing.T, answer string) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func ask(t *testing.T, document string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"query":     document,
		"variables": map[string]any{"maker": "0xcdbde4f92af8be2117afae94f4ef3f5d3b3b39d8", "first": 1000},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

const movements = `
  query Movements($maker: Bytes!, $first: Int!) {
    movements(where: { mandate_: { maker: $maker } }) { timestamp }
  }
`

func TestTheSecondAskIsServedFromMemory(t *testing.T) {
	srv, calls := upstream(t, `{"data":{"movements":[{"timestamp":"1788668126"}]}}`)
	c := New(srv.URL, time.Minute, []string{"Movements"}, 5*time.Second)

	first, hit, err := c.Query(context.Background(), ask(t, movements))
	if err != nil {
		t.Fatal(err)
	}
	if hit {
		t.Error("the first ask cannot be a hit")
	}
	second, hit, err := c.Query(context.Background(), ask(t, movements))
	if err != nil {
		t.Fatal(err)
	}
	if !hit {
		t.Error("the second ask went upstream")
	}
	if string(first) != string(second) {
		t.Errorf("the cached answer differs: %q vs %q", first, second)
	}
	if got := calls.Load(); got != 1 {
		t.Errorf("upstream was asked %d times, want 1", got)
	}
}

func TestAnAnswerGoesStale(t *testing.T) {
	srv, calls := upstream(t, `{"data":{"movements":[]}}`)
	c := New(srv.URL, time.Minute, []string{"Movements"}, 5*time.Second)
	now := time.Unix(1_788_668_126, 0)
	c.nowFn = func() time.Time { return now }

	if _, _, err := c.Query(context.Background(), ask(t, movements)); err != nil {
		t.Fatal(err)
	}
	now = now.Add(59 * time.Second)
	if _, hit, _ := c.Query(context.Background(), ask(t, movements)); !hit {
		t.Error("an answer 59 seconds into a minute should still be served")
	}
	now = now.Add(2 * time.Second)
	if _, hit, _ := c.Query(context.Background(), ask(t, movements)); hit {
		t.Error("an answer past its TTL was served anyway")
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("upstream was asked %d times, want 2", got)
	}
}

// The allow-list is the whole of what stops this being an open proxy onto our own quota, so it is
// checked from the outside: not "does it return an error", but "did anything reach upstream".
func TestARefusedDocumentNeverReachesUpstream(t *testing.T) {
	srv, calls := upstream(t, `{"data":{}}`)
	c := New(srv.URL, time.Minute, []string{"Movements"}, 5*time.Second)

	for _, d := range []struct {
		name     string
		document string
	}{
		{"an operation not on the list", "query Everything { mandates { id } }"},
		{"a write", "mutation Drop($id: ID!) { delete(id: $id) }"},
		{"two operations, one of them allowed", movements + "\nquery Everything { mandates { id } }"},
		{"no operation at all", "{ mandates { id } }"},
	} {
		t.Run(d.name, func(t *testing.T) {
			_, _, err := c.Query(context.Background(), ask(t, d.document))
			if err == nil {
				t.Fatal("forwarded")
			}
		})
	}
	if got := calls.Load(); got != 0 {
		t.Errorf("upstream was asked %d times, want 0", got)
	}
}

// A GraphQL failure is a 200 with an `errors` key. Keeping one would serve the failure to
// everybody for the whole TTL, which turns a blip into a minute of outage.
func TestAFailureIsPassedOnAndNotKept(t *testing.T) {
	srv, calls := upstream(t, `{"errors":[{"message":"indexing error"}]}`)
	c := New(srv.URL, time.Minute, []string{"Movements"}, 5*time.Second)

	for i := range 2 {
		answer, hit, err := c.Query(context.Background(), ask(t, movements))
		if err != nil {
			t.Fatal(err)
		}
		if hit {
			t.Errorf("ask %d was served a remembered failure", i+1)
		}
		if !json.Valid(answer) {
			t.Errorf("the caller did not get the subgraph's own answer: %q", answer)
		}
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("upstream was asked %d times, want 2", got)
	}
}
