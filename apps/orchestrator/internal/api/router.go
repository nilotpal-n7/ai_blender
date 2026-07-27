package api

import (
	"github.com/ai-blender/orchestrator/internal/config"
	"github.com/ai-blender/orchestrator/internal/queue"
	"github.com/ai-blender/orchestrator/internal/scene"
	"github.com/gin-gonic/gin"
)

// NewRouter creates and configures the Gin engine with all route groups.
// It accepts a queue client and scene manager for dependency injection.
func NewRouter(cfg *config.Config, queueClient *queue.Client, sceneManager *scene.Manager) *gin.Engine {
	router := gin.Default()

	// Create handler with dependencies
	h := NewHandler(queueClient, sceneManager)

	// ─── Global Middleware ──────────────────────────────────────────
	router.Use(CORSMiddleware())

	// ─── API v1 ─────────────────────────────────────────────────────
	v1 := router.Group("/api/v1")
	{
		// Health check
		v1.GET("/health", h.HealthCheck)

		// Scene management
		sceneGroup := v1.Group("/scene")
		{
			sceneGroup.POST("/create", h.SceneCreate)
			sceneGroup.GET("/:id", h.SceneGet)
			sceneGroup.POST("/:id/prompt", h.ScenePrompt)
			sceneGroup.POST("/:id/override", h.SceneOverride)
			sceneGroup.GET("/:id/composed", h.SceneComposed)
			sceneGroup.GET("/:id/layers", h.SceneLayers)
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
