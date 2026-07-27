package api

import (
	"net/http"
	"time"

	"github.com/ai-blender/orchestrator/internal/queue"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// ─── Handler ────────────────────────────────────────────────────────

// Handler holds dependencies for all API handlers.
type Handler struct {
	Queue *queue.Client
}

// NewHandler creates a new Handler with the given queue client.
func NewHandler(q *queue.Client) *Handler {
	return &Handler{Queue: q}
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
	scene := queue.NewScene(sceneID, req.Name)

	if err := h.Queue.CreateScene(c.Request.Context(), scene); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "scene_creation_failed",
			"message": err.Error(),
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"scene_id":   scene.ID,
		"name":       scene.Name,
		"status":     scene.Status,
		"created_at": scene.CreatedAt,
	})
}

// SceneGet handles GET /api/v1/scene/:id
// Retrieves scene metadata from Redis.
func (h *Handler) SceneGet(c *gin.Context) {
	sceneID := c.Param("id")

	scene, err := h.Queue.GetScene(c.Request.Context(), sceneID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error":    "scene_not_found",
			"message":  err.Error(),
			"scene_id": sceneID,
		})
		return
	}

	c.JSON(http.StatusOK, scene)
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

	c.JSON(http.StatusAccepted, gin.H{
		"job_id":   job.ID,
		"scene_id": sceneID,
		"status":   job.Status,
		"message":  "Job enqueued for processing.",
	})
}

// ─── Override Layer (stub — needs USD pipeline from step #2) ────────

// SceneOverride handles POST /api/v1/scene/:id/override
// This endpoint will accept a USD Override Layer (text diff) from the frontend
// and merge it into the scene's state stack.
func (h *Handler) SceneOverride(c *gin.Context) {
	id := c.Param("id")
	c.JSON(http.StatusNotImplemented, gin.H{
		"error":    "not_implemented",
		"message":  "Override layer ingestion requires the USD pipeline (step #2).",
		"scene_id": id,
	})
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
