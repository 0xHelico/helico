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
// ask the model to confirm anything to the user: the confirmation sentence is composed here,
// from the checked numbers, so a model cannot put a different amount in front of a person.
const systemPrompt = `You turn a person's message into a swap request on Arbitrum One.

Answer with JSON only, this shape:
{"chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","question":""}

Rules:
- tokenIn is what they are giving, tokenOut what they want. Use the ticker, not a name.
- amount is how much of tokenIn, as a plain decimal number, no unit and no commas. "half an ETH" is "0.5". Never invent one.
- Leave a field empty when the message does not say it. Do not guess.
- question: one short sentence asking for whatever is empty, or "" when nothing is.
- Never mention prices, rates, or what something is worth. You do not know them.`

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
func (c *Client) ask(ctx context.Context, message string) (draft, error) {
	if !c.Configured() {
		return draft{}, ErrNotConfigured
	}

	body := chatRequest{
		Model:       c.Model,
		Temperature: 0,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: message},
		},
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
	var out chatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return draft{}, fmt.Errorf("the model's answer was not JSON: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		detail := resp.Status
		if out.Error != nil && out.Error.Message != "" {
			detail = out.Error.Message
		}
		return draft{}, fmt.Errorf("the model refused: %s", detail)
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
