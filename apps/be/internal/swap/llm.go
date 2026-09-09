package swap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// systemPrompt asks for the one small object this package can check. It deliberately does not
// ask the model to confirm anything to the user: every sentence a person reads is composed in
// service.go, from checked numbers or from the registry, so a model cannot put a different
// amount in front of someone and cannot offer a feature this project does not have.
//
// The context above the shape is there because without it every greeting came back as a swap
// with nothing in it, and the person was answered with "What can I help you with?" — which is
// the model asking the question it was asked.
const systemPrompt = `You are the chat inside Helico, and everything below is on Arbitrum One.

Helico gives someone a smart-contract account of their own. They hold the keys. An agent running
in a Chainlink CRE enclave may move idle capital between the lending markets that person
allow-listed, and nothing else — neither call it can make takes a recipient. Nothing you say
moves money: you read a sentence, and the person signs whatever they decide to sign.

Decide which of five things they are asking for, and for a swap also pull out the tokens and the
amount.

Answer with JSON only, this shape:
{"action":"","chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","question":""}

action is one of:
- "swap"   — they want to exchange one token for another
- "status" — they are asking about their position, their balances, or what the agent is doing
- "revoke" — they want to end the mandate, cancel it, stop the agent, or take back permission
- "withdraw" — they want their money back: everything returned to their own wallet, out, emptied
- "about"  — a greeting, or a question about you: what you are, what you can do, how this works

Rules:
- Choose the action from what they asked for. When the message is not any of them — a stray
  character, a fragment, something you cannot read — use "about". Never guess "swap" for it:
  the application answers "about" by saying what it can do, which is what that person needs.
- "revoke" and "withdraw" are opposite halves of getting out, and a person means one of them.
  Revoking ends the agent's authority and moves no money. Withdrawing moves every token back to
  their own wallet and leaves the authority alone. "Take everything back to my wallet" is
  withdraw. "Stop the agent" is revoke. When they say both, choose withdraw — the money is the
  part that cannot wait.
- Use "about" for a greeting, for "what can you do", and for questions about Helico itself. The
  reply to those is written by the application, not by you, so answer with the action alone.
- tokenIn, tokenOut and amount are for "swap" only. Leave them empty for the other four.
- tokenIn is what they are giving, tokenOut what they want. Use the ticker, not a name.
- amount is how much of tokenIn, as a plain decimal number, no unit and no commas. "half an ETH" is "0.5". Never invent one.
- Leave a field empty when the message does not say it. Do not guess.
- question: one short sentence asking for whatever is empty, or "" when nothing is.
- Never mention prices, rates, or what something is worth. You do not know them.
- Never offer a capability that is not one of the five actions above.`

// Turn is one earlier exchange, as the app already has it on screen.
type Turn struct {
	Role string `json:"role"`
	Body string `json:"body"`
}

// history builds the request's messages: the prompt, what was already said, then the new
// sentence.
//
// It exists so that "make it two instead" has something to be about. Nothing about the checking
// changes: the model still answers with one small object and `build` still refuses anything the
// registry does not hold, so a prior turn can help it fill a field and cannot help it invent one.
func history(prior []Turn, message string) []chatMessage {
	out := make([]chatMessage, 0, len(prior)+2)
	out = append(out, chatMessage{Role: "system", Content: systemPrompt})
	for _, t := range prior {
		role := "user"
		if t.Role == "assistant" {
			role = "assistant"
		}
		out = append(out, chatMessage{Role: role, Content: t.Body})
	}
	return append(out, chatMessage{Role: "user", Content: message})
}

// Client is an OpenAI-compatible chat endpoint. Any provider that speaks that shape works,
// which is the only reason this is a dozen lines rather than a package.
type Client struct {
	BaseURL string
	APIKey  string
	Model   string
	HTTP    *http.Client
}

// ErrNotConfigured is what the caller turns into a 503. There is no offline fallback on
// purpose: a fabricated reply would be worse than an honest refusal.
var ErrNotConfigured = errors.New("no model is configured")

// NewClient builds a client. An empty key leaves it unconfigured, and Ask says so.
func NewClient(baseURL, apiKey, model string, timeout time.Duration) *Client {
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	if model == "" {
		model = "gpt-4o-mini"
	}
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	return &Client{
		BaseURL: strings.TrimSuffix(baseURL, "/"),
		APIKey:  apiKey,
		Model:   model,
		HTTP:    &http.Client{Timeout: timeout},
	}
}

// Configured reports whether Ask can do anything.
func (c *Client) Configured() bool { return c != nil && c.APIKey != "" }

type chatRequest struct {
	Model          string        `json:"model"`
	Messages       []chatMessage `json:"messages"`
	Temperature    float64       `json:"temperature"`
	ResponseFormat struct {
		Type string `json:"type"`
	} `json:"response_format"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// ask sends the message and returns the draft the model produced. Anything the model says that
// is not the expected JSON is an error here rather than a guess further down.
func (c *Client) ask(ctx context.Context, message string, prior []Turn) (draft, error) {
	if !c.Configured() {
		return draft{}, ErrNotConfigured
	}

	body := chatRequest{
		Model:       c.Model,
		Temperature: 0,
		Messages:    history(prior, message),
	}
	body.ResponseFormat.Type = "json_object"

	buf, err := json.Marshal(body)
	if err != nil {
		return draft{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return draft{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return draft{}, fmt.Errorf("the model did not answer: %w", err)
	}
	defer resp.Body.Close()

	// A model that answers with a megabyte is a model that misunderstood.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return draft{}, err
	}
	// The status comes first: a gateway answering 502 with an HTML page is a status to report,
	// not a JSON shape to complain about.
	var out chatResponse
	unmarshalErr := json.Unmarshal(raw, &out)
	if resp.StatusCode != http.StatusOK {
		detail := resp.Status
		if unmarshalErr == nil && out.Error != nil && out.Error.Message != "" {
			detail = out.Error.Message
		}
		return draft{}, fmt.Errorf("the model refused: %s", detail)
	}
	if unmarshalErr != nil {
		return draft{}, fmt.Errorf("the model's answer was not JSON: %w", unmarshalErr)
	}
	if len(out.Choices) == 0 {
		return draft{}, errors.New("the model answered with nothing")
	}

	var d draft
	if err := json.Unmarshal([]byte(out.Choices[0].Message.Content), &d); err != nil {
		return draft{}, fmt.Errorf("the model's answer was not the shape asked for: %w", err)
	}
	return d, nil
}
