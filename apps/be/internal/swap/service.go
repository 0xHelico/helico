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
// Action is what the app renders on. It is always one of the three constants and never the
// model's own word, because a value the browser switches on is a value that has to be checked
// here first.
type Answer struct {
	Reply  string   `json:"reply"`
	Action string   `json:"action"`
	Intent *Intent  `json:"intent"`
	Needs  []string `json:"needs,omitempty"`
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

	// Neither of these needs a parameter, so neither goes near build: there is nothing from the
	// model to check, only a decision about which screen the person is asking for. The wallet
	// still does the work, and revoking still costs a signature the person gives themselves.
	switch strings.ToLower(strings.TrimSpace(d.Action)) {
	case ActionStatus:
		return Answer{
			Action: ActionStatus,
			Reply:  "Here is what your position is doing. Read from the chain, not from me.",
		}, nil
	case ActionRevoke:
		return Answer{
			Action: ActionRevoke,
			Reply:  "This ends the mandate. The agent can do nothing afterwards, and you sign it yourself — nobody has to agree.",
		}, nil
	}

	intent, err := build(d)
	if err != nil {
		var needs *ErrNeeds
		if errors.As(err, &needs) {
			return Answer{Action: ActionSwap, Reply: question(d.Question, needs.Fields), Needs: needs.Fields}, nil
		}
		// A wrong token or a bad amount is the person's answer to give, not an error to log. Only
		// the field that failed is named, so a form does not light up three inputs for one fault.
		return Answer{Action: ActionSwap, Reply: capitalise(err.Error()) + ".", Needs: faulty(err)}, nil
	}

	// The confirmation is composed here, from the checked values, so the sentence and the
	// intent cannot disagree.
	return Answer{
		Action: ActionSwap,
		Reply: fmt.Sprintf("Swapping %s %s into %s on %s. Nothing has moved: this is what I understood, and you sign it yourself.",
			intent.AmountIn, intent.TokenIn.Symbol, intent.TokenOut.Symbol, intent.Chain),
		Intent: &intent,
	}, nil
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
