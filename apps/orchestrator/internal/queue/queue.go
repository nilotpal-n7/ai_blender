// Package queue provides the Redis-backed job queue used to dispatch
// work to Blender cloud workers and track job/scene state.
//
// Pattern: LPUSH/BLPOP for job dispatch, Redis hashes for state tracking.
// The Python worker uses BLPOP to pop jobs, and writes status updates
// back to the same job hash keys.
package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis key patterns
const (
	jobKeyPrefix   = "job:"
	sceneKeyPrefix = "scene:"
	jobQueue       = "blender:jobs"
)

// ─── Client ─────────────────────────────────────────────────────────

// Client wraps a Redis connection and provides job queue operations.
type Client struct {
	rdb *redis.Client
}

// NewClient creates a new Redis queue client from config values.
func NewClient(addr, password string) (*Client, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           0,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     10,
	})

	// Verify connectivity
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis connection failed: %w", err)
	}

	log.Printf("✅ Connected to Redis at %s", addr)
	return &Client{rdb: rdb}, nil
}

// Ping checks Redis connectivity.
func (c *Client) Ping(ctx context.Context) error {
	return c.rdb.Ping(ctx).Err()
}

// Close gracefully shuts down the Redis connection.
func (c *Client) Close() error {
	return c.rdb.Close()
}

// ─── Job Operations ─────────────────────────────────────────────────

// EnqueueJob serializes the job, stores its metadata hash, and pushes
// it onto the blender:jobs list for worker pickup via BLPOP.
func (c *Client) EnqueueJob(ctx context.Context, job *Job) error {
	// Store job metadata hash
	jobKey := jobKeyPrefix + job.ID
	err := c.rdb.HSet(ctx, jobKey, map[string]interface{}{
		"job_id":     job.ID,
		"job_type":   job.Type,
		"scene_id":   job.SceneID,
		"prompt":     job.Prompt,
		"status":     job.Status,
		"created_at": job.CreatedAt,
		"updated_at": job.UpdatedAt,
	}).Err()
	if err != nil {
		return fmt.Errorf("failed to store job hash: %w", err)
	}

	// Set TTL on job hash (24 hours)
	c.rdb.Expire(ctx, jobKey, 24*time.Hour)

	// Serialize job payload for the queue
	payload, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal job: %w", err)
	}

	// Push to queue (LPUSH — worker uses BLPOP from the right)
	if err := c.rdb.LPush(ctx, jobQueue, payload).Err(); err != nil {
		return fmt.Errorf("failed to enqueue job: %w", err)
	}

	log.Printf("📤 Enqueued job %s (type=%s, scene=%s)", job.ID, job.Type, job.SceneID)
	return nil
}

// GetJobStatus reads the job metadata hash from Redis and returns the Job.
func (c *Client) GetJobStatus(ctx context.Context, jobID string) (*Job, error) {
	jobKey := jobKeyPrefix + jobID

	result, err := c.rdb.HGetAll(ctx, jobKey).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get job hash: %w", err)
	}

	if len(result) == 0 {
		return nil, fmt.Errorf("job not found: %s", jobID)
	}

	job := &Job{
		ID:        result["job_id"],
		Type:      result["job_type"],
		SceneID:   result["scene_id"],
		Prompt:    result["prompt"],
		Status:    result["status"],
		CreatedAt: result["created_at"],
		UpdatedAt: result["updated_at"],
		Result:    result["result"],
		Error:     result["error"],
	}

	return job, nil
}

// ─── Scene Operations ───────────────────────────────────────────────

// CreateScene stores a new scene metadata hash in Redis.
func (c *Client) CreateScene(ctx context.Context, scene *Scene) error {
	sceneKey := sceneKeyPrefix + scene.ID

	err := c.rdb.HSet(ctx, sceneKey, map[string]interface{}{
		"scene_id":   scene.ID,
		"name":       scene.Name,
		"status":     scene.Status,
		"latest_job": scene.LatestJob,
		"created_at": scene.CreatedAt,
		"updated_at": scene.UpdatedAt,
	}).Err()
	if err != nil {
		return fmt.Errorf("failed to store scene hash: %w", err)
	}

	// Set TTL (7 days)
	c.rdb.Expire(ctx, sceneKey, 7*24*time.Hour)

	log.Printf("🎬 Created scene %s (%s)", scene.ID, scene.Name)
	return nil
}

// GetScene reads the scene metadata hash from Redis.
func (c *Client) GetScene(ctx context.Context, sceneID string) (*Scene, error) {
	sceneKey := sceneKeyPrefix + sceneID

	result, err := c.rdb.HGetAll(ctx, sceneKey).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get scene hash: %w", err)
	}

	if len(result) == 0 {
		return nil, fmt.Errorf("scene not found: %s", sceneID)
	}

	scene := &Scene{
		ID:        result["scene_id"],
		Name:      result["name"],
		Status:    result["status"],
		LatestJob: result["latest_job"],
		CreatedAt: result["created_at"],
		UpdatedAt: result["updated_at"],
	}

	return scene, nil
}

// UpdateSceneLatestJob updates the scene's latest_job field and status.
func (c *Client) UpdateSceneLatestJob(ctx context.Context, sceneID, jobID, status string) error {
	sceneKey := sceneKeyPrefix + sceneID
	now := time.Now().UTC().Format(time.RFC3339)

	return c.rdb.HSet(ctx, sceneKey, map[string]interface{}{
		"latest_job": jobID,
		"status":     status,
		"updated_at": now,
	}).Err()
}
