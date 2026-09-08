package config

import (
	"bufio"
	"os"
	"strings"
)

// DotEnv wraps a Lookup so a missing variable falls back to `key=value` lines in a file.
//
// The backend has no configuration file and should not grow one: a deployment sets variables, and
// something that reads a file on a server is something that can be edited on a server. This is
// for the other case — a local run, where the alternative is remembering to prefix every `go run`
// with four assignments, and where forgetting one produces a symptom (no model, a session that
// does not last) rather than a message.
//
// **The environment always wins.** The file only answers what the environment does not, so a
// stray `.env` on a deployed host cannot quietly replace what the platform set. A missing or
// unreadable file is not an error: it is the normal case everywhere but a laptop.
func DotEnv(path string, env Lookup) Lookup {
	file := readDotEnv(path)
	return func(key string) (string, bool) {
		if v, ok := env(key); ok {
			return v, true
		}
		v, ok := file[key]
		return v, ok
	}
}

func readDotEnv(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()

	lines := bufio.NewScanner(f)
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		// Quotes are how a value keeps its spaces, and they are not part of it. Only a matching
		// pair is stripped: a key whose value genuinely starts with one is left alone.
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		}
		if key != "" {
			out[key] = value
		}
	}
	return out
}
