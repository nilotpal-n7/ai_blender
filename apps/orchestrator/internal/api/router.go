package api

import (
	"github.com/ai-blender/orchestrator/internal/config"
	"github.com/ai-blender/orchestrator/internal/queue"
	"github.com/gin-gonic/gin"
)

// NewRouter creates and configures the Gin engine with all route groups.
// It accepts a queue client for dependency injection into handlers.
func NewRouter(cfg *config.Config, queueClient *queue.Client) *gin.Engine {
	router := gin.Default()

	// Create handler with dependencies
	h := NewHandler(queueClient)

	// ─── Global Middleware ──────────────────────────────────────────
	router.Use(CORSMiddleware())

	// ─── API v1 ─────────────────────────────────────────────────────
	v1 := router.Group("/api/v1")
	{
		// Health check
		v1.GET("/health", h.HealthCheck)

		// Scene management
		scene := v1.Group("/scene")
		{
			scene.POST("/create", h.SceneCreate)
			scene.GET("/:id", h.SceneGet)
			scene.POST("/:id/prompt", h.ScenePrompt)
			scene.POST("/:id/override", h.SceneOverride)
		}

		// Job status
		job := v1.Group("/job")
		{
			job.GET("/:id/status", h.JobStatus)
		}
	}

	return router
}

// CORSMiddleware allows cross-origin requests from the Next.js frontend.
func CORSMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}
