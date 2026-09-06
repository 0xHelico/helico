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
