package api

import (
	"net/http"
	"time"

	"github.com/ai-blender/orchestrator/internal/queue"
	"github.com/ai-blender/orchestrator/internal/scene"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// ─── Handler ────────────────────────────────────────────────────────

// Handler holds dependencies for all API handlers.
type Handler struct {
	Queue  *queue.Client
	Scenes *scene.Manager
	Hub    *Hub
}

// NewHandler creates a new Handler with the given dependencies.
func NewHandler(q *queue.Client, s *scene.Manager, hub *Hub) *Handler {
	return &Handler{Queue: q, Scenes: s, Hub: hub}
}

// ─── Health ─────────────────────────────────────────────────────────

// HealthCheck returns the service status, Redis connectivity, and timestamp.
func (h *Handler) HealthCheck(c *gin.Context) {
	redisStatus := "connected"
	if err := h.Queue.Ping(c.Request.Context()); err != nil {
		redisStatus = "disconnected"
	}

	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"service": "orchestrator",
		"redis":   redisStatus,
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
}

// ─── Scene Management ───────────────────────────────────────────────

// SceneCreateRequest is the JSON body for POST /scene/create.
type SceneCreateRequest struct {
	Name string `json:"name" binding:"required"`
}

// SceneCreate handles POST /api/v1/scene/create
// Creates a new scene session and stores metadata in Redis.
func (h *Handler) SceneCreate(c *gin.Context) {
	var req SceneCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "invalid_request",
			"message": "Request body must include a 'name' field.",
		})
		return
	}

	sceneID := uuid.New().String()
	sc := queue.NewScene(sceneID, req.Name)

	if err := h.Queue.CreateScene(c.Request.Context(), sc); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "scene_creation_failed",
			"message": err.Error(),
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"scene_id":   sc.ID,
		"name":       sc.Name,
		"status":     sc.Status,
		"created_at": sc.CreatedAt,
	})
}

// SceneGet handles GET /api/v1/scene/:id
// Retrieves scene metadata from Redis.
func (h *Handler) SceneGet(c *gin.Context) {
	sceneID := c.Param("id")

	sc, err := h.Queue.GetScene(c.Request.Context(), sceneID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error":    "scene_not_found",
			"message":  err.Error(),
			"scene_id": sceneID,
		})
		return
	}

	c.JSON(http.StatusOK, sc)
}

// ─── Prompt Submission ──────────────────────────────────────────────

// ScenePromptRequest is the JSON body for POST /scene/:id/prompt.
type ScenePromptRequest struct {
	Prompt string `json:"prompt" binding:"required"`
}

// ScenePrompt handles POST /api/v1/scene/:id/prompt
// Accepts a text prompt, creates an assembly job, and enqueues it
// for the Blender worker to process.
func (h *Handler) ScenePrompt(c *gin.Context) {
	sceneID := c.Param("id")

	// Verify scene exists
	_, err := h.Queue.GetScene(c.Request.Context(), sceneID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error":    "scene_not_found",
			"message":  err.Error(),
			"scene_id": sceneID,
		})
		return
	}

	// Parse request
	var req ScenePromptRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "invalid_request",
			"message": "Request body must include a 'prompt' field.",
		})
		return
	}

	// Create and enqueue the job
	jobID := uuid.New().String()
	job := queue.NewJob(jobID, queue.JobTypeAssemble, sceneID, req.Prompt)

	if err := h.Queue.EnqueueJob(c.Request.Context(), job); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "enqueue_failed",
			"message": err.Error(),
		})
		return
	}

	// Update scene with latest job reference
	_ = h.Queue.UpdateSceneLatestJob(c.Request.Context(), sceneID, jobID, "processing")

	// Broadcast job status via WebSocket
	if h.Hub != nil {
		h.Hub.BroadcastToScene(sceneID, WSMessage{
			Type: MsgJobStatus,
			Payload: map[string]interface{}{
				"job_id":   jobID,
				"scene_id": sceneID,
				"status":   "queued",
			},
		})
	}

	c.JSON(http.StatusAccepted, gin.H{
		"job_id":   job.ID,
		"scene_id": sceneID,
		"status":   job.Status,
		"message":  "Job enqueued for processing.",
	})
}

// ─── Override Layer ─────────────────────────────────────────────────

// SceneOverrideRequest is the JSON body for POST /scene/:id/override.
type SceneOverrideRequest struct {
	OverrideUSDA string `json:"override_usda" binding:"required"`
}

// SceneOverride handles POST /api/v1/scene/:id/override
// Accepts a USD Override Layer (USDA text) from the frontend and
// pushes it onto the scene's override stack.
func (h *Handler) SceneOverride(c *gin.Context) {
	sceneID := c.Param("id")

	// Verify scene exists
	_, err := h.Queue.GetScene(c.Request.Context(), sceneID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error":    "scene_not_found",
			"message":  err.Error(),
			"scene_id": sceneID,
		})
		return
	}

	// Parse request
	var req SceneOverrideRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "invalid_request",
			"message": "Request body must include an 'override_usda' field.",
		})
		return
	}

	// Push override to scene layer stack
	if err := h.Scenes.PushOverride(c.Request.Context(), sceneID, req.OverrideUSDA); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "override_failed",
			"message": err.Error(),
		})
		return
	}

	// Get updated layer count
	info, _ := h.Scenes.GetLayerInfo(c.Request.Context(), sceneID, false)
	overrideCount := 0
	if info != nil {
		overrideCount = info.OverrideCount
	}

	// Broadcast layer change via WebSocket
	if h.Hub != nil && info != nil {
		h.Hub.BroadcastToScene(sceneID, WSMessage{
			Type:    MsgLayersChanged,
			Payload: info,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"status":         "override_applied",
		"scene_id":       sceneID,
		"override_count": overrideCount,
		"message":        "Override layer pushed to scene stack.",
	})
}

// ─── Composed State ─────────────────────────────────────────────────

// SceneComposed handles GET /api/v1/scene/:id/composed
// Returns the flattened USDA of the composed scene state.
func (h *Handler) SceneComposed(c *gin.Context) {
	sceneID := c.Param("id")

	// Try cached composed first
	composed, err := h.Scenes.GetComposed(c.Request.Context(), sceneID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "retrieval_failed",
			"message": err.Error(),
		})
		return
	}

	// If no composed state, fall back to base layer
	if composed == "" {
		composed, err = h.Scenes.GetBaseLayer(c.Request.Context(), sceneID)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{
				"error":    "no_scene_data",
				"message":  "No base layer or composed state found. Submit a prompt first.",
				"scene_id": sceneID,
			})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"scene_id": sceneID,
		"usda":     composed,
		"size":     len(composed),
	})
}

// ─── Layer Stack Info ───────────────────────────────────────────────

// SceneLayers handles GET /api/v1/scene/:id/layers
// Returns the full layer stack info for debugging.
func (h *Handler) SceneLayers(c *gin.Context) {
	sceneID := c.Param("id")

	// Check if content should be included
	includeContent := c.Query("content") == "true"

	info, err := h.Scenes.GetLayerInfo(c.Request.Context(), sceneID, includeContent)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "layer_info_failed",
			"message": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, info)
}

// ─── Job Status ─────────────────────────────────────────────────────

// JobStatus handles GET /api/v1/job/:id/status
// Returns the current state of a job from Redis.
func (h *Handler) JobStatus(c *gin.Context) {
	jobID := c.Param("id")

	job, err := h.Queue.GetJobStatus(c.Request.Context(), jobID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "job_not_found",
			"message": err.Error(),
			"job_id":  jobID,
		})
		return
	}

	c.JSON(http.StatusOK, job)
}
