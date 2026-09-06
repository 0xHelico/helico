package swap

import (
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// Intent is a swap the backend has checked. Every field in it came from the registry or from
// arithmetic on the amount; none of it is a model's word taken as given.
type Intent struct {
	ChainID     int64  `json:"chainId"`
	Chain       string `json:"chain"`
	TokenIn     Token  `json:"tokenIn"`
	TokenOut    Token  `json:"tokenOut"`
	AmountIn    string `json:"amountIn"`
	AmountInWei string `json:"amountInWei"`
}

// ErrNeeds is returned when the message did not carry enough to build an intent. The fields it
// names are what to ask for.
type ErrNeeds struct{ Fields []string }

func (e *ErrNeeds) Error() string { return "missing: " + strings.Join(e.Fields, ", ") }

var (
	errSameToken   = errors.New("the two tokens are the same")
	errAmountShape = errors.New("the amount is not a positive number")
	errComma       = errors.New("write the amount with a dot, not a comma: 0.5, not 0,5")
)

// draft is what the model is asked for: symbols and an amount, nothing else.
type draft struct {
	Chain    string `json:"chain"`
	TokenIn  string `json:"tokenIn"`
	TokenOut string `json:"tokenOut"`
	Amount   string `json:"amount"`
	Question string `json:"question"`
}

// build checks a draft against the registry and turns it into an Intent, or says what is
// missing or wrong. This is the only path from a model's output to a value this project uses.
func build(d draft) (Intent, error) {
	chain, ok := LookupChain(d.Chain)
	if !ok {
		return Intent{}, fmt.Errorf("this only works on Arbitrum One at the moment, not %q", strings.TrimSpace(d.Chain))
	}

	var needs []string
	if strings.TrimSpace(d.TokenIn) == "" {
		needs = append(needs, "tokenIn")
	}
	if strings.TrimSpace(d.TokenOut) == "" {
		needs = append(needs, "tokenOut")
	}
	if strings.TrimSpace(d.Amount) == "" {
		needs = append(needs, "amount")
	}
	if len(needs) > 0 {
		return Intent{}, &ErrNeeds{Fields: needs}
	}

	in, ok := chain.Token(d.TokenIn)
	if !ok {
		return Intent{}, fmt.Errorf("%q is not a token I know on %s; I know %s", strings.TrimSpace(d.TokenIn), chain.Name, strings.Join(chain.Symbols(), ", "))
	}
	out, ok := chain.Token(d.TokenOut)
	if !ok {
		return Intent{}, fmt.Errorf("%q is not a token I know on %s; I know %s", strings.TrimSpace(d.TokenOut), chain.Name, strings.Join(chain.Symbols(), ", "))
	}
	if in.Symbol == out.Symbol {
		return Intent{}, errSameToken
	}

	wei, err := baseUnits(d.Amount, in.Decimals)
	if err != nil {
		return Intent{}, err
	}

	return Intent{
		ChainID:     chain.ChainID,
		Chain:       chain.Name,
		TokenIn:     in,
		TokenOut:    out,
		AmountIn:    strings.TrimSpace(d.Amount),
		AmountInWei: wei.String(),
	}, nil
}

// baseUnits converts a decimal string to an integer number of the token's smallest unit. It
// works on the digits rather than through a float, because a float loses wei and this number
// ends up in a transaction.
func baseUnits(amount string, decimals int) (*big.Int, error) {
	s := strings.TrimSpace(amount)
	// A comma is refused rather than read. It is the decimal point in Indonesian and much of
	// Europe and the thousands separator elsewhere, so "0,5" is either half or five, and
	// choosing one silently is how a reply comes to disagree with the number under it.
	if strings.ContainsRune(s, ',') {
		return nil, errComma
	}
	s = strings.TrimSuffix(s, ".")
	if s == "" {
		return nil, errAmountShape
	}
	whole, frac, _ := strings.Cut(s, ".")
	if whole == "" {
		whole = "0"
	}
	if !digits(whole) || !digits(frac) {
		return nil, errAmountShape
	}
	if len(frac) > decimals {
		return nil, fmt.Errorf("%s has %d decimal places, and this token has %d", s, len(frac), decimals)
	}
	n, ok := new(big.Int).SetString(whole+frac+strings.Repeat("0", decimals-len(frac)), 10)
	if !ok || n.Sign() <= 0 {
		return nil, errAmountShape
	}
	return n, nil
}

func digits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
