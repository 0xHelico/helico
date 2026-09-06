package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/0xHelico/helico/apps/be/internal/chat"
)

// Every statement below carries the owner. That is the access check: a conversation belonging
// to another address does not appear, cannot be appended to, and cannot be deleted — and a
// stranger learns nothing about whether it exists.

// CreateConversation inserts a new conversation for owner.
func (s *SQLite) CreateConversation(ctx context.Context, owner string, c chat.Conversation) error {
	s.write.Lock()
	defer s.write.Unlock()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO conversations (id, owner, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		c.ID, owner, c.Title, c.CreatedAt.Unix(), c.UpdatedAt.Unix())
	if err != nil {
		return fmt.Errorf("create conversation: %w", err)
	}
	return nil
}

// ListConversations returns up to limit of owner's conversations, most recent activity first.
func (s *SQLite) ListConversations(ctx context.Context, owner string, limit int) ([]chat.Conversation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, title, created_at, updated_at FROM conversations
		 WHERE owner = ? ORDER BY updated_at DESC, id DESC LIMIT ?`, owner, limit)
	if err != nil {
		return nil, fmt.Errorf("list conversations: %w", err)
	}
	defer rows.Close()
	out := make([]chat.Conversation, 0, 16)
	for rows.Next() {
		var c chat.Conversation
		var created, updated int64
		if err := rows.Scan(&c.ID, &c.Title, &created, &updated); err != nil {
			return nil, err
		}
		c.CreatedAt = time.Unix(created, 0).UTC()
		c.UpdatedAt = time.Unix(updated, 0).UTC()
		out = append(out, c)
	}
	return out, rows.Err()
}

// CountConversations is how many owner already has.
func (s *SQLite) CountConversations(ctx context.Context, owner string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversations WHERE owner = ?`, owner).Scan(&n)
	return n, err
}

// DeleteConversation removes one, or returns chat.ErrNotFound.
func (s *SQLite) DeleteConversation(ctx context.Context, owner, id string) error {
	s.write.Lock()
	defer s.write.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM conversations WHERE owner = ? AND id = ?`, owner, id)
	if err != nil {
		return fmt.Errorf("delete conversation: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return chat.ErrNotFound
	}
	return nil
}

// DeleteConversations removes all of owner's, and says how many went.
func (s *SQLite) DeleteConversations(ctx context.Context, owner string) (int, error) {
	s.write.Lock()
	defer s.write.Unlock()
	res, err := s.db.ExecContext(ctx, `DELETE FROM conversations WHERE owner = ?`, owner)
	if err != nil {
		return 0, fmt.Errorf("delete conversations: %w", err)
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// AppendMessage adds a turn and moves the conversation to the top of the owner's list. Both
// happen or neither does: a message in a conversation that did not move would sort wrong
// forever, and a message on a conversation the owner does not have must not be written at all.
func (s *SQLite) AppendMessage(ctx context.Context, owner, conversation string, m chat.Message, at time.Time) error {
	s.write.Lock()
	defer s.write.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `UPDATE conversations SET updated_at = ? WHERE owner = ? AND id = ?`,
		at.Unix(), owner, conversation)
	if err != nil {
		return fmt.Errorf("touch conversation: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return chat.ErrNotFound
	}
	intent := ""
	if len(m.Intent) > 0 {
		intent = string(m.Intent)
	}
	// The next sequence number is read and written inside the same transaction, so two turns
	// racing cannot take the same one — and the unique index would refuse them if they did.
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO chat_messages (id, conversation_id, seq, role, body, intent, created_at)
		 VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE conversation_id = ?), ?, ?, ?, ?)`,
		m.ID, conversation, conversation, m.Role, m.Body, intent, m.CreatedAt.Unix()); err != nil {
		return fmt.Errorf("append message: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// CountMessages is how many turns a conversation holds, or chat.ErrNotFound.
func (s *SQLite) CountMessages(ctx context.Context, owner, conversation string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM chat_messages m
		 JOIN conversations c ON c.id = m.conversation_id
		 WHERE c.owner = ? AND c.id = ?`, owner, conversation).Scan(&n)
	if err != nil {
		return 0, err
	}
	if n == 0 {
		// Zero messages and no such conversation look the same from a count, so ask.
		var exists int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversations WHERE owner = ? AND id = ?`,
			owner, conversation).Scan(&exists); err != nil {
			return 0, err
		}
		if exists == 0 {
			return 0, chat.ErrNotFound
		}
	}
	return n, nil
}

// Messages returns a conversation's turns oldest first, or chat.ErrNotFound.
func (s *SQLite) Messages(ctx context.Context, owner, conversation string) ([]chat.Message, error) {
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conversations WHERE owner = ? AND id = ?`,
		owner, conversation).Scan(&exists); err != nil {
		return nil, err
	}
	if exists == 0 {
		return nil, chat.ErrNotFound
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, role, body, intent, created_at FROM chat_messages
		 WHERE conversation_id = ? ORDER BY seq`, conversation)
	if err != nil {
		return nil, fmt.Errorf("messages: %w", err)
	}
	defer rows.Close()
	out := make([]chat.Message, 0, 16)
	for rows.Next() {
		var m chat.Message
		var intent string
		var created int64
		if err := rows.Scan(&m.ID, &m.Role, &m.Body, &intent, &created); err != nil {
			return nil, err
		}
		if intent != "" {
			m.Intent = json.RawMessage(intent)
		}
		m.CreatedAt = time.Unix(created, 0).UTC()
		out = append(out, m)
	}
	return out, rows.Err()
}
