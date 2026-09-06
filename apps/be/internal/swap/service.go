package swap

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Service answers one message at a time.
type Service struct{ client *Client }

// New builds a Service over any OpenAI-compatible client.
func New(c *Client) *Service { return &Service{client: c} }

// Configured reports whether the endpoint should serve at all.
func (s *Service) Configured() bool { return s != nil && s.client.Configured() }

// Answer is what a caller gets back: a sentence for the person, and an intent when there is
// one. Needs names what is still missing, so a form can highlight it rather than parse prose.
type Answer struct {
	Reply  string   `json:"reply"`
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
	if len(message) > maxMessage {
		return Answer{}, fmt.Errorf("that is longer than %d characters; a sentence is enough", maxMessage)
	}
	if !s.Configured() {
		return Answer{}, ErrNotConfigured
	}

	d, err := s.client.ask(ctx, message)
	if err != nil {
		return Answer{}, err
	}

	intent, err := build(d)
	if err != nil {
		var needs *ErrNeeds
		if errors.As(err, &needs) {
			return Answer{Reply: question(d.Question, needs.Fields), Needs: needs.Fields}, nil
		}
		// A wrong token or a bad amount is the person's answer to give, not an error to log.
		return Answer{Reply: capitalise(err.Error()) + ".", Needs: []string{"tokenIn", "tokenOut", "amount"}}, nil
	}

	// The confirmation is composed here, from the checked values, so the sentence and the
	// intent cannot disagree.
	return Answer{
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

func capitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
