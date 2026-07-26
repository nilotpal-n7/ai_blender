package api

import (
	"github.com/ai-blender/orchestrator/internal/config"
	"github.com/gin-gonic/gin"
)

// NewRouter creates and configures the Gin engine with all route groups.
func NewRouter(cfg *config.Config) *gin.Engine {
	router := gin.Default()

	// ─── Global Middleware ──────────────────────────────────────────
	router.Use(CORSMiddleware())

	// ─── API v1 ─────────────────────────────────────────────────────
	v1 := router.Group("/api/v1")
	{
		// Health check
		v1.GET("/health", HealthCheck)

		// Scene management (stubs for future implementation)
		scene := v1.Group("/scene")
		{
			scene.POST("/create", SceneCreateStub)
			scene.GET("/:id", SceneGetStub)
			scene.POST("/:id/prompt", ScenePromptStub)
			scene.POST("/:id/override", SceneOverrideStub)
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
