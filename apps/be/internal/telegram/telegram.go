// Package telegram is the Bot API and the commands, for a bot that cannot sign.
//
// **The constraint that shapes the whole package.** Every safety argument in `contracts/` rests on
// two facts: the owner's wallet signs, and the agent's reach is the owner's allowlist.
// `HelicoAccount._requireOwnerOrAgent` admits `owner()` or the nominated agent and nobody else. A
// Telegram process is neither and must stay neither, because one compromised bot token would
// otherwise reach every account that ever talked to it. So no private key reaches this code, and
// the most powerful thing it does is read public data and format it.
//
// **A chat id is not an identity either.** This slice answers only about an address somebody types
// into the chat, which is public chain data whoever asks. Nothing here is personal, which is
// exactly why it could be built without the signing bind #218 designs — and the group refusal
// below is kept anyway, so that it is already true on the day the bind lands.
//
// The Bot API client lives here rather than in `packages/plugins/telegram` as #218 proposed,
// because `apps/be` is Go and cannot consume a TypeScript package. The plugins rule is about
// protocol knowledge living in one place its consumer owns; here the only consumer is this
// backend, which `contracts/` already establishes the precedent for on the on-chain side.
package telegram

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

// Update is the part of Telegram's update object this package reads.
//
// Every field is optional on purpose. An update carrying an edited message, a channel post, a poll
// answer or a field invented after this was written must not be a panic, so the handler checks
// rather than assumes.
type Update struct {
	UpdateID int64 `json:"update_id"`
	Message  *struct {
		MessageID int64 `json:"message_id"`
		From      *struct {
			ID        int64  `json:"id"`
			IsBot     bool   `json:"is_bot"`
			FirstName string `json:"first_name"`
			Username  string `json:"username"`
		} `json:"from"`
		Chat *struct {
			ID int64 `json:"id"`
			// "private", "group", "supergroup" or "channel". The last three answer nothing.
			Type string `json:"type"`
		} `json:"chat"`
		Text string `json:"text"`
	} `json:"message"`
}

// Command is a parsed message: the verb and whatever followed it.
type Command struct {
	Name string
	Args []string
	// Chat and User are where to answer and who asked. Zero for an update carrying no message.
	Chat int64
	User int64
	// Private is false for a group, a supergroup or a channel.
	Private bool
}

// ErrNotConfigured is what the caller turns into a 404. A deployment with no token has no bot, and
// a route that answers anything at all would be surface for no feature.
var ErrNotConfigured = errors.New("no telegram token is configured")

// Parse reads a command out of an update.
//
// `false` for anything that is not a message from a person starting with a slash: a photo, an
// edited message, another bot, an update shape this does not know. Telegram retries an update it
// considers undelivered, so the caller answers 200 to all of them and simply does nothing with the
// ones that are not commands.
//
// `/portfolio@HelicoBot 0xabc` is the same command as `/portfolio 0xabc`. Telegram appends the
// bot's username in group chats, and a parser that did not strip it would answer nothing in
// exactly the place where several bots are listening.
func Parse(u Update) (Command, bool) {
	if u.Message == nil || u.Message.Chat == nil || u.Message.From == nil {
		return Command{}, false
	}
	if u.Message.From.IsBot {
		return Command{}, false
	}
	text := strings.TrimSpace(u.Message.Text)
	if !strings.HasPrefix(text, "/") {
		return Command{}, false
	}
	parts := strings.Fields(text)
	if len(parts) == 0 {
		return Command{}, false
	}
	name := strings.ToLower(strings.TrimPrefix(parts[0], "/"))
	if at := strings.IndexByte(name, '@'); at >= 0 {
		name = name[:at]
	}
	if name == "" {
		return Command{}, false
	}
	return Command{
		Name:    name,
		Args:    parts[1:],
		Chat:    u.Message.Chat.ID,
		User:    u.Message.From.ID,
		Private: u.Message.Chat.Type == "private",
	}, true
}

// Client sends messages. Small enough that a test hands over a URL rather than an interface.
type Client struct {
	token string
	base  string
	http  *http.Client
}

// NewClient builds one. An empty token leaves it unconfigured and `Configured` says so.
func NewClient(token, baseURL string, timeout time.Duration) *Client {
	if baseURL == "" {
		baseURL = "https://api.telegram.org"
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{
		token: token,
		base:  strings.TrimSuffix(baseURL, "/"),
		http:  &http.Client{Timeout: timeout},
	}
}

// Configured reports whether there is a bot at all.
func (c *Client) Configured() bool { return c != nil && c.token != "" }

// Send posts one message to a chat.
//
// `disable_web_page_preview` because an address in a reply is not a link anybody wants unfurled,
// and Markdown is deliberately not used: a balance rendered through a formatter that treats `_`
// and `*` as syntax is a balance that can come out wrong, and none of these replies needs it.
func (c *Client) Send(ctx context.Context, chat int64, text string) error {
	if !c.Configured() {
		return ErrNotConfigured
	}
	body, err := json.Marshal(map[string]any{
		"chat_id":                  chat,
		"text":                     text,
		"disable_web_page_preview": true,
	})
	if err != nil {
		return err
	}
	// The token is in the path, which is how the Bot API works. It is never logged: the error
	// below carries the status and the API's own description, not the URL.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/bot%s/sendMessage", c.base, c.token), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("telegram did not answer: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return err
	}
	var answer struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	// A non-JSON body from a gateway is a status to report rather than a shape to complain about.
	if err := json.Unmarshal(raw, &answer); err != nil {
		return fmt.Errorf("telegram answered %s", res.Status)
	}
	if !answer.OK {
		return fmt.Errorf("telegram refused: %s", answer.Description)
	}
	return nil
}
