"""Mesh Converter — GLB-to-USD conversion pipeline.

Converts AI-generated GLB mesh data into USDA text that can be composed
into the OpenUSD scene layer stack.

Since the pxr library doesn't directly import GLB, we use two strategies:
1. Write GLB to a temp file and use bpy (if available in Blender runtime)
   to import GLB and export USD
2. Fallback: parse GLB structure manually and create USD geometry from
   extracted vertex/index data

In practice, strategy 2 (manual parsing) is used for the lightweight
mesh representation, while strategy 1 is preferred in the full Blender
Docker environment.
"""

import json
import logging
import math
import os
import struct
import tempfile
from typing import Optional

logger = logging.getLogger("blender-worker.mesh_converter")


def glb_to_usda(
    glb_bytes: bytes,
    prim_name: str = "AIMesh",
    translate: tuple[float, float, float] = (0.0, 0.0, 0.0),
    scale: float = 1.0,
) -> str:
    """Convert GLB mesh data to USDA text.

    Parses the GLB binary format to extract vertex positions and
    face indices, then generates USDA text with proper geometry
    and a default material.

    Args:
        glb_bytes: Raw GLB file bytes.
        prim_name: Name for the USD prim (e.g., "Car", "Character").
        translate: World-space position for the mesh.
        scale: Uniform scale factor.

    Returns:
        USDA text string containing the mesh as a USD Mesh prim.
    """
    logger.info("Converting GLB to USDA: %d bytes, prim=%s", len(glb_bytes), prim_name)

    try:
        vertices, normals, indices, face_counts = _parse_glb(glb_bytes)
    except Exception as e:
        logger.warning("GLB parsing failed (%s), using fallback cube", e)
        return _fallback_cube_usda(prim_name, translate, scale)

    if not vertices or not indices:
        logger.warning("GLB contained no geometry, using fallback cube")
        return _fallback_cube_usda(prim_name, translate, scale)

    logger.info("Parsed GLB: %d vertices, %d face indices, %d faces",
                len(vertices) // 3, len(indices), len(face_counts))

    return _build_mesh_usda(
        prim_name=prim_name,
        vertices=vertices,
        normals=normals,
        indices=indices,
        face_counts=face_counts,
        translate=translate,
        scale=scale,
    )


# ─── GLB Parser ──────────────────────────────────────────────────────


def _parse_glb(glb_bytes: bytes) -> tuple[list[float], list[float], list[int], list[int]]:
    """Parse a GLB binary file and extract mesh data.

    Returns (vertices, normals, indices, face_vertex_counts).
    vertices: flat list of floats [x,y,z, x,y,z, ...]
    normals: flat list of floats (may be empty)
    indices: flat list of vertex indices
    face_counts: number of vertices per face (3 for triangles)
    """
    if len(glb_bytes) < 12:
        raise ValueError("GLB too small")

    # Parse header
    magic, version, total_length = struct.unpack_from("<III", glb_bytes, 0)
    if magic != 0x46546C67:  # "glTF"
        raise ValueError(f"Not a GLB file (magic: {magic:#x})")

    # Parse chunks
    offset = 12
    json_data = None
    bin_data = None

    while offset < len(glb_bytes):
        if offset + 8 > len(glb_bytes):
            break
        chunk_length, chunk_type = struct.unpack_from("<II", glb_bytes, offset)
        offset += 8

        if chunk_type == 0x4E4F534A:  # "JSON"
            json_data = json.loads(glb_bytes[offset:offset + chunk_length])
        elif chunk_type == 0x004E4942:  # "BIN\0"
            bin_data = glb_bytes[offset:offset + chunk_length]

        offset += chunk_length

    if json_data is None or bin_data is None:
        raise ValueError("GLB missing JSON or BIN chunk")

    # Extract first mesh primitive
    meshes = json_data.get("meshes", [])
    if not meshes:
        raise ValueError("No meshes in GLB")

    primitives = meshes[0].get("primitives", [])
    if not primitives:
        raise ValueError("No primitives in mesh")

    prim = primitives[0]
    accessors = json_data.get("accessors", [])
    buffer_views = json_data.get("bufferViews", [])

    # Extract positions
    vertices: list[float] = []
    pos_idx = prim.get("attributes", {}).get("POSITION")
    if pos_idx is not None:
        vertices = _read_accessor(accessors[pos_idx], buffer_views, bin_data, "f")

    # Extract normals
    normals: list[float] = []
    norm_idx = prim.get("attributes", {}).get("NORMAL")
    if norm_idx is not None:
        try:
            normals = _read_accessor(accessors[norm_idx], buffer_views, bin_data, "f")
        except Exception:
            pass  # Normals are optional

    # Extract indices
    indices: list[int] = []
    idx_accessor = prim.get("indices")
    if idx_accessor is not None:
        acc = accessors[idx_accessor]
        comp_type = acc.get("componentType", 5123)
        if comp_type == 5123:  # UNSIGNED_SHORT
            indices = _read_accessor(acc, buffer_views, bin_data, "H")
        elif comp_type == 5125:  # UNSIGNED_INT
            indices = _read_accessor(acc, buffer_views, bin_data, "I")
        elif comp_type == 5121:  # UNSIGNED_BYTE
            indices = _read_accessor(acc, buffer_views, bin_data, "B")
        indices = [int(i) for i in indices]

    # Face counts (all triangles for GLB)
    face_counts = [3] * (len(indices) // 3)

    return vertices, normals, indices, face_counts


def _read_accessor(
    accessor: dict,
    buffer_views: list[dict],
    bin_data: bytes,
    fmt: str,
) -> list:
    """Read data from a glTF accessor."""
    bv_idx = accessor.get("bufferView", 0)
    bv = buffer_views[bv_idx]

    byte_offset = bv.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor.get("count", 0)

    # Determine elements per item
    type_map = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    elements = type_map.get(accessor.get("type", "SCALAR"), 1)

    total = count * elements
    item_size = struct.calcsize(f"<{fmt}")
    data = []

    for i in range(total):
        off = byte_offset + i * item_size
        if off + item_size <= len(bin_data):
            val = struct.unpack_from(f"<{fmt}", bin_data, off)[0]
            data.append(val)

    return data


# ─── USDA Builder ────────────────────────────────────────────────────


def _build_mesh_usda(
    prim_name: str,
    vertices: list[float],
    normals: list[float],
    indices: list[int],
    face_counts: list[int],
    translate: tuple[float, float, float],
    scale: float,
) -> str:
    """Build USDA text from parsed mesh data."""
    # Format vertex positions as string
    num_verts = len(vertices) // 3
    points_str = ", ".join(
        f"({vertices[i*3]:.6f}, {vertices[i*3+1]:.6f}, {vertices[i*3+2]:.6f})"
        for i in range(num_verts)
    )

    # Format face vertex indices
    indices_str = ", ".join(str(i) for i in indices)

    # Format face vertex counts
    counts_str = ", ".join(str(c) for c in face_counts)

    # Format normals if available
    normals_block = ""
    if normals and len(normals) == len(vertices):
        num_normals = len(normals) // 3
        normals_str = ", ".join(
            f"({normals[i*3]:.6f}, {normals[i*3+1]:.6f}, {normals[i*3+2]:.6f})"
            for i in range(num_normals)
        )
        normals_block = f"""
        normal3f[] normals = [{normals_str}] (
            interpolation = "vertex"
        )"""

    usda = f"""#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Z"
)

def Xform "World"
{{
    def Xform "{prim_name}" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {{
        double3 xformOp:translate = ({translate[0]}, {translate[1]}, {translate[2]})
        float3 xformOp:scale = ({scale}, {scale}, {scale})
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]

        def Mesh "{prim_name}_Geo"
        {{
            point3f[] points = [{points_str}]
            int[] faceVertexIndices = [{indices_str}]
            int[] faceVertexCounts = [{counts_str}]{normals_block}
        }}
    }}

    def Scope "Materials"
    {{
        def Material "Mat_{prim_name}"
        {{
            token outputs:surface.connect = </World/Materials/Mat_{prim_name}/PBRShader.outputs:surface>

            def Shader "PBRShader"
            {{
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0.7, 0.7, 0.72)
                float inputs:roughness = 0.4
                float inputs:metallic = 0.1
                token outputs:surface
            }}
        }}
    }}
}}
"""
    logger.info("Built USDA: %d vertices, %d faces, %d chars",
                num_verts, len(face_counts), len(usda))
    return usda


def _fallback_cube_usda(
    prim_name: str,
    translate: tuple[float, float, float],
    scale: float,
) -> str:
    """Generate a simple cube USDA as fallback when GLB parsing fails."""
    return f"""#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Z"
)

def Xform "World"
{{
    def Cube "{prim_name}" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    )
    {{
        double size = 1.0
        double3 xformOp:translate = ({translate[0]}, {translate[1]}, {translate[2] + 0.5})
        float3 xformOp:scale = ({scale}, {scale}, {scale})
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
        rel material:binding = </World/Materials/Mat_{prim_name}>
    }}

    def Scope "Materials"
    {{
        def Material "Mat_{prim_name}"
        {{
            token outputs:surface.connect = </World/Materials/Mat_{prim_name}/PBRShader.outputs:surface>

            def Shader "PBRShader"
            {{
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0.6, 0.6, 0.65)
                float inputs:roughness = 0.5
                float inputs:metallic = 0.0
                token outputs:surface
            }}
        }}
    }}
}}
"""
