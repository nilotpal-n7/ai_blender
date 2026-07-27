package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/ai-blender/orchestrator/internal/api"
	"github.com/ai-blender/orchestrator/internal/config"
	"github.com/ai-blender/orchestrator/internal/queue"
)

func main() {
	// Load configuration from environment variables
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize Redis queue client
	queueClient, err := queue.NewClient(cfg.RedisAddr, cfg.RedisPassword)
	if err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	defer queueClient.Close()

	// Initialize router with all middleware, routes, and dependencies
	router := api.NewRouter(cfg, queueClient)

	// Graceful shutdown listener
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		addr := fmt.Sprintf(":%s", cfg.Port)
		log.Printf("🚀 Orchestrator starting on %s", addr)
		if err := router.Run(addr); err != nil {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	<-quit
	log.Println("🛑 Orchestrator shutting down gracefully...")
}
