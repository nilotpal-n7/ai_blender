package config

import (
	"fmt"
	"os"
)

// Config holds all environment-based configuration for the orchestrator.
type Config struct {
	Port          string // HTTP server port (default: "8080")
	RedisAddr     string // Redis address (default: "localhost:6379")
	RedisPassword string // Redis password (default: "")
}

// Load reads configuration from environment variables with sensible defaults.
func Load() (*Config, error) {
	cfg := &Config{
		Port:          getEnv("ORCHESTRATOR_PORT", "8080"),
		RedisAddr:     getEnv("REDIS_ADDR", "localhost:6379"),
		RedisPassword: getEnv("REDIS_PASSWORD", ""),
	}

	if cfg.Port == "" {
		return nil, fmt.Errorf("ORCHESTRATOR_PORT must not be empty")
	}

	return cfg, nil
}

// getEnv returns the value of an environment variable or a fallback default.
func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}
