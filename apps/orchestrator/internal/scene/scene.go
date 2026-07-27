// Package scene manages the OpenUSD scene-state stack for each active session.
//
// This is the core of the "contextual memory" architecture. Each scene maintains:
//   - A Base Layer (.usda) authored by the AI via the Python worker
//   - Zero or more Override Layers (USDA text diffs) from user edits
//   - A composed/flattened view used for LLM context injection
//
// All layer data is stored in Redis as text strings (USDA is lightweight).
//
// Redis key patterns:
//   scene:{id}:base_layer  — string: AI-generated base USDA
//   scene:{id}:overrides   — list: ordered override USDA strings (newest first)
//   scene:{id}:composed    — string: cached flattened USDA
package scene

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	baseLayerSuffix = ":base_layer"
	overridesSuffix = ":overrides"
	composedSuffix  = ":composed"
	scenePrefix     = "scene:"
	layerTTL        = 7 * 24 * time.Hour // 7 days
)

// ─── Manager ────────────────────────────────────────────────────────

// Manager provides USD layer stack operations backed by Redis.
type Manager struct {
	rdb *redis.Client
}

// NewManager creates a new scene Manager using the given Redis client.
func NewManager(rdb *redis.Client) *Manager {
	return &Manager{rdb: rdb}
}

// NewManagerFromAddr creates a new scene Manager by connecting to Redis.
func NewManagerFromAddr(addr, password string) (*Manager, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       0,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("scene manager redis connection failed: %w", err)
	}

	return &Manager{rdb: rdb}, nil
}

// ─── Base Layer ─────────────────────────────────────────────────────

// StoreBaseLayer stores the AI-generated base USDA for a scene.
func (m *Manager) StoreBaseLayer(ctx context.Context, sceneID, usda string) error {
	key := scenePrefix + sceneID + baseLayerSuffix
	pipe := m.rdb.Pipeline()
	pipe.Set(ctx, key, usda, layerTTL)
	// Invalidate cached composed state
	pipe.Del(ctx, scenePrefix+sceneID+composedSuffix)
	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("failed to store base layer: %w", err)
	}
	log.Printf("💾 Stored base layer for scene %s (%d chars)", sceneID, len(usda))
	return nil
}

// GetBaseLayer retrieves the base layer USDA for a scene.
func (m *Manager) GetBaseLayer(ctx context.Context, sceneID string) (string, error) {
	key := scenePrefix + sceneID + baseLayerSuffix
	result, err := m.rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		return "", fmt.Errorf("no base layer for scene: %s", sceneID)
	}
	if err != nil {
		return "", fmt.Errorf("failed to get base layer: %w", err)
	}
	return result, nil
}

// ─── Override Layers ────────────────────────────────────────────────

// PushOverride adds a new override layer to the front of the list (strongest).
// Also invalidates the cached composed state.
func (m *Manager) PushOverride(ctx context.Context, sceneID, usda string) error {
	key := scenePrefix + sceneID + overridesSuffix
	pipe := m.rdb.Pipeline()
	pipe.LPush(ctx, key, usda)
	pipe.Expire(ctx, key, layerTTL)
	// Invalidate composed cache
	pipe.Del(ctx, scenePrefix+sceneID+composedSuffix)
	_, err := pipe.Exec(ctx)
	if err != nil {
		return fmt.Errorf("failed to push override: %w", err)
	}
	log.Printf("📝 Pushed override for scene %s (%d chars)", sceneID, len(usda))
	return nil
}

// GetOverrides retrieves all override layers ordered strongest-first.
func (m *Manager) GetOverrides(ctx context.Context, sceneID string) ([]string, error) {
	key := scenePrefix + sceneID + overridesSuffix
	result, err := m.rdb.LRange(ctx, key, 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get overrides: %w", err)
	}
	return result, nil
}

// ─── Composed State ─────────────────────────────────────────────────

// StoreComposed caches the flattened composed USDA.
func (m *Manager) StoreComposed(ctx context.Context, sceneID, usda string) error {
	key := scenePrefix + sceneID + composedSuffix
	return m.rdb.Set(ctx, key, usda, layerTTL).Err()
}

// GetComposed retrieves the cached composed USDA.
// Returns empty string (not error) if no composed state exists yet.
func (m *Manager) GetComposed(ctx context.Context, sceneID string) (string, error) {
	key := scenePrefix + sceneID + composedSuffix
	result, err := m.rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to get composed state: %w", err)
	}
	return result, nil
}

// ─── Layer Info ─────────────────────────────────────────────────────

// LayerInfo represents the full layer stack state for a scene.
type LayerInfo struct {
	SceneID       string   `json:"scene_id"`
	HasBaseLayer  bool     `json:"has_base_layer"`
	BaseLayerSize int      `json:"base_layer_size"`
	OverrideCount int      `json:"override_count"`
	ComposedSize  int      `json:"composed_size"`
	Overrides     []string `json:"overrides,omitempty"`
}

// GetLayerInfo returns a summary of the layer stack for a scene.
func (m *Manager) GetLayerInfo(ctx context.Context, sceneID string, includeContent bool) (*LayerInfo, error) {
	info := &LayerInfo{SceneID: sceneID}

	// Check base layer
	base, err := m.GetBaseLayer(ctx, sceneID)
	if err == nil {
		info.HasBaseLayer = true
		info.BaseLayerSize = len(base)
	}

	// Count overrides
	overrides, err := m.GetOverrides(ctx, sceneID)
	if err == nil {
		info.OverrideCount = len(overrides)
		if includeContent {
			info.Overrides = overrides
		}
	}

	// Check composed
	composed, err := m.GetComposed(ctx, sceneID)
	if err == nil {
		info.ComposedSize = len(composed)
	}

	return info, nil
}
