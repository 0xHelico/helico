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
	if cfg.Addr != ":8787" || cfg.DBPath != "data/helico.db" || cfg.AdminToken != "" || len(cfg.CORSOrigins) != 4 || cfg.RequestTimeout != 10*time.Second {
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

// **The swap route's budget is derived, so nothing has to be refused.** It used to be a check on
// two numbers in tension: a model given longer than the request that wraps it could never finish.
// The chain of models is now one whole call per model on a route with its own budget, so every
// combination is reachable.
func TestTheSwapBudgetHoldsTheWholeChainOfModels(t *testing.T) {
	env := map[string]string{
		"BE_LLM_API_KEY":           "primary",
		"BE_LLM_FALLBACK_BASE_URL": "https://router.example/v1",
	}
	read := func() Config {
		cfg, err := FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}

	// A base URL with no key is a half-written entry, not a model. The client drops it, so the
	// budget must count one rather than two or the route waits for an upstream that never runs.
	one := read()
	if one.SwapBudget != one.LLMTimeout+2*time.Second {
		t.Errorf("budget %s for one model of %s", one.SwapBudget, one.LLMTimeout)
	}

	env["BE_LLM_FALLBACK_API_KEY"] = "second"
	two := read()
	if two.SwapBudget < two.LLMTimeout*2 {
		t.Errorf("budget %s cannot hold two models of %s", two.SwapBudget, two.LLMTimeout)
	}
	// And it is the route's budget, not everyone's: nothing else should hold a connection that
	// long because the chat may.
	if two.RequestTimeout >= two.SwapBudget {
		t.Errorf("request %s is not shorter than the swap route's %s", two.RequestTimeout, two.SwapBudget)
	}

	// A combination that would once have been refused is simply reachable now.
	env["BE_LLM_TIMEOUT"] = "45s"
	env["BE_REQUEST_TIMEOUT"] = "5s"
	wide := read()
	if wide.SwapBudget < 90*time.Second {
		t.Errorf("budget %s cannot hold two models of 45s", wide.SwapBudget)
	}

	// A status question reads the index between asks, so that budget is an alternative shape of
	// the same request rather than a stage of it: the larger of the two, never the sum.
	env["BE_LLM_TIMEOUT"] = "5s"
	env["BE_GRAPH_MCP_URL"] = "https://subgraphs.mcp.thegraph.example/sse"
	env["BE_GRAPH_MCP_TIMEOUT"] = "40s"
	indexed := read()
	if indexed.SwapBudget != 42*time.Second {
		t.Errorf("budget %s, want the index's 40s plus two", indexed.SwapBudget)
	}

	// And an index nobody configured does not buy the route a budget it has no use for.
	delete(env, "BE_GRAPH_MCP_URL")
	if off := read(); off.SwapBudget == 42*time.Second {
		t.Errorf("an unconfigured index still set the budget to %s", off.SwapBudget)
	}
}

// The model's own timeout is still read from the environment, and a bad duration is still an error.
func TestTheModelTimeoutIsStillConfigurable(t *testing.T) {
	env := map[string]string{"BE_LLM_TIMEOUT": "4s"}
	cfg, err := FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LLMTimeout != 4*time.Second {
		t.Errorf("llm timeout = %s", cfg.LLMTimeout)
	}
	env["BE_LLM_TIMEOUT"] = "whenever"
	if _, err := FromEnv(func(k string) (string, bool) { v, ok := env[k]; return v, ok }); err == nil {
		t.Error("a bad duration must be an error")
	}
}
