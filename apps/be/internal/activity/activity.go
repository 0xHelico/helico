// Package activity reads what a Helico account did, from the account's own logs, and remembers it.
//
// **Why this is not a cache.** `/api/graph` in front of the subgraph is a cache: the same question
// gets the same answer for a TTL and then is asked again. An account's log is append-only, so once
// this has read up to block N it never needs to read below N again. What is kept is not a copy of
// an answer, it is the answer so far plus a watermark — which is why the second read of a busy
// account costs one narrow `eth_getLogs` instead of a scan over twenty-three million blocks.
//
// The browser was doing that scan, per visitor, on every page load. Three `eth_getLogs` calls each
// spanning from the factory's deployment to the head, against a public endpoint shared by everyone.
// It worked and it will not keep working.
//
// **What it does not do:** interpret. The rows are the fields of the events, and the sentences are
// composed in the dapp where the copy lives. A second set of English in another language, free to
// drift from the first, is the thing `graph.go` refuses for the same reason.
package activity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// The three events `HelicoAccount` emits that say something a person would want to read. Keccak of
// the signature, computed once and asserted in the tests against the values the chain actually
// carries — a topic typed from memory is a filter that silently matches nothing.
const (
	TopicIdleCapitalMoved = "0x31b0a7503f02d1d00b2290939640f339abd3c47aa9e41dd6fcc7fa17f2d3cad3"
	TopicAgentChanged     = "0x4a2e63eb36ad3c667a1d8d1b18dfbf37d06f96b46b82b526a855175916515add"
	TopicVenuePermitted   = "0xdae93fbd597062922eea00db27bacf375a602e285a1a9eb57639838a5ac75182"
)

// Kind names an event without repeating its topic downstream.
type Kind string

const (
	KindMoved   Kind = "moved"
	KindAgent   Kind = "agent"
	KindVenue   Kind = "venue"
	KindUnknown Kind = "unknown"
)

// Event is one thing the account did. The fields are the log's, not a sentence about it.
type Event struct {
	Block uint64 `json:"block"`
	// BlockTime is Unix seconds. Fetched once per block and kept for ever: a block's timestamp
	// cannot change, so this is the one field here that never needs re-reading. Zero when the
	// endpoint would not say, which the dapp renders as no date rather than as 1970.
	BlockTime uint64 `json:"blockTime"`
	LogIndex  uint64 `json:"logIndex"`
	Kind      Kind   `json:"kind"`
	Tx        string `json:"tx"`
	// Pool is set for moved and venue. Asset and Amount for moved only.
	Pool   string `json:"pool,omitempty"`
	Asset  string `json:"asset,omitempty"`
	Amount string `json:"amount,omitempty"`
	// Supplied distinguishes a move in from a move out; Allowed a permit from a revoke.
	Supplied bool `json:"supplied,omitempty"`
	Allowed  bool `json:"allowed,omitempty"`
	// Agent is set for agent; the zero address means the permission was taken away.
	Agent string `json:"agent,omitempty"`
}

// ErrBadAddress is an address that is not twenty bytes of hex.
var ErrBadAddress = errors.New("that is not an address")

// Normalise lower-cases an address and refuses anything that is not one. Addresses are a primary
// key here, and `0xAbC…` and `0xabc…` being two rows is a bug that looks like duplicate history.
func Normalise(address string) (string, error) {
	a := strings.ToLower(strings.TrimSpace(address))
	if len(a) != 42 || !strings.HasPrefix(a, "0x") {
		return "", ErrBadAddress
	}
	for _, c := range a[2:] {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return "", ErrBadAddress
		}
	}
	return a, nil
}

// Reader fetches logs. Small enough that a test hands over a struct instead of a server.
type Reader interface {
	Logs(ctx context.Context, address string, from, to uint64) ([]Event, error)
	Head(ctx context.Context) (uint64, error)
	// Times answers the timestamp of each block named, skipping any it cannot.
	Times(ctx context.Context, blocks []uint64) (map[uint64]uint64, error)
}

// RPC reads an EVM endpoint over JSON-RPC.
type RPC struct {
	url  string
	http *http.Client
}

// NewRPC builds a reader against url.
func NewRPC(url string, timeout time.Duration) *RPC {
	return &RPC{url: url, http: &http.Client{Timeout: timeout}}
}

type rpcRequest struct {
	ID      int    `json:"id"`
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcError struct {
	Message string `json:"message"`
}

type rawLog struct {
	Address     string   `json:"address"`
	Topics      []string `json:"topics"`
	Data        string   `json:"data"`
	BlockNumber string   `json:"blockNumber"`
	LogIndex    string   `json:"logIndex"`
	TxHash      string   `json:"transactionHash"`
}

func (c *RPC) call(ctx context.Context, method string, params []any, out any) error {
	body, err := json.Marshal(rpcRequest{ID: 1, JSONRPC: "2.0", Method: method, Params: params})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// Bounded, because an endpoint that answers a wide range can answer with megabytes.
	payload, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}
	var envelope struct {
		Error  *rpcError       `json:"error"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	// **The error is returned rather than dropped.** A pruned node answers "missing trie node"
	// with HTTP 200, and a helper that reads that as an empty result reports an account with no
	// history instead of an endpoint that cannot answer.
	if envelope.Error != nil {
		return fmt.Errorf("%s: %s", method, envelope.Error.Message)
	}
	return json.Unmarshal(envelope.Result, out)
}

// Head is the latest block the endpoint knows about.
func (c *RPC) Head(ctx context.Context) (uint64, error) {
	var hex string
	if err := c.call(ctx, "eth_blockNumber", []any{}, &hex); err != nil {
		return 0, err
	}
	return parseHex(hex)
}

// Logs returns the account's three events between from and to, inclusive.
func (c *RPC) Logs(ctx context.Context, address string, from, to uint64) ([]Event, error) {
	var raw []rawLog
	err := c.call(ctx, "eth_getLogs", []any{map[string]any{
		"address":   address,
		"fromBlock": "0x" + strconv.FormatUint(from, 16),
		"toBlock":   "0x" + strconv.FormatUint(to, 16),
		"topics": []any{[]string{
			TopicIdleCapitalMoved, TopicAgentChanged, TopicVenuePermitted,
		}},
	}}, &raw)
	if err != nil {
		return nil, err
	}
	events := make([]Event, 0, len(raw))
	for _, l := range raw {
		e, ok := decode(l)
		if ok {
			events = append(events, e)
		}
	}
	return events, nil
}

// Times reads one block header per number, which is the only way to get a log's timestamp:
// `eth_getLogs` does not carry one. Called once per block ever, because the answer is immutable
// and the row it fills is written to the database beside the event.
func (c *RPC) Times(ctx context.Context, blocks []uint64) (map[uint64]uint64, error) {
	out := make(map[uint64]uint64, len(blocks))
	for _, b := range blocks {
		var header struct {
			Timestamp string `json:"timestamp"`
		}
		// `false` asks for hashes rather than whole transactions: a busy block is megabytes of
		// data for one field.
		if err := c.call(ctx, "eth_getBlockByNumber",
			[]any{"0x" + strconv.FormatUint(b, 16), false}, &header); err != nil {
			// One block that will not answer is a missing date, not a failed read.
			continue
		}
		if t, err := parseHex(header.Timestamp); err == nil {
			out[b] = t
		}
	}
	return out, nil
}

func parseHex(s string) (uint64, error) {
	return strconv.ParseUint(strings.TrimPrefix(s, "0x"), 16, 64)
}

// word reads the nth 32-byte word of a hex data field.
func word(data string, n int) string {
	d := strings.TrimPrefix(data, "0x")
	if len(d) < (n+1)*64 {
		return ""
	}
	return d[n*64 : (n+1)*64]
}

func addressFromWord(w string) string {
	if len(w) != 64 {
		return ""
	}
	return "0x" + strings.ToLower(w[24:])
}

// decode turns one log into an Event, or says it is not one of ours.
//
// The indexed parameters are topics and the rest is data, so each field is read from where the ABI
// puts it rather than from a position in a flat list. A log whose shape does not match is dropped:
// this filters on topic0, and a contract that reuses one of these signatures with different
// parameters would otherwise be read as if it were an account of ours.
func decode(l rawLog) (Event, bool) {
	if len(l.Topics) == 0 {
		return Event{}, false
	}
	block, err := parseHex(l.BlockNumber)
	if err != nil {
		return Event{}, false
	}
	index, err := parseHex(l.LogIndex)
	if err != nil {
		return Event{}, false
	}
	e := Event{Block: block, LogIndex: index, Tx: strings.ToLower(l.TxHash)}
	switch strings.ToLower(l.Topics[0]) {
	case TopicIdleCapitalMoved:
		if len(l.Topics) != 3 {
			return Event{}, false
		}
		amount, ok := new(big.Int).SetString(strings.TrimPrefix(word(l.Data, 0), ""), 16)
		if !ok {
			return Event{}, false
		}
		e.Kind = KindMoved
		e.Pool = addressFromWord(strings.TrimPrefix(l.Topics[1], "0x"))
		e.Asset = addressFromWord(strings.TrimPrefix(l.Topics[2], "0x"))
		e.Amount = amount.String()
		e.Supplied = strings.HasSuffix(word(l.Data, 1), "1")
	case TopicAgentChanged:
		if len(l.Topics) != 2 {
			return Event{}, false
		}
		e.Kind = KindAgent
		e.Agent = addressFromWord(strings.TrimPrefix(l.Topics[1], "0x"))
	case TopicVenuePermitted:
		if len(l.Topics) != 2 {
			return Event{}, false
		}
		e.Kind = KindVenue
		e.Pool = addressFromWord(strings.TrimPrefix(l.Topics[1], "0x"))
		e.Allowed = strings.HasSuffix(word(l.Data, 0), "1")
	default:
		return Event{}, false
	}
	return e, true
}
