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

// Model is the model this service actually asks. The app shows it beside the composer, and a
// name it read from its own environment would be a name that can drift from the truth.
func (s *Service) Model() string {
	if s == nil || s.client == nil {
		return ""
	}
	return s.client.Model
}

// Answer is what a caller gets back: a sentence for the person, which action it is, and an
// intent when the action is a swap. Needs names what is still missing, so a form can highlight
// it rather than parse prose.
//
// Action is what the app renders on. It is always one of the four constants and never the
// model's own word, because a value the browser switches on is a value that has to be checked
// here first.
type Answer struct {
	Reply  string   `json:"reply"`
	Action string   `json:"action"`
	Intent *Intent  `json:"intent"`
	Needs  []string `json:"needs,omitempty"`
	// Steps is what ran to produce the rest, in order. The app draws it as a tree under the
	// sentence, so that a person can see the refusal come from a named check rather than from a
	// model changing its mind.
	Steps []Step `json:"steps,omitempty"`
}

// maxMessage bounds what a person can send. A swap request is a sentence.
const maxMessage = 500

// Interpret turns a message into an Answer. The model proposes; everything a caller sees about
// tokens and amounts has been through build.
func (s *Service) Interpret(ctx context.Context, message string) (Answer, error) {
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

	d, err := s.client.ask(ctx, message)
	if err != nil {
		return Answer{}, err
	}

	// The action is decided here, not taken from the model: anything it invents falls through to
	// swap and gets checked by build. The step below therefore records what was decided rather
	// than what was said, because a tree that reports an action nothing acted on is a tree that
	// lies quietly.
	action := strings.ToLower(strings.TrimSpace(d.Action))
	switch action {
	case ActionStatus, ActionRevoke, ActionAbout:
	default:
		action = ActionSwap
	}
	read := Step{Call: "Client.ask", Detail: "read as " + action, OK: true}

	// None of these three needs a parameter, so none goes near build: there is nothing from the
	// model to check, only a decision about which screen the person is asking for. The wallet
	// still does the work, and revoking still costs a signature the person gives themselves.
	switch action {
	case ActionAbout:
		return Answer{Action: ActionAbout, Reply: about(), Steps: []Step{read}}, nil
	case ActionStatus:
		return Answer{
			Action: ActionStatus,
			Reply:  "Here is what your position is doing. Read from the chain, not from me.",
			Steps:  []Step{read},
		}, nil
	case ActionRevoke:
		return Answer{
			Action: ActionRevoke,
			Reply:  "This ends the mandate. The agent can do nothing afterwards, and you sign it yourself — nobody has to agree.",
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
	return Answer{
		Action: ActionSwap,
		Reply: fmt.Sprintf("Swapping %s %s into %s on %s. Nothing has moved: this is what I understood, and you sign it yourself.",
			intent.AmountIn, intent.TokenIn.Symbol, intent.TokenOut.Symbol, intent.Chain),
		Intent: &intent,
		Steps:  steps,
	}, nil
}

// about says what this endpoint can do, and it is written here rather than by the model for the
// same reason the swap confirmation is: a model given a paragraph about the product will offer a
// feature the product does not have, and a chat that promises to bridge or to borrow is exactly
// the kind of claim this submission cannot afford.
//
// It reads the registry rather than repeating it, so a token added to tokens.go is a token this
// sentence offers, and there is no second list to fall behind.
func about() string {
	chain := chains[0]
	return "I read what you type and turn it into something you sign yourself. I hold no keys and " +
		"move nothing.\n\n" +
		"• Swap — name two tokens and an amount, and I build the intent. On " + chain.Name +
		", in " + strings.Join(chain.Symbols(), ", ") + ".\n" +
		"• Status — what your account holds, how much of it is working, how much is liquid.\n" +
		"• Revoke — end the mandate. The agent can do nothing afterwards.\n\n" +
		"Your account is yours: the agent may only move capital between markets you allow-listed, " +
		"and neither call it can make takes a recipient. Anything I have no address or number for, " +
		"I ask about rather than guess."
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
