package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTheEnvironmentWinsOverTheFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	body := "" +
		"# a comment\n" +
		"\n" +
		"BE_LLM_API_KEY=from-the-file\n" +
		"export BE_LLM_MODEL = gpt-4o-mini \n" +
		"BE_ADMIN_TOKEN=\"one two\"\n" +
		"BE_DB_PATH='data/helico.db'\n" +
		"not a pair\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	env := map[string]string{"BE_LLM_API_KEY": "from-the-environment"}
	lookup := DotEnv(path, func(k string) (string, bool) { v, ok := env[k]; return v, ok })

	for _, c := range []struct{ key, want string }{
		// The one the environment also sets. A deployed host with a stray file must keep what the
		// platform gave it, or the file is a way to change a running server's configuration.
		{"BE_LLM_API_KEY", "from-the-environment"},
		{"BE_LLM_MODEL", "gpt-4o-mini"},
		{"BE_ADMIN_TOKEN", "one two"},
		{"BE_DB_PATH", "data/helico.db"},
	} {
		got, ok := lookup(c.key)
		if !ok || got != c.want {
			t.Errorf("%s = %q (%v), want %q", c.key, got, ok, c.want)
		}
	}
	if _, ok := lookup("BE_ADDR"); ok {
		t.Error("a key nobody set was answered")
	}
	if _, ok := lookup("not a pair"); ok {
		t.Error("a line with no = became a variable")
	}
}

// The normal case everywhere but a laptop.
func TestNoFileIsNotAFailure(t *testing.T) {
	lookup := DotEnv(filepath.Join(t.TempDir(), "nothing-here"), func(string) (string, bool) {
		return "", false
	})
	if _, ok := lookup("BE_ADDR"); ok {
		t.Error("a missing file answered a lookup")
	}
	if _, err := FromEnv(lookup); err != nil {
		t.Errorf("defaults did not load without a file: %v", err)
	}
}
