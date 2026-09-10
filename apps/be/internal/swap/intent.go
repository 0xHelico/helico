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

// Actions the conversation can reach. Each one is something the app already does on chain
// through its own screens, which is the bar for appearing here: a name the model can say and
// nothing behind it would be a claim rather than a feature.
const (
	ActionSwap   = "swap"
	ActionStatus = "status"
	ActionRevoke = "revoke"
	// ActionAbout is the one that answers for this endpoint itself: a greeting, or "what can you
	// do". It qualifies under the rule above because the thing behind it is this package — the
	// reply is composed from the actions and the registry below, so it cannot describe a feature
	// that is not here.
	ActionAbout = "about"
	// ActionWithdraw is the escape hatch, and it is deliberately not ActionRevoke.
	//
	// They are the two halves of getting out and a person means one of them specifically:
	// revoking ends the agent's authority and moves nothing, while this moves everything and
	// leaves the authority alone. Until it existed the app offered "Take everything back to my
	// wallet" on its empty screen, the model had nowhere else to put that sentence, and someone
	// asking for their money back was answered with "This ends the mandate" while every token
	// stayed exactly where it was.
	ActionWithdraw = "withdraw"
	// ActionEarn is asking for idle money to be put to work.
	//
	// It qualifies under the rule above, but only just, and the reason is worth writing down: the
	// enclave does the moving, so this action cannot move anything itself. What is behind it is
	// the **setup** — naming the agent, allowing the markets, and getting money into the account
	// — every step of which is a call the owner signs on their own screen.
	//
	// So the card it produces is not a promise. It reads what the account has and says which of
	// the three is missing, with the button for that one. Asked before any of it is done, it
	// answers with the first step rather than with a refusal; asked after all of it, it says the
	// agent will move it on its next run. Before this existed the Earn card was a link and
	// "put my idle USDC to work" landed on "about", which described earning to somebody who was
	// trying to start it.
	ActionEarn = "earn"
)

// Step is one check that ran, named after the function in this package that ran it. The chat
// draws these under the answer, which is only worth showing if they are the real ones: each is
// appended where the work happens rather than described afterwards, so four lines are four
// checks that executed, and a refused one is the check that actually said no.
type Step struct {
	Call   string `json:"call"`
	Detail string `json:"detail"`
	OK     bool   `json:"ok"`
}

// draft is what the model is asked for: an action, and for a swap the symbols and an amount.
type draft struct {
	Action   string `json:"action"`
	Chain    string `json:"chain"`
	TokenIn  string `json:"tokenIn"`
	TokenOut string `json:"tokenOut"`
	Amount   string `json:"amount"`
	Question string `json:"question"`
}

// build checks a draft against the registry and turns it into an Intent, or says what is
// missing or wrong. This is the only path from a model's output to a value this project uses.
//
// It also returns the checks it ran, in the order it ran them, including the one that refused.
// They are collected here rather than reconstructed by a caller, because a list assembled from
// the outcome could say a check passed that never happened.
func build(d draft) (Intent, []Step, error) {
	var steps []Step
	chain, ok := LookupChain(d.Chain)
	if !ok {
		steps = append(steps, Step{Call: "LookupChain", Detail: fmt.Sprintf("%q is not a chain this project targets", strings.TrimSpace(d.Chain))})
		return Intent{}, steps, fmt.Errorf("this only works on Arbitrum One at the moment, not %q", strings.TrimSpace(d.Chain))
	}
	steps = append(steps, Step{Call: "LookupChain", Detail: fmt.Sprintf("%s · %d", chain.Name, chain.ChainID), OK: true})

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
		steps = append(steps, Step{Call: "build", Detail: "the sentence did not say " + strings.Join(needs, ", ")})
		return Intent{}, steps, &ErrNeeds{Fields: needs}
	}

	in, ok := chain.Token(d.TokenIn)
	if !ok {
		steps = append(steps, Step{Call: "Chain.Token", Detail: fmt.Sprintf("%q is not in the registry", strings.TrimSpace(d.TokenIn))})
		return Intent{}, steps, fmt.Errorf("%q is not a token I know on %s; I know %s", strings.TrimSpace(d.TokenIn), chain.Name, strings.Join(chain.Symbols(), ", "))
	}
	steps = append(steps, Step{Call: "Chain.Token", Detail: describe(in), OK: true})

	out, ok := chain.Token(d.TokenOut)
	if !ok {
		steps = append(steps, Step{Call: "Chain.Token", Detail: fmt.Sprintf("%q is not in the registry", strings.TrimSpace(d.TokenOut))})
		return Intent{}, steps, fmt.Errorf("%q is not a token I know on %s; I know %s", strings.TrimSpace(d.TokenOut), chain.Name, strings.Join(chain.Symbols(), ", "))
	}
	steps = append(steps, Step{Call: "Chain.Token", Detail: describe(out), OK: true})

	if in.Symbol == out.Symbol {
		steps = append(steps, Step{Call: "build", Detail: "both sides are " + in.Symbol})
		return Intent{}, steps, errSameToken
	}

	wei, err := baseUnits(d.Amount, in.Decimals)
	if err != nil {
		steps = append(steps, Step{Call: "baseUnits", Detail: err.Error()})
		return Intent{}, steps, err
	}
	steps = append(steps, Step{Call: "baseUnits", Detail: fmt.Sprintf("%s %s → %s", strings.TrimSpace(d.Amount), in.Symbol, wei), OK: true})

	return Intent{
		ChainID:     chain.ChainID,
		Chain:       chain.Name,
		TokenIn:     in,
		TokenOut:    out,
		AmountIn:    strings.TrimSpace(d.Amount),
		AmountInWei: wei.String(),
	}, steps, nil
}

// describe renders a resolved token for a step line. The address is there because it is the one
// thing in an intent a model could not have chosen, and the abbreviation is still enough to tell
// USDC from the bridged token somebody was worried about.
func describe(t Token) string {
	a := t.Address
	if len(a) > 12 {
		a = a[:6] + "…" + a[len(a)-4:]
	}
	return fmt.Sprintf("%s · %s · %d dp", t.Symbol, a, t.Decimals)
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
