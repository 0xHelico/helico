package config

import (
	"slices"
	"testing"
	"time"
)

func TestFromEnvDefaultsAndOverrides(t *testing.T) {
	env := map[string]string{}
	lookup := func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	cfg, err := FromEnv(lookup)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":8787" || cfg.DBPath != "data/helico.db" || cfg.AdminToken != "" || len(cfg.CORSOrigins) != 4 || cfg.RequestTimeout != 30*time.Second {
		t.Errorf("defaults: %+v", cfg)
	}
	// Named rather than counted. The dapp's own port was missing from this list for as long as
	// the list existed, and a length check is exactly what does not notice that.
	if !slices.Contains(cfg.CORSOrigins, "http://localhost:3000") {
		t.Errorf("a local dapp cannot call the API: %v", cfg.CORSOrigins)
	}
	env["BE_ADDR"] = "127.0.0.1:9000"
	env["BE_CORS_ORIGINS"] = "https://helico.example, https://staging.helico.example ,"
	env["BE_REQUEST_TIMEOUT"] = "3s"
	env["BE_ADMIN_TOKEN"] = " secret "
	cfg, err = FromEnv(lookup)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:9000" || len(cfg.CORSOrigins) != 2 || cfg.CORSOrigins[1] != "https://staging.helico.example" || cfg.RequestTimeout != 3*time.Second || cfg.AdminToken != "secret" {
		t.Errorf("overrides: %+v", cfg)
	}
	env["BE_REQUEST_TIMEOUT"] = "soon"
	if _, err := FromEnv(lookup); err == nil {
		t.Error("a bad duration must be an error")
	}
}

// One set of variables is one model; a second set with a key is a fallback. An entry with no key
// is not a model, so it must not spend a slice of the request's budget it can never use.
func TestASecondModelIsOnlyConfiguredWhenItHasAKey(t *testing.T) {
	env := map[string]string{
		"BE_LLM_API_KEY":           "primary",
		"BE_LLM_FALLBACK_BASE_URL": "https://router.example/v1",
	}
	cfg, err := FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	// A base URL without a key is a half-written entry. The client drops it, so the budget check
	// here must count one model rather than two.
	if cfg.LLMTimeout != 12*time.Second {
		t.Errorf("timeout %s, want the full budget for the one model that exists", cfg.LLMTimeout)
	}

	env["BE_LLM_FALLBACK_API_KEY"] = "second"
	env["BE_REQUEST_TIMEOUT"] = "20s"
	cfg, err = FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	// **Both have to fit.** Two models at twelve seconds each cannot finish inside twenty, and a
	// fallback that can never be reached is worse than none: it looks like cover it does not give.
	if cfg.LLMTimeout*2 >= cfg.RequestTimeout {
		t.Errorf("two models of %s do not fit in %s", cfg.LLMTimeout, cfg.RequestTimeout)
	}

	// And an operator who wrote that combination deliberately is told, not quietly corrected.
	env["BE_LLM_TIMEOUT"] = "12s"
	if _, err := FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok }); err == nil {
		t.Error("two 12s models inside a 20s request must be refused")
	}
}

func TestFromEnvRefusesAModelTimeoutThatCannotBeReached(t *testing.T) {
	// The request timeout wraps the model call, so a longer model timeout is unreachable and the
	// failure looks exactly like an unset key.
	env := map[string]string{"BE_REQUEST_TIMEOUT": "5s", "BE_LLM_TIMEOUT": "20s"}
	if _, err := FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok }); err == nil {
		t.Fatal("want an error for a model timeout at or above the request timeout")
	}
	env["BE_LLM_TIMEOUT"] = "4s"
	cfg, err := FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMTimeout >= cfg.RequestTimeout {
		t.Fatalf("llm=%s request=%s", cfg.LLMTimeout, cfg.RequestTimeout)
	}

	// Shortening only the request timeout is not an error: the model timeout is fitted under it.
	only := map[string]string{"BE_REQUEST_TIMEOUT": "3s"}
	cfg, err = FromEnv(func(k string) (string, bool) { v, ok := only[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMTimeout != 2400*time.Millisecond {
		t.Fatalf("llm timeout = %s, want it fitted under 3s", cfg.LLMTimeout)
	}
}
