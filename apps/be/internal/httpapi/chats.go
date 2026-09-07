package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/0xHelico/helico/apps/be/internal/chat"
)

// maxChatBody bounds a message body; the service caps the text itself at 4000 runes and the
// intent is a small object.
const maxChatBody = 64 << 10

// chatsDisabled answers when the process has no chat service — which happens only if the
// database could not be opened, and the caller deserves to be told rather than 404'd.
func (a *api) chatsReady(w http.ResponseWriter) bool {
	if a.chats == nil {
		writeProblem(w, http.StatusServiceUnavailable, "conversations are not available")
		return false
	}
	return true
}

func (a *api) listChats(w http.ResponseWriter, r *http.Request, owner string) {
	if !a.chatsReady(w) {
		return
	}
	list, err := a.chats.List(r.Context(), owner)
	if err != nil {
		a.chatFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": list})
}

func (a *api) startChat(w http.ResponseWriter, r *http.Request, owner string) {
	if !a.chatsReady(w) {
		return
	}
	var body struct {
		Message string `json:"message"`
	}
	// A body is optional: "New chat" opens an untitled one.
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, maxChatBody)).Decode(&body)

	c, err := a.chats.Start(r.Context(), owner, body.Message)
	if err != nil {
		a.chatFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (a *api) getChat(w http.ResponseWriter, r *http.Request, owner string) {
	if !a.chatsReady(w) {
		return
	}
	msgs, err := a.chats.Messages(r.Context(), owner, r.PathValue("id"))
	if err != nil {
		a.chatFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}

func (a *api) appendMessage(w http.ResponseWriter, r *http.Request, owner string) {
	if !a.chatsReady(w) {
		return
	}
	var body struct {
		Role   string          `json:"role"`
		Body   string          `json:"body"`
		Intent json.RawMessage `json:"intent"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxChatBody)).Decode(&body); err != nil {
		writeProblem(w, http.StatusBadRequest, "send role and body")
		return
	}
	m, err := a.chats.Append(r.Context(), owner, r.PathValue("id"), body.Role, body.Body, body.Intent)
	if err != nil {
		a.chatFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (a *api) deleteChat(w http.ResponseWriter, r *http.Request, owner string) {
	if !a.chatsReady(w) {
		return
	}
	if err := a.chats.Delete(r.Context(), owner, r.PathValue("id")); err != nil {
		a.chatFail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) deleteChats(w http.ResponseWriter, r *http.Request, owner string) {
	if !a.chatsReady(w) {
		return
	}
	n, err := a.chats.DeleteAll(r.Context(), owner)
	if err != nil {
		a.chatFail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n})
}

// chatFail maps the service's errors to statuses. A conversation the caller does not own is
// 404, not 403: whether it exists is the owner's business too.
func (a *api) chatFail(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, chat.ErrNotFound):
		writeProblem(w, http.StatusNotFound, "no such conversation")
	case errors.Is(err, chat.ErrRole):
		writeProblem(w, http.StatusBadRequest, "a message is from the user or the assistant")
	case errors.Is(err, chat.ErrEmpty):
		writeProblem(w, http.StatusBadRequest, "a message needs something in it")
	case errors.Is(err, chat.ErrTooLong):
		writeProblem(w, http.StatusBadRequest, "that message is too long")
	case errors.Is(err, chat.ErrTooMany):
		writeProblem(w, http.StatusConflict, "you have reached the limit — delete something first")
	default:
		a.opt.Logger.Error("chat", "err", err, "path", r.URL.Path, "request_id", requestIDFrom(r))
		writeProblem(w, http.StatusInternalServerError, "")
	}
}
