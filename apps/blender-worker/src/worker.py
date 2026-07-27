"""Worker — Main job loop for the Blender assembly engine.

This module connects to the Redis job queue and processes incoming
assembly/render jobs dispatched by the Go orchestrator.

Each job contains:
    - job_id: Unique identifier
    - job_type: "assemble" | "render"
    - scene_id: Associated scene
    - prompt: Text prompt for generation
    - status: Current job status

The worker produces real USD output and stores base layers + composed
state in Redis for the orchestrator to serve.

The worker runs inside a headless Blender process via:
    blender --background --python src/worker.py
"""

import json
import logging
import os
import signal
import sys
import time
import traceback
from datetime import datetime, timezone

import redis

# ─── Configuration ───────────────────────────────────────────────────

REDIS_ADDR = os.getenv("WORKER_REDIS_ADDR", "localhost:6379")
REDIS_PASSWORD = os.getenv("WORKER_REDIS_PASSWORD", "")
JOB_QUEUE = os.getenv("WORKER_JOB_QUEUE", "blender:jobs")
POLL_INTERVAL = float(os.getenv("WORKER_POLL_INTERVAL", "1.0"))

# ─── Logging ─────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("blender-worker")

# ─── Graceful Shutdown ──────────────────────────────────────────────

_running = True


def _shutdown_handler(signum, frame):
    global _running
    logger.info("Received shutdown signal (sig=%d). Finishing current job...", signum)
    _running = False


signal.signal(signal.SIGINT, _shutdown_handler)
signal.signal(signal.SIGTERM, _shutdown_handler)

# ─── Redis Connection ───────────────────────────────────────────────


def connect_redis() -> redis.Redis:
    """Create a Redis connection from environment config."""
    host, port = REDIS_ADDR.split(":")
    return redis.Redis(
        host=host,
        port=int(port),
        password=REDIS_PASSWORD or None,
        decode_responses=True,
    )


# ─── Job Status Reporting ───────────────────────────────────────────


def report_status(
    client: redis.Redis,
    job_id: str,
    status: str,
    result: dict | None = None,
    error: str | None = None,
) -> None:
    """Update the job's status hash in Redis.

    This writes back to the same `job:{job_id}` hash that the Go
    orchestrator reads via the GET /job/:id/status endpoint.

    Args:
        client: Redis connection.
        job_id: The job identifier.
        status: New status ("processing", "completed", "failed").
        result: Optional result payload (on completion).
        error: Optional error message (on failure).
    """
    job_key = f"job:{job_id}"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    updates: dict[str, str] = {
        "status": status,
        "updated_at": now,
    }

    if result is not None:
        updates["result"] = json.dumps(result)

    if error is not None:
        updates["error"] = error

    try:
        client.hset(job_key, mapping=updates)
        logger.info("📝 Job %s → status=%s", job_id, status)
    except redis.RedisError as e:
        logger.error("Failed to update job status for %s: %s", job_id, e)


# ─── USD Layer Storage ──────────────────────────────────────────────


def store_scene_layers(
    client: redis.Redis,
    scene_id: str,
    base_layer_usda: str,
    composed_usda: str,
) -> None:
    """Store USD scene layers in Redis for orchestrator access.

    Keys:
        scene:{id}:base_layer  — the AI-generated base USDA
        scene:{id}:composed    — the flattened composed state

    Args:
        client: Redis connection.
        scene_id: The scene identifier.
        base_layer_usda: Base layer USDA text.
        composed_usda: Composed/flattened USDA text.
    """
    try:
        pipe = client.pipeline()
        pipe.set(f"scene:{scene_id}:base_layer", base_layer_usda)
        pipe.expire(f"scene:{scene_id}:base_layer", 7 * 24 * 3600)  # 7 days
        pipe.set(f"scene:{scene_id}:composed", composed_usda)
        pipe.expire(f"scene:{scene_id}:composed", 7 * 24 * 3600)
        pipe.execute()
        logger.info("💾 Stored USD layers for scene %s (base=%d, composed=%d chars)",
                     scene_id, len(base_layer_usda), len(composed_usda))
    except redis.RedisError as e:
        logger.error("Failed to store scene layers for %s: %s", scene_id, e)


# ─── Job Processing ─────────────────────────────────────────────────


def process_job(client: redis.Redis, job_data: dict, model_client=None) -> None:
    """Process a single job from the queue.

    This is the main dispatch point. Based on job_type, it delegates to
    the assembler (scene composition) or renderer (final output).
    Status is reported back to Redis at each transition.

    Args:
        client: Redis connection for status reporting.
        job_data: Parsed JSON payload from the Redis queue.
    """
    job_id = job_data.get("job_id", "unknown")
    job_type = job_data.get("job_type", "unknown")
    scene_id = job_data.get("scene_id", "unknown")
    prompt = job_data.get("prompt", "")

    logger.info("Processing job %s (type=%s, scene=%s)", job_id, job_type, scene_id)

    # Mark as processing
    report_status(client, job_id, "processing")

    try:
        if job_type == "assemble":
            logger.info("Job %s: Assembling scene for prompt: '%s'", job_id, prompt[:80])

            # Fetch existing overrides if any
            overrides_key = f"scene:{scene_id}:overrides"
            existing_overrides = client.lrange(overrides_key, 0, -1)

            # Build job data with overrides for assembler
            assemble_data = {
                "scene_id": scene_id,
                "prompt": prompt,
                "overrides": existing_overrides if existing_overrides else None,
            }

            # Run the assembler with AI model client
            from src.assembler import assemble_scene
            result = assemble_scene(assemble_data, model_client=model_client)

            # Store layers in Redis
            store_scene_layers(
                client,
                scene_id,
                result["base_layer_usda"],
                result["composed_usda"],
            )

            # Report success with model info
            report_status(client, job_id, "completed", result={
                "scene_id": scene_id,
                "objects_count": result["objects_count"],
                "base_layer_size": len(result["base_layer_usda"]),
                "composed_size": len(result["composed_usda"]),
                "ai_model_used": result["ai_model_used"],
                "model_info": result["model_info"],
            })

        elif job_type == "render":
            # TODO: Import and call renderer.render_final(job_data)
            logger.info("Job %s: Rendering — not yet implemented", job_id)
            time.sleep(1)

            report_status(client, job_id, "completed", result={
                "scene_id": scene_id,
                "output": "placeholder — render not yet implemented",
            })

        else:
            logger.warning("Job %s: Unknown job type '%s'", job_id, job_type)
            report_status(client, job_id, "failed", error=f"Unknown job type: {job_type}")
            return

        logger.info("✅ Job %s completed successfully", job_id)

    except Exception as e:
        error_msg = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
        logger.error("❌ Job %s failed: %s", job_id, e)
        report_status(client, job_id, "failed", error=error_msg)


# ─── Main Loop ───────────────────────────────────────────────────────


def main():
    """Main worker loop — poll Redis for jobs and process them."""
    logger.info("🚀 Blender Worker starting...")
    logger.info("   Redis: %s", REDIS_ADDR)
    logger.info("   Queue: %s", JOB_QUEUE)

    client = connect_redis()

    # Verify Redis connection
    try:
        client.ping()
        logger.info("✅ Connected to Redis")
    except redis.ConnectionError as e:
        logger.error("❌ Failed to connect to Redis: %s", e)
        sys.exit(1)

    # Initialize AI model client
    from src.model_client import create_client
    model_client = create_client()
    logger.info("🤖 Model provider: %s", getattr(model_client, 'provider_name', 'unknown'))

    # Poll loop
    while _running:
        try:
            # BLPOP blocks for POLL_INTERVAL seconds, returns (key, value) or None
            result = client.blpop(JOB_QUEUE, timeout=int(POLL_INTERVAL))
            if result is not None:
                _, raw_payload = result
                try:
                    job_data = json.loads(raw_payload)
                    process_job(client, job_data, model_client=model_client)
                except json.JSONDecodeError as e:
                    logger.error("Invalid job payload: %s", e)
        except redis.ConnectionError:
            logger.warning("Redis connection lost. Reconnecting in 5s...")
            time.sleep(5)
            client = connect_redis()

    logger.info("🛑 Blender Worker shut down gracefully.")


if __name__ == "__main__":
    main()
