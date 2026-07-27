"""Assembler — Scene composition from AI models and USD layers.

This module generates 3D scenes by:
1. Calling an AI model (Hunyuan3D) to generate a 3D mesh from the prompt
2. Converting the mesh (GLB) to USDA via mesh_converter
3. Building a complete scene with lighting, camera, and ground plane
4. Composing any existing user overrides on top

Falls back to procedural geometry (usd_utils.create_scene_from_prompt)
when the AI model is unavailable or fails.

Called by worker.py when job_type == "assemble".
"""

import logging
import time
from typing import Optional

from src.mesh_converter import glb_to_usda
from src.usd_utils import (
    create_scene_from_prompt,
    get_composed_state_as_text,
    insert_mesh_into_stage,
)

logger = logging.getLogger("blender-worker.assembler")


def assemble_scene(job_data: dict, model_client=None) -> dict:
    """Assemble a 3D scene from a text prompt.

    Uses the AI model client to generate real meshes when available.
    Falls back to procedural USD geometry otherwise.

    Args:
        job_data: Job payload containing:
            - scene_id: Unique scene identifier
            - prompt: Text description of the scene
            - overrides: Optional list of USDA override strings
        model_client: Optional model client for AI mesh generation.
                      If None, uses procedural fallback.

    Returns:
        Dict with:
            - base_layer_usda: The scene base layer
            - composed_usda: The flattened state with overrides applied
            - objects_count: Number of objects in the scene
            - ai_model_used: Whether an AI model was used
            - model_info: Details about the model/generation
    """
    scene_id = job_data.get("scene_id", "unknown")
    prompt = job_data.get("prompt", "")
    overrides: Optional[list[str]] = job_data.get("overrides")

    logger.info("Assembling scene %s for prompt: '%s'", scene_id, prompt[:100])

    ai_model_used = False
    model_info: dict = {}
    base_layer_usda = ""

    # ── Try AI model first ───────────────────────────────────────
    if model_client is not None:
        try:
            logger.info("Attempting AI mesh generation via %s...",
                        getattr(model_client, "provider_name", "unknown"))

            result = model_client.generate_mesh(prompt=prompt)

            logger.info("AI model returned %d bytes (%s) in %.1fs",
                        len(result.mesh_data), result.format, result.generation_time)

            # Convert GLB to USDA
            mesh_usda = glb_to_usda(
                glb_bytes=result.mesh_data,
                prim_name=_prompt_to_prim_name(prompt),
            )

            # Build a complete scene around the AI mesh
            # (adds lighting, camera, ground plane via procedural helper)
            scene_usda = create_scene_from_prompt(prompt)

            # Merge the AI mesh into the procedural scene
            base_layer_usda = insert_mesh_into_stage(scene_usda, mesh_usda)

            ai_model_used = True
            model_info = {
                "provider": result.provider,
                "format": result.format,
                "mesh_size": len(result.mesh_data),
                "generation_time": round(result.generation_time, 2),
                **result.metadata,
            }

            logger.info("✅ AI mesh integrated into scene (%s, %.1fs)",
                        result.provider, result.generation_time)

        except Exception as e:
            logger.warning("⚠️  AI model failed (%s), falling back to procedural: %s",
                           type(e).__name__, e)
            base_layer_usda = ""  # Reset to trigger fallback

    # ── Fallback to procedural ───────────────────────────────────
    if not base_layer_usda:
        logger.info("Using procedural scene generation")
        base_layer_usda = create_scene_from_prompt(prompt)
        model_info = {
            "provider": "procedural",
            "note": "Used keyword-based procedural generation (no AI model)",
        }

    logger.info("Base layer generated: %d chars", len(base_layer_usda))

    # ── Compose with overrides ───────────────────────────────────
    if overrides:
        composed_usda = get_composed_state_as_text(base_layer_usda, overrides)
        logger.info("Composed with %d overrides: %d chars",
                     len(overrides), len(composed_usda))
    else:
        composed_usda = base_layer_usda

    # Count objects (rough heuristic from USDA)
    objects_count = max(0, base_layer_usda.count("def ") - 1)

    logger.info("✅ Scene %s assembled: %d objects, ai=%s",
                scene_id, objects_count, ai_model_used)

    return {
        "base_layer_usda": base_layer_usda,
        "composed_usda": composed_usda,
        "objects_count": objects_count,
        "ai_model_used": ai_model_used,
        "model_info": model_info,
    }


def _prompt_to_prim_name(prompt: str) -> str:
    """Extract a reasonable prim name from a prompt.

    Takes the first meaningful noun-like word from the prompt
    and capitalizes it for use as a USD prim name.
    """
    skip_words = {
        "a", "an", "the", "with", "and", "or", "on", "in", "at",
        "of", "to", "for", "is", "are", "was", "were", "be",
        "has", "have", "had", "do", "does", "did", "will", "would",
        "could", "should", "may", "might", "must", "shall",
        "that", "this", "these", "those", "it", "its",
        "my", "your", "his", "her", "our", "their",
    }

    words = prompt.lower().split()
    for word in words:
        clean = "".join(c for c in word if c.isalpha())
        if clean and clean not in skip_words and len(clean) > 2:
            return clean.capitalize()

    return "AIMesh"
