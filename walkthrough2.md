# Walkthrough — USD Scene-State Pipeline (Contextual Memory)

## Summary

Implemented the OpenUSD layer composition system — the "contextual memory" that gives the AI spatial awareness of user edits. The worker now generates real USDA scenes from prompts, stores them in Redis, and the orchestrator serves composed state + layer info through new API endpoints.

---

## Architecture

```
                    ┌──────────────────────────────────────────────────┐
                    │              Redis (Layer Store)                 │
                    │                                                  │
                    │  scene:{id}:base_layer  ← USDA text (worker)    │
                    │  scene:{id}:overrides   ← list of USDA diffs    │
                    │  scene:{id}:composed    ← cached flattened USDA │
                    └─────────┬───────────────┬───────────────────────┘
                              │               │
                    ┌─────────▼─────┐  ┌──────▼──────────┐
                    │  Worker (pxr) │  │  Orchestrator    │
                    │               │  │  (scene.Manager) │
                    │ • Generates   │  │                  │
                    │   base USDA   │  │ • Stores/serves  │
                    │   from prompt │  │   layers via API │
                    │ • Composes    │  │ • Override push  │
                    │   overrides   │  │ • Composed get   │
                    │ • Stores in   │  │ • Layer listing  │
                    │   Redis       │  │                  │
                    └───────────────┘  └──────────────────┘
```

---

## Files Changed

### Python Worker — 3 files

| File | Change | Description |
|---|---|---|
| [usd_utils.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/usd_utils.py) | **REWRITE** | Full `pxr` implementations: `apply_override_layer()` via `Sdf.Layer.CreateAnonymous` + `ImportFromString`, `get_composed_state_as_text()` for multi-layer flattening, `create_scene_from_prompt()` for procedural geometry/materials/lighting from keywords |
| [assembler.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/assembler.py) | **REWRITE** | Working assembler: generates base USDA from prompt, composes existing overrides, returns `{base_layer_usda, composed_usda, objects_count}` |
| [worker.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/worker.py) | **MODIFIED** | Assembly jobs now call real assembler, store base layer + composed USDA in Redis via pipeline, fetch existing overrides before assembly |

### Go Orchestrator — 4 files

| File | Change | Description |
|---|---|---|
| [scene.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/internal/scene/scene.go) | **REWRITE** | `Manager` struct: `StoreBaseLayer`, `GetBaseLayer`, `PushOverride` (LPUSH), `GetOverrides` (LRANGE), `StoreComposed`, `GetComposed`, `GetLayerInfo`. Auto-invalidates composed cache on new base/override |
| [handlers.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/internal/api/handlers.go) | **MODIFIED** | `Handler` now holds `*scene.Manager`. Live `SceneOverride` (push USDA diff), new `SceneComposed` (return flattened USDA), new `SceneLayers` (layer stack info with optional content) |
| [router.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/internal/api/router.go) | **MODIFIED** | Accepts `*scene.Manager`, adds `GET /scene/:id/composed` and `GET /scene/:id/layers` |
| [main.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/cmd/server/main.go) | **MODIFIED** | Initializes `scene.NewManagerFromAddr()`, passes to router |

### Frontend — 2 files

| File | Change | Description |
|---|---|---|
| [api.ts](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/web/app/lib/api.ts) | **MODIFIED** | Added types (`ComposedResponse`, `LayerInfo`, `OverrideResponse`) and functions (`getComposedState`, `getSceneLayers`, `submitOverride`) |
| [PromptPanel.tsx](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/web/app/components/PromptPanel.tsx) | **MODIFIED** | Fetches layer data after job completion. USD Layers panel shows base + override count with sizes. Collapsible USDA preview button |

---

## API Endpoints (updated)

| Method | Path | Status | Description |
|---|---|---|---|
| `GET` | `/api/v1/health` | ✅ Live | Health check + Redis status |
| `POST` | `/api/v1/scene/create` | ✅ Live | Create scene session |
| `GET` | `/api/v1/scene/:id` | ✅ Live | Get scene metadata |
| `POST` | `/api/v1/scene/:id/prompt` | ✅ Live | Submit prompt → enqueue job |
| `POST` | `/api/v1/scene/:id/override` | ✅ **NEW** | Push USDA override to layer stack |
| `GET` | `/api/v1/scene/:id/composed` | ✅ **NEW** | Get flattened composed USDA |
| `GET` | `/api/v1/scene/:id/layers` | ✅ **NEW** | Get layer stack info (`?content=true` for USDA) |
| `GET` | `/api/v1/job/:id/status` | ✅ Live | Poll job status |

---

## USD Scene Generation

The `create_scene_from_prompt()` function parses prompts for:
- **Geometry**: cube, sphere, cylinder, cone, table, floor, wall, tree, building, etc.
- **Colors**: red, blue, green, wooden, metal, glass, neon, cyberpunk, etc.
- **Color-object pairs**: "red cube", "wooden table" detected via regex
- **Lighting**: key + fill lights default, spotlight/neon/night keywords modify
- **Camera**: auto-positioned based on object count

Example: `"A red cube on a wooden table with a spotlight"` generates:
- `/World/Cube` (red UsdPreviewSurface, positioned at Z=0.5)
- `/World/Table` (brown, flat-scaled, positioned at Z=0)
- `/World/GroundPlane` (gray, 20x20)
- `/World/Lights/KeyLight`, `/World/Lights/FillLight`, `/World/Lights/Spotlight`
- `/World/MainCamera` (auto-framed)
- All with proper PBR materials via UsdShade

---

## Verification Results

| Check | Result |
|---|---|
| `go build ./...` | ✅ Compiled — zero errors |
| `npm run build` | ✅ Next.js 16.2.12 — compiled in 3.9s, TypeScript passed |
