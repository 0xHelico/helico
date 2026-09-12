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
{"action":"","chain":"arbitrum","tokenIn":"","tokenOut":"","amount":"","amountUsd":"","question":""}

action is one of:
- "swap"   — they want to exchange one token for another
- "status" — they are asking about their position, their balances, or what the agent is doing
- "revoke" — they want to end the mandate, cancel it, stop the agent, or take back permission
- "withdraw" — they want their money back: everything returned to their own wallet, out, emptied
- "earn"   — they want their idle money working: earning, lending, supplied, put to work
- "deposit" — they want to move money into their account: fund it, top it up, put money in
- "provide" — they want to offer liquidity of their own: provide, market make, be the maker, LP
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
- "earn" is about starting it, "status" is about what it is already doing. "Put my idle USDC to
  work" is earn. "How much of my money is earning" is status.
- "provide" is offering their own two-sided position for other people to trade against. "Provide
  liquidity for ETH and USDC" and "let me be the maker" are provide. It is not a swap: a swap
  spends one token to get another, this commits both and waits.
- "deposit" is money moving from their wallet into their own account. "Move 50 USDC into my
  account" is deposit. "Swap 50 USDC into WETH" is a swap: one is a transfer to themselves, the
  other is an exchange between two tokens.
- tokenIn, tokenOut and amount are for "swap" only. Leave them empty for the other six.
- tokenIn is what they are giving, tokenOut what they want. Use the ticker, not a name.
- amount is how much of tokenIn, as a plain decimal number, no unit and no commas. "half an ETH" is "0.5". Never invent one.
- amountUsd is for a dollar amount instead: "$5 of ETH", "5 dollars of ETH", "swap $5 ETH to USDC"
  is amountUsd "5" with amount empty. Set one or the other, never both, and never convert between
  them — you do not have a price and the application does.
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

// Upstream is one OpenAI-compatible chat endpoint.
//
// Helico asks a router rather than a provider, and a router is one of these with a different
// address. That is the whole reason this is a struct and not three arguments: the two we have
// differ in how they authenticate, and the difference is not a detail either side can skip.
type Upstream struct {
	// BaseURL ends before /chat/completions.
	BaseURL string
	// Key is the router's own key for this account.
	Key string
	// Model is the router's routing string, which names a provider account as well as a model.
	Model string
	// User and Pass are HTTP basic credentials for a proxy sitting in front of the router.
	//
	// **They are a header, never part of the URL.** A request that never connects comes back as a
	// `*url.Error`, and that prints the URL it was given — so credentials written into the
	// userinfo of a base URL end up in whatever log or error string that value reaches.
	// `handlers.go` already withholds these errors from callers for the same reason.
	//
	// When they are set the key moves to `X-Api-Key`, because one `Authorization` header cannot
	// carry a Basic challenge and a Bearer token at once, and the proxy answers first: without
	// the Basic value it refuses with its own 401 and the router is never reached.
	User string
	Pass string
}

// Client asks the upstreams in order and returns the first answer.
//
// **Order is not a preference between models, it is a preference between latencies.** Both
// routers answer the same question correctly; measured on 12 September with this file's own
// system prompt, one takes 1.3 to 2.2 seconds and the other 6.3 to 7.1. So the quick one is
// asked first and the other is what the conversation falls back to, rather than the two being
// interchangeable.
type Client struct {
	ups  []Upstream
	HTTP *http.Client
}

// ErrNotConfigured is what the caller turns into a 503. There is no offline fallback on
// purpose: a fabricated reply would be worse than an honest refusal.
var ErrNotConfigured = errors.New("no model is configured")

// NewClient builds a client over the upstreams that carry a key. `timeout` bounds each attempt,
// not the whole chain, so a fallback is not handed the remains of the first one's budget.
func NewClient(timeout time.Duration, ups ...Upstream) *Client {
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	kept := make([]Upstream, 0, len(ups))
	for _, u := range ups {
		// An entry with no key is a half-written configuration rather than an upstream. Kept, it
		// would spend an attempt on a call that cannot succeed and report that call's error.
		if u.Key == "" {
			continue
		}
		if u.BaseURL == "" {
			u.BaseURL = "https://api.openai.com/v1"
		}
		if u.Model == "" {
			u.Model = "gpt-4o-mini"
		}
		u.BaseURL = strings.TrimSuffix(u.BaseURL, "/")
		kept = append(kept, u)
	}
	return &Client{ups: kept, HTTP: &http.Client{Timeout: timeout}}
}

// Configured reports whether Ask can do anything.
func (c *Client) Configured() bool { return c != nil && len(c.ups) > 0 }

// family is a router's model string with the account stripped off.
//
// A router's model reads `fajar-openai/gpt-4o-mini`, where the part before the slash names the
// account the call is billed to. Not a credential, and not something a public endpoint has any
// reason to publish either — so this is what `/api/swap/config` reports and what a caller names
// when it picks one.
func family(model string) string {
	if i := strings.LastIndex(model, "/"); i >= 0 {
		return model[i+1:]
	}
	return model
}

// Model is the family name of the model asked first, for the composer to show.
func (c *Client) Model() string {
	if !c.Configured() {
		return ""
	}
	return family(c.ups[0].Model)
}

// Models is every configured model's family name, in the order they are asked.
func (c *Client) Models() []string {
	if !c.Configured() {
		return nil
	}
	out := make([]string, 0, len(c.ups))
	for _, u := range c.ups {
		out = append(out, family(u.Model))
	}
	return out
}

// prefer returns a client that asks the named model first.
//
// **The name is matched against what we published, and nothing else is read from it.** A caller
// picks by the family name `Models` reports; it never supplies an address, a key or a routing
// string, so choosing a model cannot point this process at an endpoint nobody configured.
//
// An unknown name leaves the order alone rather than refusing. The list a page is holding can be
// one deploy out of date, and answering with the model that does exist is better than an error
// about a menu.
//
// The rest of the chain is kept behind the choice, so picking the slower model still falls back to
// the other one when it is down.
func (c *Client) prefer(model string) *Client {
	if model == "" || len(c.ups) < 2 {
		return c
	}
	for i, u := range c.ups {
		if family(u.Model) != model {
			continue
		}
		if i == 0 {
			return c
		}
		ups := make([]Upstream, 0, len(c.ups))
		ups = append(ups, c.ups[i])
		ups = append(ups, c.ups[:i]...)
		ups = append(ups, c.ups[i+1:]...)
		return &Client{ups: ups, HTTP: c.HTTP}
	}
	return c
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	// Stream is false and said so. The OpenAI default is false, but at least one router this
	// has been pointed at streams unless told not to, and a stream of chunks is not the one
	// JSON object the parser below expects.
	Stream         bool `json:"stream"`
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
func (c *Client) ask(ctx context.Context, message string, prior []Turn) (draft, string, error) {
	raw, answered, err := c.complete(ctx, history(prior, message))
	if err != nil {
		return draft{}, answered, err
	}
	var d draft
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		return draft{}, answered, fmt.Errorf("the model's answer was not the shape asked for: %w", err)
	}
	return d, answered, nil
}

// complete sends one conversation and returns the model's content, which is asked for as a JSON
// object. `ask` builds the intent draft on it; `Ask` in ask.go runs its read loop on it. The HTTP
// half is here once so that a status, a non-JSON body and an empty choice list are reported the
// same way by every upstream.
//
// **Each upstream is asked in turn and the first answer wins.** A router being down is a reason to
// ask the other one, not a reason to tell somebody the conversation is off — and the two here are
// separate machines belonging to separate people, so neither failing takes the other with it.
//
// There is no check on the caller's context between attempts: `net/http` refuses a request on a
// cancelled context before it reaches the wire, so a guard here would decide nothing that a test
// could tell apart from its absence.
func (c *Client) complete(ctx context.Context, messages []chatMessage) (string, string, error) {
	if !c.Configured() {
		return "", "", ErrNotConfigured
	}
	var last error
	var answered string
	for _, u := range c.ups {
		answered = family(u.Model)
		content, err := c.completeOne(ctx, u, messages)
		if err == nil {
			return content, answered, nil
		}
		last = err
	}
	// The name of the one that failed last, so a caller can say which model was reached rather
	// than which one was asked for. A fallback that answered invisibly would leave the picker
	// naming a model that did not reply.
	return "", answered, last
}

// completeOne is one call to one upstream.
func (c *Client) completeOne(ctx context.Context, u Upstream, messages []chatMessage) (string, error) {
	body := chatRequest{
		Model:       u.Model,
		Stream:      false,
		Temperature: 0,
		Messages:    messages,
	}
	body.ResponseFormat.Type = "json_object"

	buf, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.BaseURL+"/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	// One `Authorization` header, and a proxy in front of the router has first claim on it: it
	// answers with its own 401 before the router sees the request at all. So where basic
	// credentials exist they take the header and the key moves to `X-Api-Key`, which is the other
	// place a router looks. Where they do not, `Bearer` is the ordinary arrangement and there is
	// no second copy of the key in a header the endpoint did not ask for.
	if u.User != "" {
		req.SetBasicAuth(u.User, u.Pass)
		req.Header.Set("X-Api-Key", u.Key)
	} else {
		req.Header.Set("Authorization", "Bearer "+u.Key)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("the model did not answer: %w", err)
	}
	defer resp.Body.Close()

	// A model that answers with a megabyte is a model that misunderstood.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
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
		return "", fmt.Errorf("the model refused: %s", detail)
	}
	if unmarshalErr != nil {
		return "", fmt.Errorf("the model's answer was not JSON: %w", unmarshalErr)
	}
	if len(out.Choices) == 0 {
		return "", errors.New("the model answered with nothing")
	}
	return out.Choices[0].Message.Content, nil
}
