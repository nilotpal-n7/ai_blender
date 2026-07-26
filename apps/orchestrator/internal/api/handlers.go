package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// ─── Health ─────────────────────────────────────────────────────────

// HealthCheck returns the service status and uptime indicator.
func HealthCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"service": "orchestrator",
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
}

// ─── Scene Stubs ────────────────────────────────────────────────────
// These handlers are placeholders. They will be implemented when we
// build the USD scene-state pipeline and Redis job queue integration.

// SceneCreateStub handles POST /api/v1/scene/create
func SceneCreateStub(c *gin.Context) {
	c.JSON(http.StatusNotImplemented, gin.H{
		"error":   "not_implemented",
		"message": "Scene creation is not yet implemented.",
	})
}

// SceneGetStub handles GET /api/v1/scene/:id
func SceneGetStub(c *gin.Context) {
	id := c.Param("id")
	c.JSON(http.StatusNotImplemented, gin.H{
		"error":    "not_implemented",
		"message":  "Scene retrieval is not yet implemented.",
		"scene_id": id,
	})
}

// ScenePromptStub handles POST /api/v1/scene/:id/prompt
// This endpoint will accept a text prompt + the current USD override layer,
// dispatch it to the LLM, and enqueue a Blender assembly job.
func ScenePromptStub(c *gin.Context) {
	id := c.Param("id")
	c.JSON(http.StatusNotImplemented, gin.H{
		"error":    "not_implemented",
		"message":  "Prompt processing is not yet implemented.",
		"scene_id": id,
	})
}

// SceneOverrideStub handles POST /api/v1/scene/:id/override
// This endpoint will accept a USD Override Layer (text diff) from the frontend
// and merge it into the scene's state stack.
func SceneOverrideStub(c *gin.Context) {
	id := c.Param("id")
	c.JSON(http.StatusNotImplemented, gin.H{
		"error":    "not_implemented",
		"message":  "Override layer ingestion is not yet implemented.",
		"scene_id": id,
	})
}
