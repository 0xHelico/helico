// Package swap turns a person's sentence into a swap intent the rest of the project can act
// on. It never signs, sends, or quotes: building calldata is @helico/plugin-uniswap's job, and
// this package's only power is to say what someone meant.
package swap

import "strings"

// Token is one asset the registry knows. The address is committed here rather than produced by
// a model, which is the whole point: an intent can only ever name an address the project put in
// this file.
type Token struct {
	Symbol   string `json:"symbol"`
	Address  string `json:"address"`
	Decimals int    `json:"decimals"`
	// Name is what a person calls it, used in replies.
	Name string `json:"name"`
}

// Chain is a network with the assets this project supports on it.
type Chain struct {
	Key     string `json:"key"`
	ChainID int64  `json:"chainId"`
	Name    string `json:"name"`
	tokens  []Token
	aliases map[string]string
}

// arbitrum is the chain Helico targets. Every address below was checked against the chain
// itself with `symbol()` and `decimals()` over eth_call, and the decimals here are the ones the
// contracts report. The native coin is the zero address, which is how Uniswap v4 names it.
//
// One symbol deliberately differs from its contract: Tether on Arbitrum reports `USD₮0`, and
// nobody types that. `USDT` is the ticker used in conversation; the address is Tether's.
var arbitrum = Chain{
	Key:     "arbitrum",
	ChainID: 42161,
	Name:    "Arbitrum One",
	tokens: []Token{
		{Symbol: "ETH", Address: "0x0000000000000000000000000000000000000000", Decimals: 18, Name: "Ether"},
		{Symbol: "WETH", Address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", Decimals: 18, Name: "Wrapped Ether"},
		{Symbol: "USDC", Address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", Decimals: 6, Name: "USD Coin"},
		{Symbol: "USDT", Address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", Decimals: 6, Name: "Tether USD, which the contract calls USD₮0"},
		{Symbol: "ARB", Address: "0x912CE59144191C1204E64559FE8253a0e49E6548", Decimals: 18, Name: "Arbitrum"},
	},
	aliases: map[string]string{
		"ether": "ETH", "eth": "ETH", "weth": "WETH", "wrapped ether": "WETH",
		"usdc": "USDC", "usd coin": "USDC", "usdc.e": "USDC",
		"usdt": "USDT", "tether": "USDT", "usd₮0": "USDT", "usdt0": "USDT",
		"arb": "ARB", "arbitrum": "ARB",
	},
}

// chains is every network the endpoint will answer about. One, for now, because one is what the
// project has tested; a symbol on a chain that is not here is a refusal rather than a guess.
var chains = []Chain{arbitrum}

// LookupChain resolves a chain by key, name, or id as a string. An empty key means the default.
func LookupChain(s string) (Chain, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return chains[0], true
	}
	for _, c := range chains {
		if s == c.Key || s == strings.ToLower(c.Name) || s == "arbitrum one" {
			return c, true
		}
	}
	return Chain{}, false
}

// Token resolves a symbol a person or a model wrote. Case and common aliases are accepted; an
// address is not, because accepting one would let a model choose it.
func (c Chain) Token(symbol string) (Token, bool) {
	s := strings.ToLower(strings.TrimSpace(symbol))
	if canonical, ok := c.aliases[s]; ok {
		s = strings.ToLower(canonical)
	}
	for _, t := range c.tokens {
		if strings.ToLower(t.Symbol) == s {
			return t, true
		}
	}
	return Token{}, false
}

// Symbols lists what this chain accepts, for a reply that has to say so.
func (c Chain) Symbols() []string {
	out := make([]string, 0, len(c.tokens))
	for _, t := range c.tokens {
		out = append(out, t.Symbol)
	}
	return out
}
