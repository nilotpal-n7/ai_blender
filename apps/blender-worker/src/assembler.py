"""Assembler — Scene composition from prompts and USD layers.

This module generates 3D scenes from text prompts using OpenUSD.
Currently uses procedural geometry via pxr; will integrate AI-generated
assets (Hunyuan3D, TRELLIS) in the future.

The assembler:
1. Generates a base layer USDA from the prompt via usd_utils
2. If existing overrides are provided, composes them on top
3. Returns both the base layer and composed state as USDA text

Called by worker.py when job_type == "assemble".
"""

import logging
from typing import Optional

from src.usd_utils import (
    create_scene_from_prompt,
    get_composed_state_as_text,
)

logger = logging.getLogger("blender-worker.assembler")


def assemble_scene(job_data: dict) -> dict:
    """Assemble a 3D scene from a text prompt.

    Generates a procedural USD scene based on prompt keywords,
    then composes any existing user overrides on top.

    Args:
        job_data: Job payload containing:
            - scene_id: Unique scene identifier
            - prompt: Text description of the scene
            - overrides: Optional list of USDA override strings

    Returns:
        Dict with:
            - base_layer_usda: The AI-generated base layer
            - composed_usda: The flattened state with overrides applied
            - objects_count: Number of objects in the scene
    """
    scene_id = job_data.get("scene_id", "unknown")
    prompt = job_data.get("prompt", "")
    overrides: Optional[list[str]] = job_data.get("overrides")

    logger.info("Assembling scene %s for prompt: '%s'", scene_id, prompt[:100])

    # Generate base layer from prompt
    base_layer_usda = create_scene_from_prompt(prompt)
    logger.info("Generated base layer: %d chars", len(base_layer_usda))

    # Compose with any existing overrides
    if overrides:
        composed_usda = get_composed_state_as_text(base_layer_usda, overrides)
        logger.info("Composed with %d overrides: %d chars",
                     len(overrides), len(composed_usda))
    else:
        composed_usda = base_layer_usda

    # Count objects (rough heuristic from USDA)
    objects_count = base_layer_usda.count("def ") - 1  # Subtract Materials defs

    logger.info("✅ Scene %s assembled: %d objects", scene_id, max(0, objects_count))

    return {
        "base_layer_usda": base_layer_usda,
        "composed_usda": composed_usda,
        "objects_count": max(0, objects_count),
    }
