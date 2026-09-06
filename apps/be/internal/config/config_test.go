package config

import (
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
	if cfg.Addr != ":8787" || cfg.DBPath != "data/helico.db" || cfg.AdminToken != "" || len(cfg.CORSOrigins) != 2 || cfg.RequestTimeout != 10*time.Second {
		t.Errorf("defaults: %+v", cfg)
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
