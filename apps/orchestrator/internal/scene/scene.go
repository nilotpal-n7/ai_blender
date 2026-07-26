// Package scene manages the OpenUSD scene-state stack for each active session.
//
// This is the core of the "contextual memory" architecture. Each scene maintains:
//   - A Base Layer (.usdz) authored by the AI via headless Blender
//   - Zero or more Override Layers (text-based USD diffs) from user edits
//   - A composed/flattened view used for LLM context injection
//
// TODO: Implement the following:
//   - CreateScene(ctx, sceneID) — initialize a new USD stage in storage
//   - ApplyOverride(ctx, sceneID, overrideUSDA) — stack a user override layer
//   - GetComposedState(ctx, sceneID) — return the flattened scene for LLM context
//   - SetBaseLayer(ctx, sceneID, usdzPath) — update the AI-generated base layer
//   - ListLayers(ctx, sceneID) — return the full layer stack for debugging
//
// Storage: Scene layers will be stored in cloud object storage (GCS/S3) with
// metadata tracked in Redis or a lightweight DB.
package scene
