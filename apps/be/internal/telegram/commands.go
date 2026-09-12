package telegram

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Reader is what the commands need to answer, and no more.
//
// Deliberately narrow. The handlers formatting a reply have no business holding a database handle
// or an RPC client, and a test hands over a struct rather than standing up either.
type Reader interface {
	// Holding is what an account holds, in base units of USDC: idle, and at work in a market.
	Holding(ctx context.Context, owner string) (idle, working uint64, err error)
	// Moves is how many times the agent has moved capital for this account, and when it last did.
	// A zero timestamp means never.
	Moves(ctx context.Context, owner string) (count int, lastUnix int64, err error)
}

// Service answers commands. It holds no key and can send no transaction.
type Service struct {
	client *Client
	read   Reader
}

// New builds one.
func New(client *Client, read Reader) *Service {
	return &Service{client: client, read: read}
}

// Configured reports whether there is a bot to serve. Both halves: a client with no token cannot
// reply, and a service with no reader cannot answer, and neither is a route worth exposing.
func (s *Service) Configured() bool {
	return s != nil && s.client.Configured() && s.read != nil
}

/*
The one-screen answer to "what is this", which is the reply to both `/start` and `/help`.

It says what the bot cannot do before what it can. A person arriving at a bot that talks about
money wants to know what it is able to do to them, and the honest answer — nothing — is the most
reassuring sentence available and also the most important one to get right.
*/
const help = `Helico reads your account out loud. It cannot move anything.

/portfolio <address>  what that owner's Helico account holds
/moves <address>      how often the agent has moved it
/help                 this

Everything above is public chain data, so no signing and no linking. This bot holds no key: it
cannot swap, supply, or withdraw. Those need your own signature, in the app.

app.helico.site`

// The reply to a command needing an address that did not carry one. It names the shape rather than
// only complaining, because the next thing the person does is type it again.
const wantAddress = `That needs an address. Try:

/%s 0x0000000000000000000000000000000000000000

Linking a Telegram account to a wallet, so this works without one, is designed in issue #218 and
not built yet — so for now it asks rather than guessing.`

// Handle answers one command. The error is for the log; a person always gets a reply.
func (s *Service) Handle(ctx context.Context, cmd Command) error {
	if !s.Configured() {
		return ErrNotConfigured
	}

	// **A group chat answers nothing personal.** There is nothing personal in this slice, so this
	// is not protecting anything yet — it is here so that it is already true on the day a linked
	// wallet's balances become answerable, rather than being the thing somebody remembers to add.
	if !cmd.Private {
		return s.client.Send(ctx, cmd.Chat,
			"I only answer in a direct message. A balance in a group chat is somebody's balance in a group chat.")
	}

	switch cmd.Name {
	case "start", "help":
		return s.client.Send(ctx, cmd.Chat, help)

	case "portfolio":
		owner, ok := address(cmd.Args)
		if !ok {
			return s.client.Send(ctx, cmd.Chat, fmt.Sprintf(wantAddress, "portfolio"))
		}
		idle, working, err := s.read.Holding(ctx, owner)
		if err != nil {
			// The chain not answering is not the person's fault and not a reason to say nothing.
			return s.client.Send(ctx, cmd.Chat, "The chain did not answer just now. Try again in a moment.")
		}
		return s.client.Send(ctx, cmd.Chat, holdingText(owner, idle, working))

	case "moves":
		owner, ok := address(cmd.Args)
		if !ok {
			return s.client.Send(ctx, cmd.Chat, fmt.Sprintf(wantAddress, "moves"))
		}
		count, last, err := s.read.Moves(ctx, owner)
		if err != nil {
			return s.client.Send(ctx, cmd.Chat, "The chain did not answer just now. Try again in a moment.")
		}
		return s.client.Send(ctx, cmd.Chat, movesText(count, last))

	default:
		// **Answered rather than ignored.** A bot that says nothing to an unknown command is
		// indistinguishable from a bot that is down, and the person's next move is to try again.
		return s.client.Send(ctx, cmd.Chat,
			fmt.Sprintf("I do not know /%s. /help lists what I do know.", cmd.Name))
	}
}

// address picks the first argument that is one, lower-cased.
//
// Checked here rather than trusted: it goes into a chain read and a subgraph filter, and 42
// characters of hex is the whole of what either accepts.
func address(args []string) (string, bool) {
	for _, a := range args {
		s := strings.ToLower(strings.TrimSpace(a))
		if len(s) != 42 || !strings.HasPrefix(s, "0x") {
			continue
		}
		ok := true
		for _, c := range s[2:] {
			if !strings.ContainsRune("0123456789abcdef", c) {
				ok = false
				break
			}
		}
		if ok {
			return s, true
		}
	}
	return "", false
}

/*
usdc formats base units as a figure with two decimals.

**Rounded, not truncated, because the dapp rounds.** Truncating is defensible on its own — a
balance understated is safer than one overstated — but the portfolio page renders 1497196 as
`1.50` and the first version of this rendered it as `1.49`. Two surfaces disagreeing about one
balance is worse than either rule, and a person comparing them has no way to tell which is lying.

Integer throughout: a float here is a rounding error in somebody's money. Half rounds away from
zero, which is what `toLocaleString` does on the other side.
*/
func usdc(v uint64) string {
	cents := (v + 5_000) / 10_000
	return fmt.Sprintf("%d.%02d", cents/100, cents%100)
}

func short(a string) string {
	if len(a) < 10 {
		return a
	}
	return a[:6] + "…" + a[len(a)-4:]
}

/*
What an account holds.

**Zero is a measurement and says so.** "Nothing in it yet" is the answer for an account that was
read and found empty, which is a different fact from an account nobody could read — and that
second case never reaches here, because a failed read is answered above.
*/
func holdingText(owner string, idle, working uint64) string {
	total := idle + working
	if total == 0 {
		return fmt.Sprintf("%s holds nothing yet.\n\nMoney moved into a Helico account shows up here.", short(owner))
	}
	return fmt.Sprintf("%s\n\n%s USDC\n%s liquid · %s earning\n\nThe agent moves the liquid part into whichever lending market pays most.",
		short(owner), usdc(total), usdc(idle), usdc(working))
}

// How often the agent has acted. The count is what the account's own log carries, so it is a fact
// about the chain rather than about our database.
func movesText(count int, lastUnix int64) string {
	if count == 0 {
		return "The agent has not moved anything on that account yet.\n\nIt moves when the gain clears the gas, so a small balance can sit a long time."
	}
	times := "times"
	if count == 1 {
		times = "time"
	}
	if lastUnix == 0 {
		return fmt.Sprintf("The agent has moved capital %d %s on that account.", count, times)
	}
	// A plain UTC stamp rather than "3 hours ago". Telegram has no timestamp markup — the first
	// version of this used Discord's `<t:…>`, which would have printed literally — and a relative
	// phrase computed here is wrong the moment the message sits unread.
	return fmt.Sprintf("The agent has moved capital %d %s on that account.\nThe last one was %s.",
		count, times, time.Unix(lastUnix, 0).UTC().Format("2 Jan 2006 15:04 UTC"))
}
