// Package chat keeps a wallet's conversations. Everything here is owned by an address, and an
// address only ever sees its own.
package chat

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// Errors the HTTP layer turns into statuses.
var (
	ErrNotFound = errors.New("no such conversation")
	ErrTooMany  = errors.New("too many")
	ErrEmpty    = errors.New("a message needs something in it")
	ErrTooLong  = errors.New("message is too long")
	ErrRole     = errors.New("a message is from the user or the assistant")
)

// Bounds. A public API without them is a disk-filling service.
const (
	MaxConversations = 100
	MaxMessages      = 200
	MaxBodyRunes     = 4000
	MaxTitleRunes    = 80
)

// Message is one turn. Intent is the checked swap the backend produced, when there was one;
// it is stored as it was sent so the page redraws exactly what the person saw.
type Message struct {
	ID        string          `json:"id"`
	Role      string          `json:"role"`
	Body      string          `json:"body"`
	Intent    json.RawMessage `json:"intent,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
}

// Conversation is a titled thread of messages.
type Conversation struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Store is the persistence the service needs. Every method takes the owner, and the owner is
// part of the query rather than checked afterwards — so a conversation belonging to someone
// else is not found, which is also all a stranger learns about it.
type Store interface {
	CreateConversation(ctx context.Context, owner string, c Conversation) error
	ListConversations(ctx context.Context, owner string, limit int) ([]Conversation, error)
	CountConversations(ctx context.Context, owner string) (int, error)
	DeleteConversation(ctx context.Context, owner, id string) error
	DeleteConversations(ctx context.Context, owner string) (int, error)
	AppendMessage(ctx context.Context, owner, conversation string, m Message, at time.Time) error
	CountMessages(ctx context.Context, owner, conversation string) (int, error)
	Messages(ctx context.Context, owner, conversation string) ([]Message, error)
}

// Service is the rules around the store.
type Service struct {
	store Store
	now   func() time.Time
}

// NewService returns a service over store.
func NewService(store Store) *Service { return &Service{store: store, now: time.Now} }

// WithClock replaces the clock, for tests.
func (s *Service) WithClock(now func() time.Time) *Service { s.now = now; return s }

// NewID returns an opaque, unguessable id. Unguessable matters: an id is the only thing
// distinguishing one conversation from another in a URL.
func NewID() string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand does not fail in practice, and a predictable id would be worse than a panic.
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

// Title trims a first message into something a sidebar can show.
func Title(body string) string {
	t := strings.Join(strings.Fields(body), " ")
	if t == "" {
		return "New chat"
	}
	if utf8.RuneCountInString(t) > MaxTitleRunes {
		return string([]rune(t)[:MaxTitleRunes-1]) + "…"
	}
	return t
}

// Start opens a conversation. The title comes from the first message when there is one.
func (s *Service) Start(ctx context.Context, owner, firstMessage string) (Conversation, error) {
	n, err := s.store.CountConversations(ctx, owner)
	if err != nil {
		return Conversation{}, err
	}
	if n >= MaxConversations {
		return Conversation{}, ErrTooMany
	}
	now := s.now().UTC().Truncate(time.Second)
	c := Conversation{ID: NewID(), Title: Title(firstMessage), CreatedAt: now, UpdatedAt: now}
	if err := s.store.CreateConversation(ctx, owner, c); err != nil {
		return Conversation{}, err
	}
	return c, nil
}

// List returns the owner's conversations, newest activity first.
func (s *Service) List(ctx context.Context, owner string) ([]Conversation, error) {
	return s.store.ListConversations(ctx, owner, MaxConversations)
}

// Messages returns one conversation's turns, oldest first.
func (s *Service) Messages(ctx context.Context, owner, id string) ([]Message, error) {
	return s.store.Messages(ctx, owner, id)
}

// Append adds a turn and moves the conversation to the top of the list.
func (s *Service) Append(ctx context.Context, owner, id, role, body string, intent json.RawMessage) (Message, error) {
	if role != "user" && role != "assistant" {
		return Message{}, ErrRole
	}
	if strings.TrimSpace(body) == "" {
		return Message{}, ErrEmpty
	}
	if utf8.RuneCountInString(body) > MaxBodyRunes {
		return Message{}, ErrTooLong
	}
	n, err := s.store.CountMessages(ctx, owner, id)
	if err != nil {
		return Message{}, err
	}
	if n >= MaxMessages {
		return Message{}, ErrTooMany
	}
	now := s.now().UTC().Truncate(time.Second)
	m := Message{ID: NewID(), Role: role, Body: body, Intent: intent, CreatedAt: now}
	if err := s.store.AppendMessage(ctx, owner, id, m, now); err != nil {
		return Message{}, err
	}
	return m, nil
}

// Delete removes one conversation and its messages.
func (s *Service) Delete(ctx context.Context, owner, id string) error {
	return s.store.DeleteConversation(ctx, owner, id)
}

// DeleteAll removes every conversation this address owns, and says how many.
func (s *Service) DeleteAll(ctx context.Context, owner string) (int, error) {
	return s.store.DeleteConversations(ctx, owner)
}
