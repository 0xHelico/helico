package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	"github.com/0xHelico/helico/apps/be/internal/activity"
)

// Chain is the narrow slice of an EVM endpoint this needs: one `eth_call`.
type Chain interface {
	Call(ctx context.Context, to, data string) (string, error)
}

// Log is what answers "how often has the agent moved this". `activity.Service` satisfies it, so
// the bot reads the same append-only history the dapp does rather than scanning the chain again.
type Log interface {
	For(ctx context.Context, account string) (activity.Result, error)
}

// OnChain answers from the chain and from the account log.
//
// **The account is derived, not asked for.** Somebody types their own address; the account is what
// the factory says it is for that owner. Asking a person for an account address they have never
// seen would be asking them to know an implementation detail.
type OnChain struct {
	chain   Chain
	log     Log
	factory string
	usdc    string
	// receipts are the tokens a market issues for USDC. Their balances are the working side.
	receipts []string
}

// NewOnChain builds a reader. `factory`, `usdc` and `receipts` are addresses; the caller owns
// which chain they are on.
func NewOnChain(chain Chain, log Log, factory, usdc string, receipts []string) *OnChain {
	return &OnChain{chain: chain, log: log, factory: factory, usdc: usdc, receipts: receipts}
}

// `accountFor(address)` and `balanceOf(address)`, as calldata.
//
// **Asserted in the tests against the values the chain carries.** The first version of this had
// `accountFor` as `0x9c8b40c6`, typed from memory, which is a selector for nothing — and a wrong
// selector on a contract with no fallback is a revert that reads as "no account for that address",
// which is a sentence a person would have believed.
const (
	selAccountFor = "0x7ce38c39"
	selBalanceOf  = "0x70a08231"
)

func padded(address string) string {
	a := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(address)), "0x")
	return strings.Repeat("0", 64-len(a)) + a
}

func wordToAddress(hex string) string {
	h := strings.TrimPrefix(hex, "0x")
	if len(h) < 64 {
		return ""
	}
	return "0x" + h[24:64]
}

func wordToUint(hex string) (uint64, error) {
	h := strings.TrimPrefix(hex, "0x")
	if h == "" {
		return 0, nil
	}
	n, ok := new(big.Int).SetString(h, 16)
	if !ok {
		return 0, fmt.Errorf("not a number: %q", hex)
	}
	// A balance beyond uint64 is 18 trillion USDC and not a number this formats; refusing beats
	// wrapping round to something small and plausible.
	if !n.IsUint64() {
		return 0, fmt.Errorf("balance does not fit: %s", n)
	}
	return n.Uint64(), nil
}

// Holding is the account's idle USDC and what it has at work.
//
// Every read is allowed to fail on its own except the first: without the account address there is
// nothing to read, but a receipt token that will not answer is one market missing from a total
// rather than a reason to say nothing at all.
func (o *OnChain) Holding(ctx context.Context, owner string) (uint64, uint64, error) {
	account, err := o.accountOf(ctx, owner)
	if err != nil {
		return 0, 0, err
	}
	idleHex, err := o.chain.Call(ctx, o.usdc, selBalanceOf+padded(account))
	if err != nil {
		return 0, 0, err
	}
	idle, err := wordToUint(idleHex)
	if err != nil {
		return 0, 0, err
	}
	var working uint64
	for _, receipt := range o.receipts {
		hex, err := o.chain.Call(ctx, receipt, selBalanceOf+padded(account))
		if err != nil {
			continue
		}
		if v, err := wordToUint(hex); err == nil {
			working += v
		}
	}
	return idle, working, nil
}

// Moves counts the account's own `IdleCapitalMoved` events and dates the most recent.
//
// From the log rather than from a fresh scan: `activity.Service` keeps a watermark, so this costs
// one narrow query and the answer is the same one the portfolio page gives.
func (o *OnChain) Moves(ctx context.Context, owner string) (int, int64, error) {
	account, err := o.accountOf(ctx, owner)
	if err != nil {
		return 0, 0, err
	}
	res, err := o.log.For(ctx, account)
	if err != nil {
		return 0, 0, err
	}
	count := 0
	var last int64
	for _, e := range res.Events {
		if e.Kind != activity.KindMoved {
			continue
		}
		count++
		// The list arrives newest first, so the first dated one is the most recent.
		if last == 0 && e.BlockTime > 0 {
			last = int64(e.BlockTime)
		}
	}
	return count, last, nil
}

// accountOf asks the factory which account belongs to an owner.
func (o *OnChain) accountOf(ctx context.Context, owner string) (string, error) {
	hex, err := o.chain.Call(ctx, o.factory, selAccountFor+padded(owner))
	if err != nil {
		return "", err
	}
	account := wordToAddress(hex)
	if account == "" || account == "0x0000000000000000000000000000000000000000" {
		return "", fmt.Errorf("no account for %s", owner)
	}
	return account, nil
}

// RPC is a JSON-RPC endpoint, and the only method this package needs from one.
type RPC struct {
	url  string
	post func(ctx context.Context, url string, body []byte) ([]byte, error)
}

// NewRPC builds a chain reader over url. `post` is the transport, so a test needs no server.
func NewRPC(url string, post func(ctx context.Context, url string, body []byte) ([]byte, error)) *RPC {
	return &RPC{url: url, post: post}
}

// Call performs one `eth_call` at the head.
//
// **The JSON-RPC error is returned rather than dropped.** A pruned node answers "missing trie node"
// with HTTP 200, and a helper that reads that as an empty result reports an account holding nothing
// instead of an endpoint that cannot answer — which `internal/activity` already learned once.
func (r *RPC) Call(ctx context.Context, to, data string) (string, error) {
	body, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "eth_call",
		"params":  []any{map[string]string{"to": to, "data": data}, "latest"},
	})
	if err != nil {
		return "", err
	}
	raw, err := r.post(ctx, r.url, body)
	if err != nil {
		return "", err
	}
	var envelope struct {
		Result string `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", fmt.Errorf("eth_call: %w", err)
	}
	if envelope.Error != nil {
		return "", fmt.Errorf("eth_call: %s", envelope.Error.Message)
	}
	return envelope.Result, nil
}
