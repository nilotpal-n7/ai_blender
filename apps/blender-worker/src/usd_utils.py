"""USD Utilities — OpenUSD layer composition and override management.

This module is the core of the "contextual memory" system. It provides
functions for creating, composing, and flattening OpenUSD layers using
the `pxr` library entirely in-memory (no disk I/O required).

Key concepts:
    - Base Layer: The AI-authored .usda with the full scene
    - Override Layer: A lightweight .usda text diff from user edits
    - Composed Stage: The flattened result of stacking all layers

Layer composition uses Sdf.Layer.CreateAnonymous() + ImportFromString()
so that all operations happen in memory without touching the filesystem.
"""

import logging
import math
import re
from typing import Optional

from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdShade

logger = logging.getLogger("blender-worker.usd_utils")


# ─── Stage Creation ──────────────────────────────────────────────────


def create_empty_stage(output_path: Optional[str] = None) -> Usd.Stage:
    """Create a new, empty USD stage.

    Args:
        output_path: Optional file path. If None, creates an anonymous
                     in-memory stage.

    Returns:
        The newly created Usd.Stage object.
    """
    if output_path:
        stage = Usd.Stage.CreateNew(output_path)
    else:
        stage = Usd.Stage.CreateInMemory()

    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)

    root = stage.DefinePrim("/World", "Xform")
    stage.SetDefaultPrim(root)

    if output_path:
        stage.GetRootLayer().Save()
        logger.info("Created empty USD stage: %s", output_path)
    else:
        logger.info("Created empty in-memory USD stage")

    return stage


def stage_to_usda(stage: Usd.Stage) -> str:
    """Export a stage's root layer to USDA text.

    Args:
        stage: The USD stage to export.

    Returns:
        USDA-formatted text string.
    """
    return stage.GetRootLayer().ExportToString()


# ─── Layer Composition ───────────────────────────────────────────────


def apply_override_layer(base_usda: str, override_usda: str) -> str:
    """Apply a user override layer on top of a base USDA.

    Composes two USDA text strings using sublayer composition.
    The override is the strongest opinion (inserted at index 0).

    Args:
        base_usda: USDA text of the base layer.
        override_usda: USDA text of the override layer.

    Returns:
        Composed USDA text with the override applied.
    """
    # Create anonymous layers from USDA strings
    base_layer = Sdf.Layer.CreateAnonymous("base")
    base_layer.ImportFromString(base_usda)

    override_layer = Sdf.Layer.CreateAnonymous("override")
    override_layer.ImportFromString(override_usda)

    # Create a composition layer that sublayers both
    composed_layer = Sdf.Layer.CreateAnonymous("composed")
    # Insert override first (strongest), then base (weakest)
    composed_layer.subLayerPaths.append(override_layer.identifier)
    composed_layer.subLayerPaths.append(base_layer.identifier)

    # Open as a stage to flatten
    stage = Usd.Stage.Open(composed_layer)
    flattened = stage.Flatten()

    result = flattened.ExportToString()
    logger.info("Applied override layer (base=%d chars, override=%d chars, result=%d chars)",
                len(base_usda), len(override_usda), len(result))

    return result


def get_composed_state_as_text(
    base_usda: str,
    override_usdas: list[str] | None = None,
) -> str:
    """Get the composed scene state as flattened USDA text.

    Stacks the base layer with all override layers (ordered strongest
    to weakest) and flattens into a single USDA string suitable for
    LLM context injection.

    Args:
        base_usda: USDA text of the base layer.
        override_usdas: Optional ordered list of override USDA strings.
                        First element is the strongest (most recent edit).

    Returns:
        Flattened USDA text of the composed scene.
    """
    overrides = override_usdas or []

    if not overrides:
        # No overrides — just return the base
        return base_usda

    # Create anonymous layers
    base_layer = Sdf.Layer.CreateAnonymous("base")
    base_layer.ImportFromString(base_usda)

    # Build composition layer
    composed_layer = Sdf.Layer.CreateAnonymous("composed")

    # Add overrides strongest-first, then base as weakest
    for i, override_usda in enumerate(overrides):
        ovr_layer = Sdf.Layer.CreateAnonymous(f"override_{i}")
        ovr_layer.ImportFromString(override_usda)
        composed_layer.subLayerPaths.append(ovr_layer.identifier)

    composed_layer.subLayerPaths.append(base_layer.identifier)

    # Flatten
    stage = Usd.Stage.Open(composed_layer)
    flattened = stage.Flatten()

    result = flattened.ExportToString()
    logger.info("Composed state: base + %d overrides → %d chars", len(overrides), len(result))

    return result


# ─── Mesh Insertion ──────────────────────────────────────────────────


def insert_mesh_into_stage(base_usda: str, mesh_usda: str) -> str:
    """Insert an AI-generated mesh USDA into an existing scene.

    Composes the mesh layer as the strongest sublayer on top of the
    base scene, effectively adding the mesh to the scene while
    preserving existing geometry, lighting, and camera.

    Args:
        base_usda: USDA text of the existing scene.
        mesh_usda: USDA text of the AI-generated mesh to insert.

    Returns:
        Composed USDA text with the mesh merged into the scene.
    """
    base_layer = Sdf.Layer.CreateAnonymous("base_scene")
    base_layer.ImportFromString(base_usda)

    mesh_layer = Sdf.Layer.CreateAnonymous("ai_mesh")
    mesh_layer.ImportFromString(mesh_usda)

    composed = Sdf.Layer.CreateAnonymous("merged")
    composed.subLayerPaths.append(mesh_layer.identifier)
    composed.subLayerPaths.append(base_layer.identifier)

    stage = Usd.Stage.Open(composed)
    flattened = stage.Flatten()

    result = flattened.ExportToString()
    logger.info("Inserted mesh into scene: result=%d chars", len(result))
    return result


# ─── Procedural Scene Generation ────────────────────────────────────

# Keyword-to-geometry mapping for prompt parsing
_GEOMETRY_KEYWORDS = {
    "cube": "Cube",
    "box": "Cube",
    "sphere": "Sphere",
    "ball": "Sphere",
    "cylinder": "Cylinder",
    "cone": "Cone",
    "torus": "Cube",  # USD doesn't have native torus, use cube as placeholder
    "plane": "Cube",  # Flat cube as plane
    "table": "Cube",
    "floor": "Cube",
    "wall": "Cube",
    "car": "Cube",
    "building": "Cube",
    "tree": "Cone",
    "person": "Cylinder",
    "character": "Cylinder",
    "motorcycle": "Cube",
}

# Keyword-to-color mapping
_COLOR_KEYWORDS = {
    "red": (0.9, 0.1, 0.1),
    "green": (0.1, 0.8, 0.2),
    "blue": (0.1, 0.2, 0.9),
    "yellow": (0.95, 0.85, 0.1),
    "orange": (0.95, 0.5, 0.1),
    "purple": (0.6, 0.1, 0.9),
    "pink": (0.95, 0.4, 0.7),
    "white": (0.95, 0.95, 0.95),
    "black": (0.05, 0.05, 0.05),
    "gray": (0.5, 0.5, 0.5),
    "grey": (0.5, 0.5, 0.5),
    "brown": (0.45, 0.25, 0.1),
    "gold": (0.85, 0.7, 0.2),
    "silver": (0.75, 0.75, 0.78),
    "wooden": (0.55, 0.35, 0.15),
    "metal": (0.7, 0.7, 0.72),
    "glass": (0.8, 0.9, 0.95),
    "neon": (0.2, 1.0, 0.8),
    "cyberpunk": (0.8, 0.1, 0.9),
}


def create_scene_from_prompt(prompt: str) -> str:
    """Generate a procedural USD scene from a text prompt.

    Parses the prompt for geometry, color, and lighting keywords and
    builds a corresponding USD stage. This is a placeholder until
    AI models (Hunyuan3D, TRELLIS) are integrated.

    Args:
        prompt: Natural language scene description.

    Returns:
        USDA text string of the generated scene.
    """
    stage = Usd.Stage.CreateInMemory()
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)

    world = stage.DefinePrim("/World", "Xform")
    stage.SetDefaultPrim(world)

    prompt_lower = prompt.lower()
    objects_created = []

    # ── Parse and create geometry ────────────────────────────────
    # Find color-object pairs or standalone objects
    color_context = (0.6, 0.6, 0.65)  # Default neutral gray
    position_offset = 0.0

    for color_name, color_rgb in _COLOR_KEYWORDS.items():
        if color_name in prompt_lower:
            color_context = color_rgb
            break

    for keyword, geo_type in _GEOMETRY_KEYWORDS.items():
        if keyword not in prompt_lower:
            continue

        # Determine object name (capitalize)
        obj_name = keyword.capitalize()
        if obj_name in objects_created:
            obj_name = f"{obj_name}_2"

        prim_path = f"/World/{obj_name}"

        # Determine color for this specific object
        obj_color = color_context
        # Check if a color appears near this keyword in the prompt
        for cn, cr in _COLOR_KEYWORDS.items():
            # Look for "color object" pattern
            pattern = rf"\b{cn}\b\s+\b{keyword}\b"
            if re.search(pattern, prompt_lower):
                obj_color = cr
                break

        # Create geometry
        if geo_type == "Cube":
            geom = UsdGeom.Cube.Define(stage, prim_path)
            if keyword in ("table", "floor", "plane"):
                geom.GetSizeAttr().Set(1.0)
                UsdGeom.XformCommonAPI(geom.GetPrim()).SetScale(
                    Gf.Vec3f(3.0, 3.0, 0.15)
                )
                UsdGeom.XformCommonAPI(geom.GetPrim()).SetTranslate(
                    Gf.Vec3d(position_offset, 0.0, 0.0)
                )
            elif keyword in ("wall", "building"):
                geom.GetSizeAttr().Set(1.0)
                UsdGeom.XformCommonAPI(geom.GetPrim()).SetScale(
                    Gf.Vec3f(4.0, 0.2, 3.0)
                )
                UsdGeom.XformCommonAPI(geom.GetPrim()).SetTranslate(
                    Gf.Vec3d(position_offset, -2.0, 1.5)
                )
            else:
                geom.GetSizeAttr().Set(1.0)
                UsdGeom.XformCommonAPI(geom.GetPrim()).SetTranslate(
                    Gf.Vec3d(position_offset, 0.0, 0.5)
                )
        elif geo_type == "Sphere":
            geom = UsdGeom.Sphere.Define(stage, prim_path)
            geom.GetRadiusAttr().Set(0.5)
            UsdGeom.XformCommonAPI(geom.GetPrim()).SetTranslate(
                Gf.Vec3d(position_offset, 0.0, 0.5)
            )
        elif geo_type == "Cylinder":
            geom = UsdGeom.Cylinder.Define(stage, prim_path)
            geom.GetRadiusAttr().Set(0.3)
            geom.GetHeightAttr().Set(1.8)
            UsdGeom.XformCommonAPI(geom.GetPrim()).SetTranslate(
                Gf.Vec3d(position_offset, 0.0, 0.9)
            )
        elif geo_type == "Cone":
            geom = UsdGeom.Cone.Define(stage, prim_path)
            geom.GetRadiusAttr().Set(0.4)
            geom.GetHeightAttr().Set(1.5)
            UsdGeom.XformCommonAPI(geom.GetPrim()).SetTranslate(
                Gf.Vec3d(position_offset, 0.0, 0.75)
            )

        # Apply material
        _apply_material(stage, geom.GetPrim(), obj_name, obj_color)

        objects_created.append(obj_name)
        position_offset += 2.0

    # ── If no geometry keywords matched, create a default cube ───
    if not objects_created:
        geom = UsdGeom.Cube.Define(stage, "/World/Object")
        geom.GetSizeAttr().Set(1.0)
        UsdGeom.XformCommonAPI(geom.GetPrim()).SetTranslate(
            Gf.Vec3d(0.0, 0.0, 0.5)
        )
        _apply_material(stage, geom.GetPrim(), "Object", color_context)
        objects_created.append("Object")

    # ── Ground plane ─────────────────────────────────────────────
    if "floor" not in prompt_lower and "plane" not in prompt_lower:
        ground = UsdGeom.Cube.Define(stage, "/World/GroundPlane")
        ground.GetSizeAttr().Set(1.0)
        UsdGeom.XformCommonAPI(ground.GetPrim()).SetScale(
            Gf.Vec3f(20.0, 20.0, 0.02)
        )
        UsdGeom.XformCommonAPI(ground.GetPrim()).SetTranslate(
            Gf.Vec3d(0.0, 0.0, -0.01)
        )
        _apply_material(stage, ground.GetPrim(), "Ground", (0.3, 0.3, 0.32))

    # ── Lighting ─────────────────────────────────────────────────
    _add_default_lighting(stage, prompt_lower)

    # ── Camera ───────────────────────────────────────────────────
    cam = UsdGeom.Camera.Define(stage, "/World/MainCamera")
    # Position camera to see the scene
    cam_distance = max(5.0, len(objects_created) * 2.0)
    UsdGeom.XformCommonAPI(cam.GetPrim()).SetTranslate(
        Gf.Vec3d(cam_distance, -cam_distance, cam_distance * 0.7)
    )
    cam.GetFocalLengthAttr().Set(35.0)

    usda_text = stage.GetRootLayer().ExportToString()
    logger.info("Generated procedural scene: %d objects, %d chars USDA",
                len(objects_created), len(usda_text))

    return usda_text


def _apply_material(
    stage: Usd.Stage,
    prim: Usd.Prim,
    name: str,
    color: tuple[float, float, float],
) -> None:
    """Create and bind a simple UsdPreviewSurface material to a prim."""
    mat_path = f"/World/Materials/Mat_{name}"
    material = UsdShade.Material.Define(stage, mat_path)

    shader = UsdShade.Shader.Define(stage, f"{mat_path}/PBRShader")
    shader.CreateIdAttr("UsdPreviewSurface")
    shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(
        Gf.Vec3f(*color)
    )
    shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.4)
    shader.CreateInput("metallic", Sdf.ValueTypeNames.Float).Set(0.0)

    material.CreateSurfaceOutput().ConnectToSource(
        shader.ConnectableAPI(), "surface"
    )

    UsdShade.MaterialBindingAPI.Apply(prim)
    UsdShade.MaterialBindingAPI(prim).Bind(material)


def _add_default_lighting(stage: Usd.Stage, prompt_lower: str) -> None:
    """Add lighting to the scene based on prompt keywords."""
    # Key light (always present)
    key_light = UsdLux.DistantLight.Define(stage, "/World/Lights/KeyLight")
    key_light.GetIntensityAttr().Set(500.0)
    key_light.GetColorAttr().Set(Gf.Vec3f(1.0, 0.95, 0.9))
    UsdGeom.XformCommonAPI(key_light.GetPrim()).SetRotate(
        Gf.Vec3f(-45.0, 0.0, 30.0), UsdGeom.XformCommonAPI.RotationOrderXYZ
    )

    # Fill light
    fill_light = UsdLux.DistantLight.Define(stage, "/World/Lights/FillLight")
    fill_light.GetIntensityAttr().Set(150.0)
    fill_light.GetColorAttr().Set(Gf.Vec3f(0.7, 0.8, 1.0))
    UsdGeom.XformCommonAPI(fill_light.GetPrim()).SetRotate(
        Gf.Vec3f(-30.0, 0.0, -60.0), UsdGeom.XformCommonAPI.RotationOrderXYZ
    )

    # Spotlight if mentioned
    if any(word in prompt_lower for word in ("spotlight", "spot light", "spot")):
        spot = UsdLux.SphereLight.Define(stage, "/World/Lights/Spotlight")
        spot.GetIntensityAttr().Set(1000.0)
        spot.GetColorAttr().Set(Gf.Vec3f(1.0, 1.0, 0.9))
        spot.GetRadiusAttr().Set(0.1)
        UsdGeom.XformCommonAPI(spot.GetPrim()).SetTranslate(
            Gf.Vec3d(0.0, 0.0, 5.0)
        )

    # Night / dark scene
    if any(word in prompt_lower for word in ("night", "dark", "midnight")):
        key_light.GetIntensityAttr().Set(100.0)
        fill_light.GetIntensityAttr().Set(30.0)
        fill_light.GetColorAttr().Set(Gf.Vec3f(0.3, 0.3, 0.6))

    # Neon lighting
    if "neon" in prompt_lower:
        neon = UsdLux.SphereLight.Define(stage, "/World/Lights/NeonGlow")
        neon.GetIntensityAttr().Set(800.0)
        neon.GetColorAttr().Set(Gf.Vec3f(0.8, 0.1, 0.9))
        neon.GetRadiusAttr().Set(0.2)
        UsdGeom.XformCommonAPI(neon.GetPrim()).SetTranslate(
            Gf.Vec3d(1.0, -1.0, 3.0)
        )
