package swap

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Service answers one message at a time.
type Service struct{ client *Client }

// New builds a Service over any OpenAI-compatible client.
func New(c *Client) *Service { return &Service{client: c} }

// Configured reports whether the endpoint should serve at all.
func (s *Service) Configured() bool { return s != nil && s.client.Configured() }

// Model is the model this service asks first. The app shows it beside the composer, and a name
// it read from its own environment would be a name that can drift from the truth.
func (s *Service) Model() string {
	if s == nil || s.client == nil {
		return ""
	}
	return s.client.Model()
}

// Models is every configured model, in the order they are asked. The picker offers these and
// disables the rest, so the menu is what is wired rather than what could be.
func (s *Service) Models() []string {
	if s == nil || s.client == nil {
		return nil
	}
	return s.client.Models()
}

// Prefer returns a Service that asks the named model first, keeping the others behind it.
//
// The name is one of `Models`; anything else leaves the order alone. A caller never supplies an
// address, a key or a routing string, so picking a model cannot point this process anywhere new.
func (s *Service) Prefer(model string) *Service {
	if s == nil || s.client == nil {
		return s
	}
	return &Service{client: s.client.prefer(model)}
}

// Answer is what a caller gets back: a sentence for the person, which action it is, and an
// intent when the action is a swap. Needs names what is still missing, so a form can highlight
// it rather than parse prose.
//
// Action is what the app renders on. It is always one of the five constants and never the
// model's own word, because a value the browser switches on is a value that has to be checked
// here first.
type Answer struct {
	Reply  string   `json:"reply"`
	Action string   `json:"action"`
	Intent *Intent  `json:"intent"`
	Needs  []string `json:"needs,omitempty"`
	// Cards is the answer as the app draws it, when a paragraph is the wrong shape for what was
	// asked. "What can you do" used to come back as four bullets inside a wall of prose, which is
	// the one question whose answer nobody reads that way.
	Cards []Card `json:"cards,omitempty"`
	// Steps is what ran to produce the rest, in order. The app draws it as a tree under the
	// sentence, so that a person can see the refusal come from a named check rather than from a
	// model changing its mind.
	Steps []Step `json:"steps,omitempty"`
}

// Card is one thing this chat can do, rendered as a card rather than as a line in a list.
//
// Every card is pressable, and carries exactly one of the two ways to be. Try is a sentence a
// person can send unchanged, which is what makes a card worth more than the bullet it replaced:
// it is a way to use the thing rather than a description of it. Href is for what this chat does
// not do itself — the limits and the portfolio are screens, and a card that described one without
// going there would be the bullet again. Tags are short enough to sit in a row: the registry's
// symbols, not prose about them.
type Card struct {
	Title string   `json:"title"`
	Body  string   `json:"body"`
	Try   string   `json:"try,omitempty"`
	Href  string   `json:"href,omitempty"`
	Tags  []string `json:"tags,omitempty"`
}

// maxMessage bounds what a person can send. A swap request is a sentence.
const maxMessage = 500

// Interpret turns a message into an Answer. The model proposes; everything a caller sees about
// tokens and amounts has been through build.
// maxPrior is how far back a sentence may reach. Six turns is three exchanges, which covers "and
// make it two instead" and stops a caller from making this endpoint carry a transcript.
const maxPrior = 6

// maxPriorRunes bounds each one. A long earlier turn is the app's own composed reply, and nothing
// after the first line of one changes what the next sentence means.
const maxPriorRunes = 400

func (s *Service) Interpret(ctx context.Context, message string, prior ...Turn) (Answer, error) {
	message = strings.TrimSpace(message)
	if message == "" {
		return Answer{}, errors.New("say what you would like to swap")
	}
	if utf8.RuneCountInString(message) > maxMessage {
		return Answer{}, fmt.Errorf("that is longer than %d characters; a sentence is enough", maxMessage)
	}
	if !s.Configured() {
		return Answer{}, ErrNotConfigured
	}

	if len(prior) > maxPrior {
		prior = prior[len(prior)-maxPrior:]
	}
	trimmed := make([]Turn, 0, len(prior))
	for _, t := range prior {
		body := strings.TrimSpace(t.Body)
		if body == "" {
			continue
		}
		if utf8.RuneCountInString(body) > maxPriorRunes {
			body = string([]rune(body)[:maxPriorRunes])
		}
		trimmed = append(trimmed, Turn{Role: t.Role, Body: body})
	}

	d, answered, err := s.client.ask(ctx, message, trimmed)
	if err != nil {
		return Answer{}, err
	}

	// The action is decided here, not taken from the model: anything it invents falls through to
	// swap and gets checked by build. The step below therefore records what was decided rather
	// than what was said, because a tree that reports an action nothing acted on is a tree that
	// lies quietly.
	action := strings.ToLower(strings.TrimSpace(d.Action))
	switch action {
	case ActionStatus,
		ActionRevoke,
		ActionAbout,
		ActionWithdraw,
		ActionEarn,
		ActionDeposit,
		ActionProvide:
	default:
		action = ActionSwap
	}
	// A sentence that named no token and no amount did not ask for a swap. The model answers with
	// one of five actions, so anything it could not read lands on the default above — typing "p"
	// was reaching the swap path and coming back demanding three fields the person had never
	// mentioned, which is the chat inventing a request on their behalf.
	//
	// The help text answers both readings of an empty draft. Someone who typed nonsense is told
	// what this can do, and someone who typed "I want to swap" is told a swap needs two tokens and
	// an amount, and which tokens there are — more than the three-field demand gave them.
	if action == ActionSwap && strings.TrimSpace(d.TokenIn) == "" && strings.TrimSpace(d.TokenOut) == "" && strings.TrimSpace(d.Amount) == "" {
		action = ActionAbout
	}
	// **The model that answered, not the one that was asked for.** When a router is down the next
	// one replies, and a step naming the first would leave the picker saying a model that did not
	// reply had read the sentence.
	read := Step{Call: "Client.ask", Detail: "read as " + action + ", by " + answered, OK: true}

	// None of these four needs a parameter, so none goes near build: there is nothing from the
	// model to check, only a decision about which screen the person is asking for. The wallet
	// still does the work, and revoking still costs a signature the person gives themselves.
	switch action {
	case ActionAbout:
		reply, cards := about()
		return Answer{Action: ActionAbout, Reply: reply, Cards: cards, Steps: []Step{read}}, nil
	case ActionWithdraw:
		return Answer{
			Action: ActionWithdraw,
			Reply: "This sends everything your account holds back to you. There is nowhere else it " +
				"could go: the destination is your own address, fixed when the account was built, " +
				"and the call has no recipient to set. It sits in the proxy rather than in code " +
				"that can be swapped out, so no upgrade can take this door away from you. Whatever " +
				"is earning comes back as Aave's receipt for it, which you redeem there for the " +
				"asset itself.",
			Steps: []Step{read},
		}, nil
	case ActionStatus:
		return Answer{
			Action: ActionStatus,
			// Phrased for "why has nothing happened" as well as "what do I hold", because both
			// arrive here and the second wording answered only one of them. The card below carries
			// the actual reason, which this sentence cannot: it is composed without an address.
			Reply: "Here is your position, read straight from the chain rather than from me. If " +
				"nothing has moved, the reason is in there somewhere: an account nobody has " +
				"created, an agent nobody has named, a market nobody has allowed, or a move too " +
				"small to be worth the gas.",
			Steps: []Step{read},
		}, nil
	case ActionProvide:
		return Answer{
			Action: ActionProvide,
			Reply: "You can be the maker rather than the taker. This commits WETH and USDC to a band " +
				"around the current price and lets anyone trade against it, priced by 1inch's own " +
				"concentrate instruction. Your tokens do not move: Aqua is a ledger, so shipping writes " +
				"a number and the approval is for exactly what you commit. Docking ends it and needs " +
				"nobody's permission.",
			Steps: []Step{read},
		}, nil
	case ActionDeposit:
		return Answer{
			Action: ActionDeposit,
			Reply: "Your account is a contract only you own, and the agent moves what it holds. An " +
				"ordinary transfer, no approval. The card sends it, or pay in to the address on it.",
			Steps: []Step{read},
		}, nil
	case ActionEarn:
		// "Swap $1 of ETH to USDC and put it all to work" is one sentence and one signature: the
		// swap rides in the same batch as the ship, with the account as the swap's receiver. The
		// swap half goes through build like any other, so a token the registry does not know or
		// an amount that is not a number is refused here, by name, and not at the wallet.
		if strings.TrimSpace(d.TokenIn) != "" {
			// Two shapes, told apart by where the token ends up. Into USDC: the swap funds the
			// USDC side. Into WETH: ether is wrapped and works as itself, on the other side of the
			// same position. An empty destination is asked about rather than guessed — the two
			// shapes put the money in different markets.
			if strings.TrimSpace(d.TokenOut) == "" {
				return Answer{Action: ActionEarn, Reply: "Into USDC, or as ETH itself? Say \"swap $1 of ETH to USDC and put it all to work\", or \"put $1 of ETH to work\".", Needs: []string{"tokenOut"}, Steps: []Step{read}}, nil
			}
			intent, checks, err := build(d)
			steps := append([]Step{read}, checks...)
			if err != nil {
				var needs *ErrNeeds
				if errors.As(err, &needs) {
					return Answer{Action: ActionEarn, Reply: question(d.Question, needs.Fields), Needs: needs.Fields, Steps: steps}, nil
				}
				return Answer{Action: ActionEarn, Reply: capitalise(err.Error()) + ".", Needs: faulty(err), Steps: steps}, nil
			}
			said := fmt.Sprintf("%s %s", intent.AmountIn, intent.TokenIn.Symbol)
			if intent.AmountUsd != "" {
				said = fmt.Sprintf("$%s of %s", intent.AmountUsd, intent.TokenIn.Symbol)
			}
			switch {
			case strings.EqualFold(intent.TokenOut.Symbol, "USDC"):
				return Answer{
					Action: ActionEarn,
					Intent: &intent,
					Reply: fmt.Sprintf("Swapping %s into USDC and putting all of it to work, in one signature: the swap "+
						"lands in your account, the account ships it as a position on Aqua, and the agent "+
						"places it in whichever market pays best. Nothing has moved: this is what I understood.", said),
					Steps: steps,
				}, nil
			case strings.EqualFold(intent.TokenOut.Symbol, "WETH") && strings.EqualFold(intent.TokenIn.Symbol, "ETH"):
				return Answer{
					Action: ActionEarn,
					Intent: &intent,
					Reply: fmt.Sprintf("Putting %s to work as ETH, in one signature: it is wrapped, moved into your "+
						"account beside your USDC, the account ships both as one position on Aqua, and the agent "+
						"places the ETH in whichever market pays most for it. Nothing has moved: this is what I understood.", said),
					Steps: steps,
				}, nil
			default:
				steps = append(steps, Step{Call: "Fund.tokenOut", Detail: intent.TokenIn.Symbol + " → " + intent.TokenOut.Symbol + " is not a way into the account; USDC or ETH as itself"})
				return Answer{Action: ActionEarn, Reply: "The account puts USDC to work, and ETH as itself. Say \"swap … to USDC and put it to work\" or \"put … ETH to work\".", Needs: []string{"tokenOut"}, Steps: steps}, nil
			}
		}
		return Answer{
			Action: ActionEarn,
			// Written for somebody who has not set anything up, because that is who asks this.
			// The card beside it reads the account and names which of the three steps is missing;
			// this sentence has no address and cannot.
			Reply: "Your idle USDC earns in whichever of Aave v3, Compound v3 or Morpho pays best. " +
				"Three things first, each a call you sign: name the agent, allow the market, put the " +
				"money in. The card shows which is missing.",
			Steps: []Step{read},
		}, nil
	case ActionRevoke:
		return Answer{
			Action: ActionRevoke,
			Reply:  "This ends the mandate. The agent can do nothing afterwards, you sign it yourself, and nobody else has to agree.",
			Steps:  []Step{read},
		}, nil
	}

	intent, checks, err := build(d)
	steps := append([]Step{read}, checks...)
	if err != nil {
		var needs *ErrNeeds
		if errors.As(err, &needs) {
			return Answer{Action: ActionSwap, Reply: question(d.Question, needs.Fields), Needs: needs.Fields, Steps: steps}, nil
		}
		// A wrong token or a bad amount is the person's answer to give, not an error to log. Only
		// the field that failed is named, so a form does not light up three inputs for one fault.
		return Answer{Action: ActionSwap, Reply: capitalise(err.Error()) + ".", Needs: faulty(err), Steps: steps}, nil
	}

	// The confirmation is composed here, from the checked values, so the sentence and the
	// intent cannot disagree.
	// A dollar amount says so rather than naming a token figure this package did not compute. The
	// card fills the number in from the feed, and saying "$5 of ETH" until it does is the honest
	// half-sentence; inventing "0.002 ETH" here would be a figure with no source.
	said := fmt.Sprintf("%s %s", intent.AmountIn, intent.TokenIn.Symbol)
	if intent.AmountUsd != "" {
		said = fmt.Sprintf("$%s of %s", intent.AmountUsd, intent.TokenIn.Symbol)
	}
	return Answer{
		Action: ActionSwap,
		Reply: fmt.Sprintf("Swapping %s into %s on %s. Nothing has moved: this is what I understood, and you sign it yourself.",
			said, intent.TokenOut.Symbol, intent.Chain),
		Intent: &intent,
		Steps:  steps,
	}, nil
}

// about says what Helico does, and it is written here rather than by the model for the
// same reason the swap confirmation is: a model given a paragraph about the product will offer a
// feature the product does not have, and a chat that promises to bridge or to borrow is exactly
// the kind of claim this submission cannot afford.
//
// It reads the registry rather than repeating it, so a token added to tokens.go is a token this
// sentence offers, and there is no second list to fall behind.
func about() (string, []Card) {
	chain := chains[0]
	reply := "You get an account that only you own. You name an agent, and it can move your idle " +
		"money between the lending markets you allowed and pull it back out again. That is all it " +
		"can do, because neither of those calls lets it say where money goes.\n\n" +
		"Not yet, and I would rather tell you than leave it out: borrowing, using more than one " +
		"market at a time, and any chain other than " + chain.Name + ". If I do not have an " +
		"address or a number for something, I will ask instead of guessing."

	return reply, []Card{
		{
			Title: "Swap",
			Body:  "Name two tokens and an amount. I check both against the registry and build the intent. You sign it.",
			Try:   "Swap 0.1 ETH into USDC",
			Tags:  chain.Symbols(),
		},
		{
			Title: "Status",
			Body:  "What your account holds, how much of it is earning, and who is allowed to move it.",
			Try:   "What is my position doing?",
		},
		{
			Title: "Revoke",
			Body:  "End the mandate. The agent can do nothing afterwards, and nobody else has to agree.",
			Try:   "Stop the agent",
		},
		{
			Title: "Withdraw",
			Body:  "Send everything back to your own wallet. The call has no recipient to set, so there is nowhere else it could go.",
			Try:   "Take everything back to my wallet",
		},
		{
			// The product's own reason to exist, and it had no card until #330 — it survived as a
			// clause in the paragraph above, so anyone reading the cards saw a swap app.
			//
			// "Compares" and not "spreads across": `decideIdleMove` clamps to the one market
			// `bestPaying` returns, so a card promising several at once would describe a different
			// product. That limit stays named in the "Not yet" line rather than quietly dropped.
			Title: "Earn",
			Body: "Your idle USDC earns while it waits. The agent looks at Aave v3, Compound v3 and a " +
				"Morpho vault before it moves, which is three protocols rather than three markets " +
				"inside one. It holds whichever pays best, and can do nothing else with your money.",
			// A sentence, not a link, since #387 gave every step of the setup a button in the
			// chat. It used to open the limits page at an anchor, which asked a person to go and
			// find the controls; now the answer arrives with the one that is actually missing.
			Try: "Put my idle USDC to work",
		},
		{
			Title: "Provide liquidity",
			Body: "Commit WETH and USDC to a band around the price and let anyone trade against it. " +
				"Your tokens stay in your wallet: Aqua is a ledger, and docking ends it.",
			Try: "Provide liquidity for ETH and USDC",
		},
		{
			Title: "Money in",
			Body: "Move USDC from your wallet into your own account, which is what the agent moves. An " +
				"ordinary transfer: no approval, and nothing granted to anybody.",
			Try: "Move money into my account",
		},
		{
			Title: "Set your limits",
			Body:  "Name the agent and pick the markets it may use. Setting the first one creates your account.",
			Href:  "/limit",
		},
		{
			Title: "See what moved",
			Body:  "Your mandates and what has gone through them. The chain on its own cannot answer that.",
			Href:  "/portfolio",
		},
	}
}

// question prefers the model's own wording, and falls back to naming the gap.
func question(modelQuestion string, fields []string) string {
	if q := strings.TrimSpace(modelQuestion); q != "" {
		return q
	}
	human := map[string]string{"tokenIn": "which token to swap from", "tokenOut": "which token to swap into", "amount": "how much"}
	parts := make([]string, 0, len(fields))
	for _, f := range fields {
		if h, ok := human[f]; ok {
			parts = append(parts, h)
		}
	}
	return "I still need " + strings.Join(parts, ", ") + "."
}

// faulty names the field a refusal is about, so the caller can highlight one input.
func faulty(err error) []string {
	switch {
	case errors.Is(err, errAmountShape), errors.Is(err, errComma), strings.Contains(err.Error(), "decimal places"):
		return []string{"amount"}
	case errors.Is(err, errSameToken):
		return []string{"tokenOut"}
	default:
		return []string{"tokenIn", "tokenOut"}
	}
}

func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
