package chat_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/chat"
	"github.com/0xHelico/helico/apps/be/internal/store"
)

const (
	alice = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	bob   = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func newService(t *testing.T) *chat.Service {
	t.Helper()
	db, err := store.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	at := time.Unix(1_800_000_000, 0)
	return chat.NewService(db).WithClock(func() time.Time { at = at.Add(time.Second); return at })
}

func TestAConversationHoldsItsTurnsInOrder(t *testing.T) {
	ctx := context.Background()
	s := newService(t)

	c, err := s.Start(ctx, alice, "Swap half an ETH into USDC")
	if err != nil {
		t.Fatal(err)
	}
	if c.Title != "Swap half an ETH into USDC" {
		t.Fatalf("title %q", c.Title)
	}
	if _, err := s.Append(ctx, alice, c.ID, "user", "Swap half an ETH into USDC", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(ctx, alice, c.ID, "assistant", "Swapping 0.5 ETH", json.RawMessage(`{"chainId":42161}`)); err != nil {
		t.Fatal(err)
	}

	msgs, err := s.Messages(ctx, alice, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 || msgs[0].Role != "user" || msgs[1].Role != "assistant" {
		t.Fatalf("messages %+v", msgs)
	}
	if string(msgs[1].Intent) != `{"chainId":42161}` {
		t.Fatalf("intent came back as %q", msgs[1].Intent)
	}
	if msgs[0].Intent != nil {
		t.Fatalf("a message with no intent came back with %q", msgs[0].Intent)
	}
}

// The whole point of the owner being in every query.
func TestOneAddressCannotSeeAnother(t *testing.T) {
	ctx := context.Background()
	s := newService(t)

	c, err := s.Start(ctx, alice, "mine")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Append(ctx, alice, c.ID, "user", "mine", nil); err != nil {
		t.Fatal(err)
	}

	if list, err := s.List(ctx, bob); err != nil || len(list) != 0 {
		t.Fatalf("bob sees %v (%v)", list, err)
	}
	if _, err := s.Messages(ctx, bob, c.ID); !errors.Is(err, chat.ErrNotFound) {
		t.Fatalf("bob reading alice's conversation: %v, want ErrNotFound", err)
	}
	if _, err := s.Append(ctx, bob, c.ID, "user", "intruding", nil); !errors.Is(err, chat.ErrNotFound) {
		t.Fatalf("bob appending to alice's conversation: %v, want ErrNotFound", err)
	}
	if err := s.Delete(ctx, bob, c.ID); !errors.Is(err, chat.ErrNotFound) {
		t.Fatalf("bob deleting alice's conversation: %v, want ErrNotFound", err)
	}
	// And none of that touched it.
	if msgs, err := s.Messages(ctx, alice, c.ID); err != nil || len(msgs) != 1 {
		t.Fatalf("alice's conversation is %v (%v)", msgs, err)
	}
}

func TestTheListIsMostRecentlyUsedFirst(t *testing.T) {
	ctx := context.Background()
	s := newService(t)

	first, _ := s.Start(ctx, alice, "first")
	second, _ := s.Start(ctx, alice, "second")

	list, err := s.List(ctx, alice)
	if err != nil || len(list) != 2 || list[0].ID != second.ID {
		t.Fatalf("after starting two: %+v (%v)", list, err)
	}
	if _, err := s.Append(ctx, alice, first.ID, "user", "still talking", nil); err != nil {
		t.Fatal(err)
	}
	list, err = s.List(ctx, alice)
	if err != nil || list[0].ID != first.ID {
		t.Fatalf("after appending to the older one: %+v (%v)", list, err)
	}
}

func TestDeleteTakesTheMessagesWithIt(t *testing.T) {
	ctx := context.Background()
	s := newService(t)

	c, _ := s.Start(ctx, alice, "doomed")
	if _, err := s.Append(ctx, alice, c.ID, "user", "hello", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, alice, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Messages(ctx, alice, c.ID); !errors.Is(err, chat.ErrNotFound) {
		t.Fatalf("messages after delete: %v", err)
	}
	if _, err := s.Append(ctx, alice, c.ID, "user", "hello again", nil); !errors.Is(err, chat.ErrNotFound) {
		t.Fatalf("append after delete: %v", err)
	}
}

func TestDeleteAllOnlyTakesTheCallersOwn(t *testing.T) {
	ctx := context.Background()
	s := newService(t)

	if _, err := s.Start(ctx, alice, "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, alice, "b"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Start(ctx, bob, "bob's"); err != nil {
		t.Fatal(err)
	}

	n, err := s.DeleteAll(ctx, alice)
	if err != nil || n != 2 {
		t.Fatalf("deleted %d (%v), want 2", n, err)
	}
	if list, _ := s.List(ctx, bob); len(list) != 1 {
		t.Fatalf("bob lost %d conversations", 1-len(list))
	}
}

func TestAppendRefusesWhatItShould(t *testing.T) {
	ctx := context.Background()
	s := newService(t)
	c, _ := s.Start(ctx, alice, "limits")

	if _, err := s.Append(ctx, alice, c.ID, "system", "hi", nil); !errors.Is(err, chat.ErrRole) {
		t.Fatalf("role: %v", err)
	}
	if _, err := s.Append(ctx, alice, c.ID, "user", "   ", nil); !errors.Is(err, chat.ErrEmpty) {
		t.Fatalf("empty: %v", err)
	}
	long := strings.Repeat("a", chat.MaxBodyRunes+1)
	if _, err := s.Append(ctx, alice, c.ID, "user", long, nil); !errors.Is(err, chat.ErrTooLong) {
		t.Fatalf("too long: %v", err)
	}
}

func TestTitleIsWhatASidebarCanShow(t *testing.T) {
	if got := chat.Title("  Swap   half an ETH \n into USDC "); got != "Swap half an ETH into USDC" {
		t.Fatalf("collapsed to %q", got)
	}
	if got := chat.Title("   "); got != "New chat" {
		t.Fatalf("empty became %q", got)
	}
	long := chat.Title(strings.Repeat("x", 200))
	if n := len([]rune(long)); n != chat.MaxTitleRunes {
		t.Fatalf("long title is %d runes, want %d", n, chat.MaxTitleRunes)
	}
	if !strings.HasSuffix(long, "…") {
		t.Fatalf("a trimmed title should say it was trimmed: %q", long)
	}
}
