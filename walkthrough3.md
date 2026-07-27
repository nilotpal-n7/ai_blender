# Walkthrough — AI Model Integration (Hunyuan3D-2.1)

## Summary

Integrated the first AI model (Hunyuan3D-2.1) via a provider-agnostic abstraction layer. The system now generates 3D meshes from AI when available, converts them from GLB to USD, and merges them into the scene layer stack. Falls back gracefully to procedural generation when no GPU is available.

---

## Architecture

```
  Prompt ("A red sports car")
       │
       ▼
  ┌──────────────────┐
  │   Model Client   │ ← Factory: picks backend from env
  │   (Protocol)     │
  └──────┬───────────┘
         │
    ┌────┴────────────────────────────┐
    │            │                    │
    ▼            ▼                    ▼
  self_hosted  replicate            mock
  (api_server)  (cloud API)     (placeholder GLB)
    │            │                    │
    └────────────┴────────────────────┘
         │
         ▼ GLB bytes
  ┌──────────────────┐
  │  Mesh Converter  │ GLB → USDA
  └──────┬───────────┘
         │ USDA text
         ▼
  ┌──────────────────┐
  │   Assembler      │ merge AI mesh + procedural scene
  └──────┬───────────┘
         │ composed USDA
         ▼
  ┌──────────────────┐
  │   Redis Store    │ → Orchestrator API → Frontend
  └──────────────────┘
```

---

## Files Changed

### New Files — 2

| File | Description |
|---|---|
| [model_client.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/model_client.py) | Provider-agnostic model client. `HunyuanSelfHostedClient` (calls `POST /generate` on api_server.py), `HunyuanReplicateClient` (Replicate cloud API with prediction polling), `MockModelClient` (generates minimal valid GLB with proper binary structure). Factory `create_client()` selects based on `MODEL_PROVIDER` env. |
| [mesh_converter.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/mesh_converter.py) | GLB-to-USD converter. Parses GLB binary format (header, JSON/BIN chunks, accessors, buffer views), extracts vertex positions, normals, face indices. Builds USDA `Mesh` prim with transforms and default PBR material. Falls back to cube on parse failure. |

### Modified Files — 5

| File | Change | Description |
|---|---|---|
| [usd_utils.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/usd_utils.py) | **+35 lines** | Added `insert_mesh_into_stage()` — merges AI mesh USDA into existing scene via sublayer composition |
| [assembler.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/assembler.py) | **REWRITE** | Tries AI model → GLB → USDA → merge into scene. Falls back to procedural. Returns `ai_model_used` flag + `model_info` dict. Includes `_prompt_to_prim_name()` for smart naming. |
| [worker.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/worker.py) | **MODIFIED** | `main()` initializes model client on startup. `process_job()` passes client to assembler. Job result includes `ai_model_used` and `model_info`. |
| [.env.example](file:///c:/Users/nilot/Documents/VSCode/ai_blender/.env.example) | **MODIFIED** | Added `MODEL_PROVIDER`, `HUNYUAN3D_ENDPOINT`, `HUNYUAN3D_TEXTURE`, `REPLICATE_API_TOKEN`, `REPLICATE_MODEL_VERSION` |
| [PromptPanel.tsx](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/web/app/components/PromptPanel.tsx) | **MODIFIED** | Parses model info from job result JSON. Shows provider badge (AI/Procedural) with generation time in USD Layers panel. |

---

## Model Provider Configuration

| Provider | `MODEL_PROVIDER` | Requirements | Use Case |
|---|---|---|---|
| **Mock** | `mock` | None | Development, testing |
| **Self-hosted** | `self_hosted` | GPU with 24GB+ VRAM, Hunyuan3D api_server running | Production, low latency |
| **Replicate** | `replicate` | `REPLICATE_API_TOKEN` set | No local GPU, ~$0.18/run |

---

## Data Flow: AI Model Path

```
1. Worker receives job from Redis queue
2. model_client.generate_mesh(prompt) → MeshResult (GLB bytes)
3. mesh_converter.glb_to_usda(glb_bytes) → mesh USDA text
4. usd_utils.create_scene_from_prompt(prompt) → scene USDA (lighting/camera/ground)
5. usd_utils.insert_mesh_into_stage(scene, mesh) → merged USDA
6. Worker stores merged USDA in Redis as base layer
7. Orchestrator serves via GET /scene/:id/composed
8. Frontend parses job result → shows "AI (mock) 0.5s" badge
```

---

## Verification Results

| Check | Result |
|---|---|
| `go build ./...` | ✅ Compiled — zero errors |
| `npm run build` | ✅ Next.js 16.2.12 — compiled in 4.3s, TypeScript passed |
