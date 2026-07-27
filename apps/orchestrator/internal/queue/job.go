package queue

import (
	"time"
)

// ─── Job Status Constants ───────────────────────────────────────────

const (
	StatusQueued     = "queued"
	StatusProcessing = "processing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
)

// ─── Job Types ──────────────────────────────────────────────────────

const (
	JobTypeAssemble = "assemble"
	JobTypeRender   = "render"
)

// ─── Job ────────────────────────────────────────────────────────────

// Job represents a unit of work dispatched to a Blender cloud worker.
type Job struct {
	ID        string `json:"job_id"`
	Type      string `json:"job_type"`
	SceneID   string `json:"scene_id"`
	Prompt    string `json:"prompt,omitempty"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
	Result    string `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
}

// NewJob creates a new Job with the given parameters and sets initial state.
func NewJob(id, jobType, sceneID, prompt string) *Job {
	now := time.Now().UTC().Format(time.RFC3339)
	return &Job{
		ID:        id,
		Type:      jobType,
		SceneID:   sceneID,
		Prompt:    prompt,
		Status:    StatusQueued,
		CreatedAt: now,
		UpdatedAt: now,
	}
}

// ─── Scene ──────────────────────────────────────────────────────────

// Scene represents a scene session with lightweight metadata.
// Full USD layer management is handled separately (step #2).
type Scene struct {
	ID        string `json:"scene_id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	LatestJob string `json:"latest_job,omitempty"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// NewScene creates a new Scene with the given ID and name.
func NewScene(id, name string) *Scene {
	now := time.Now().UTC().Format(time.RFC3339)
	return &Scene{
		ID:        id,
		Name:      name,
		Status:    "idle",
		CreatedAt: now,
		UpdatedAt: now,
	}
}
