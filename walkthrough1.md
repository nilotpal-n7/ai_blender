# Walkthrough — Pipeline Wiring (Orchestrator → Redis → Worker)

## Summary

Implemented the full prompt-to-worker round-trip pipeline. The frontend now submits prompts to the Go orchestrator, which enqueues jobs in Redis. The Python worker picks them up, processes them, and reports status back. The frontend polls for status updates.

---

## Data Flow (now working)

```
Frontend                    Orchestrator                  Redis                     Worker
   │                            │                           │                         │
   ├─POST /scene/create────────►│──HSET scene:{id}─────────►│                         │
   │◄──── { scene_id }─────────┤                           │                         │
   │                            │                           │                         │
   ├─POST /scene/:id/prompt───►│──HSET job:{id} (queued)──►│                         │
   │                            │──LPUSH blender:jobs──────►│                         │
   │◄──── { job_id }───────────┤                           │◄──BLPOP────────────────┤
   │                            │                           │                         │
   │  ┌─poll loop──────────────┐│                           │  HSET (processing)      │
   │  │ GET /job/:id/status    ││──HGETALL job:{id}────────►│◄────────────────────────┤
   │  │ every 2s               ││                           │                         │
   │  │                        ││                           │  HSET (completed)       │
   │  │ until terminal state   ││                           │◄────────────────────────┤
   │  └────────────────────────┘│                           │                         │
```

---

## Files Changed

### Go Orchestrator — 5 files

| File | Change | Description |
|---|---|---|
| [job.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/internal/queue/job.go) | **NEW** | `Job` and `Scene` structs, status constants (`queued`/`processing`/`completed`/`failed`), constructors |
| [queue.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/internal/queue/queue.go) | **REWRITE** | Redis `Client` with `EnqueueJob` (LPUSH), `GetJobStatus` (HGETALL), `CreateScene`, `GetScene`, `UpdateSceneLatestJob`, connection pooling, TTLs |
| [handlers.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/internal/api/handlers.go) | **REWRITE** | `Handler` struct with injected `*queue.Client`. Live implementations: `SceneCreate`, `SceneGet`, `ScenePrompt` (enqueue), `JobStatus` (poll). `SceneOverride` kept as stub. |
| [router.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/internal/api/router.go) | **MODIFIED** | `NewRouter` now accepts `*queue.Client`, creates `Handler`, adds `GET /job/:id/status` route |
| [main.go](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/orchestrator/cmd/server/main.go) | **MODIFIED** | Initializes `queue.NewClient()`, passes to router, deferred `Close()` |

### Python Worker — 1 file

| File | Change | Description |
|---|---|---|
| [worker.py](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/blender-worker/src/worker.py) | **MODIFIED** | Added `report_status()` — writes `processing`/`completed`/`failed` + result/error back to `job:{id}` Redis hash. `process_job()` now reports at each transition with error traceback capture. |

### Frontend — 2 files

| File | Change | Description |
|---|---|---|
| [api.ts](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/web/app/lib/api.ts) | **NEW** | Typed API client: `createScene()`, `submitPrompt()`, `getJobStatus()`, `pollJobUntilDone()` with configurable interval/timeout |
| [PromptPanel.tsx](file:///c:/Users/nilot/Documents/VSCode/ai_blender/apps/web/app/components/PromptPanel.tsx) | **REWRITE** | Connected to live API: auto-creates scene on first submit, enqueues jobs, polls status with visual transitions (color-coded indicator), error display, and job history panel |

---

## API Endpoints (now live)

| Method | Path | Status | Description |
|---|---|---|---|
| `GET` | `/api/v1/health` | ✅ Live | Health check + Redis connectivity |
| `POST` | `/api/v1/scene/create` | ✅ Live | Create scene session |
| `GET` | `/api/v1/scene/:id` | ✅ Live | Get scene metadata |
| `POST` | `/api/v1/scene/:id/prompt` | ✅ Live | Submit prompt → enqueue job |
| `POST` | `/api/v1/scene/:id/override` | 🔲 Stub | Needs USD pipeline (step #2) |
| `GET` | `/api/v1/job/:id/status` | ✅ Live | Poll job status |

---

## Verification Results

| Check | Result |
|---|---|
| `go build ./...` | ✅ Compiled — zero errors |
| `npm run build` | ✅ Next.js 16.2.12 — compiled in 5.5s, TypeScript passed |

## Manual E2E Test Instructions

```bash
# 1. Start Redis
docker run -d -p 6379:6379 --name redis-test redis:7-alpine

# 2. Start orchestrator
cd apps/orchestrator
go run ./cmd/server

# 3. Start worker (in another terminal)
cd apps/blender-worker
python src/worker.py

# 4. Test via curl (in another terminal)
# Create scene
curl -s -X POST http://localhost:8080/api/v1/scene/create \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Scene"}' | jq .

# Submit prompt (replace SCENE_ID)
curl -s -X POST http://localhost:8080/api/v1/scene/SCENE_ID/prompt \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A red cube on a wooden table"}' | jq .

# Poll status (replace JOB_ID)
curl -s http://localhost:8080/api/v1/job/JOB_ID/status | jq .

# 5. Start frontend
cd apps/web
npm run dev
# Open http://localhost:3000 and submit a prompt
```
