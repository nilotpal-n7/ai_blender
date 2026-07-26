"""Worker — Main job loop for the Blender assembly engine.

This module connects to the Redis job queue and processes incoming
assembly/render jobs dispatched by the Go orchestrator.

Each job contains:
    - job_id: Unique identifier
    - job_type: "assemble" | "render"
    - payload: JSON with scene_id, prompt, asset URLs, USD layers, etc.

The worker runs inside a headless Blender process via:
    blender --background --python src/worker.py
"""

import json
import logging
import os
import signal
import sys
import time

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


# ─── Job Processing ─────────────────────────────────────────────────


def process_job(job_data: dict) -> None:
    """Process a single job from the queue.

    This is the main dispatch point. Based on job_type, it delegates to
    the assembler (scene composition) or renderer (final output).

    Args:
        job_data: Parsed JSON payload from the Redis queue.
    """
    job_id = job_data.get("job_id", "unknown")
    job_type = job_data.get("job_type", "unknown")

    logger.info("Processing job %s (type=%s)", job_id, job_type)

    if job_type == "assemble":
        # TODO: Import and call assembler.assemble_scene(job_data)
        logger.info("Job %s: Assembly — not yet implemented", job_id)
    elif job_type == "render":
        # TODO: Import and call renderer.render_final(job_data)
        logger.info("Job %s: Render — not yet implemented", job_id)
    else:
        logger.warning("Job %s: Unknown job type '%s'", job_id, job_type)

    logger.info("Job %s completed", job_id)


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

    # Poll loop
    while _running:
        try:
            # BLPOP blocks for POLL_INTERVAL seconds, returns (key, value) or None
            result = client.blpop(JOB_QUEUE, timeout=int(POLL_INTERVAL))
            if result is not None:
                _, raw_payload = result
                try:
                    job_data = json.loads(raw_payload)
                    process_job(job_data)
                except json.JSONDecodeError as e:
                    logger.error("Invalid job payload: %s", e)
        except redis.ConnectionError:
            logger.warning("Redis connection lost. Reconnecting in 5s...")
            time.sleep(5)
            client = connect_redis()

    logger.info("🛑 Blender Worker shut down gracefully.")


if __name__ == "__main__":
    main()
