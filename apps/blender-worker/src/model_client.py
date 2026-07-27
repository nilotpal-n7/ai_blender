"""Model Client — Provider-agnostic 3D mesh generation abstraction.

This module provides a unified interface for generating 3D meshes from
text prompts. It supports multiple backends:

    - "self_hosted": Hunyuan3D-2.1 api_server.py on a local/remote GPU
    - "replicate":   Replicate cloud API (~$0.18/run)
    - "mock":        Returns procedural placeholder meshes (no GPU needed)

The active provider is selected via the MODEL_PROVIDER environment variable.
"""

import base64
import io
import json
import logging
import os
import struct
import time
from dataclasses import dataclass, field
from typing import Protocol

import requests

logger = logging.getLogger("blender-worker.model_client")

# ─── Configuration ───────────────────────────────────────────────────

MODEL_PROVIDER = os.getenv("MODEL_PROVIDER", "mock")
HUNYUAN3D_ENDPOINT = os.getenv("HUNYUAN3D_ENDPOINT", "http://localhost:7860")
HUNYUAN3D_TEXTURE = os.getenv("HUNYUAN3D_TEXTURE", "false").lower() == "true"
REPLICATE_API_TOKEN = os.getenv("REPLICATE_API_TOKEN", "")
REPLICATE_MODEL_VERSION = os.getenv(
    "REPLICATE_MODEL_VERSION",
    "tencent/hunyuan3d-2.1",
)


# ─── Data Types ──────────────────────────────────────────────────────


@dataclass
class MeshResult:
    """Result from a mesh generation request."""

    mesh_data: bytes  # Raw mesh file bytes
    format: str  # "glb" or "obj"
    provider: str  # Which backend produced this
    generation_time: float  # Seconds taken
    metadata: dict = field(default_factory=dict)


# ─── Client Protocol ────────────────────────────────────────────────


class ModelClient(Protocol):
    """Protocol for 3D mesh generation backends."""

    provider_name: str

    def generate_mesh(
        self,
        prompt: str,
        seed: int = 1234,
        steps: int = 30,
        guidance_scale: float = 5.5,
        octree_resolution: int = 256,
    ) -> MeshResult:
        """Generate a 3D mesh from a text prompt."""
        ...

    def health_check(self) -> bool:
        """Check if the model backend is available."""
        ...


# ─── Self-Hosted Client ─────────────────────────────────────────────


class HunyuanSelfHostedClient:
    """Client for Hunyuan3D-2.1 self-hosted api_server.py.

    Connects to a running instance of Hunyuan3D's FastAPI server.
    Supports both text-to-3D (via /generate) and async generation
    (via /send + /status/{uid}).
    """

    provider_name = "self_hosted"

    def __init__(self, endpoint: str, texture: bool = False):
        self.endpoint = endpoint.rstrip("/")
        self.texture = texture
        logger.info("Hunyuan3D self-hosted client: %s (texture=%s)",
                     self.endpoint, self.texture)

    def generate_mesh(
        self,
        prompt: str,
        seed: int = 1234,
        steps: int = 30,
        guidance_scale: float = 5.5,
        octree_resolution: int = 256,
    ) -> MeshResult:
        """Generate mesh via self-hosted Hunyuan3D api_server."""
        start = time.time()

        payload = {
            "text": prompt,
            "texture": self.texture,
            "type": "glb",
            "seed": seed,
            "num_inference_steps": steps,
            "guidance_scale": guidance_scale,
            "octree_resolution": octree_resolution,
        }

        logger.info("Requesting mesh from self-hosted Hunyuan3D: '%s'", prompt[:80])

        try:
            resp = requests.post(
                f"{self.endpoint}/generate",
                json=payload,
                timeout=300,  # 5 minute timeout for generation
            )
            resp.raise_for_status()
        except requests.RequestException as e:
            raise RuntimeError(f"Hunyuan3D request failed: {e}") from e

        # Response can be either:
        # 1. Direct binary GLB data
        # 2. JSON with base64-encoded mesh
        content_type = resp.headers.get("content-type", "")

        if "application/octet-stream" in content_type or "model/gltf-binary" in content_type:
            mesh_data = resp.content
        elif "application/json" in content_type:
            data = resp.json()
            if "mesh" in data:
                mesh_data = base64.b64decode(data["mesh"])
            elif "file" in data:
                mesh_data = base64.b64decode(data["file"])
            else:
                raise RuntimeError(f"Unexpected response format: {list(data.keys())}")
        else:
            # Try treating as binary
            mesh_data = resp.content

        elapsed = time.time() - start
        logger.info("Received mesh from Hunyuan3D: %d bytes in %.1fs", len(mesh_data), elapsed)

        return MeshResult(
            mesh_data=mesh_data,
            format="glb",
            provider="self_hosted",
            generation_time=elapsed,
            metadata={
                "model": "hunyuan3d-2.1",
                "steps": steps,
                "seed": seed,
                "resolution": octree_resolution,
            },
        )

    def health_check(self) -> bool:
        """Check if the self-hosted server is running."""
        try:
            resp = requests.get(f"{self.endpoint}/health", timeout=5)
            return resp.status_code == 200
        except requests.RequestException:
            return False


# ─── Replicate Client ────────────────────────────────────────────────


class HunyuanReplicateClient:
    """Client for Hunyuan3D via Replicate cloud API.

    Uses Replicate's prediction API to run Hunyuan3D remotely.
    Requires a REPLICATE_API_TOKEN.
    """

    provider_name = "replicate"

    def __init__(self, api_token: str, model_version: str):
        self.api_token = api_token
        self.model_version = model_version
        self.api_base = "https://api.replicate.com/v1"
        logger.info("Replicate client initialized: %s", model_version)

    def generate_mesh(
        self,
        prompt: str,
        seed: int = 1234,
        steps: int = 30,
        guidance_scale: float = 5.5,
        octree_resolution: int = 256,
    ) -> MeshResult:
        """Generate mesh via Replicate's hosted Hunyuan3D."""
        start = time.time()

        headers = {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
        }

        # Create prediction
        payload = {
            "version": self.model_version,
            "input": {
                "prompt": prompt,
                "seed": seed,
                "num_inference_steps": steps,
                "guidance_scale": guidance_scale,
                "octree_resolution": octree_resolution,
                "output_format": "glb",
            },
        }

        logger.info("Creating Replicate prediction for: '%s'", prompt[:80])

        try:
            resp = requests.post(
                f"{self.api_base}/predictions",
                json=payload,
                headers=headers,
                timeout=30,
            )
            resp.raise_for_status()
            prediction = resp.json()
        except requests.RequestException as e:
            raise RuntimeError(f"Replicate prediction creation failed: {e}") from e

        # Poll for completion
        prediction_url = prediction.get("urls", {}).get("get", "")
        if not prediction_url:
            prediction_url = f"{self.api_base}/predictions/{prediction['id']}"

        max_polls = 180  # 15 minutes at 5s intervals
        for _ in range(max_polls):
            time.sleep(5)
            try:
                status_resp = requests.get(prediction_url, headers=headers, timeout=10)
                status_resp.raise_for_status()
                status_data = status_resp.json()
            except requests.RequestException:
                continue

            status = status_data.get("status", "")

            if status == "succeeded":
                output = status_data.get("output")
                if isinstance(output, str):
                    # Output is a URL to the mesh file
                    mesh_resp = requests.get(output, timeout=60)
                    mesh_resp.raise_for_status()
                    mesh_data = mesh_resp.content
                elif isinstance(output, list) and output:
                    mesh_resp = requests.get(output[0], timeout=60)
                    mesh_resp.raise_for_status()
                    mesh_data = mesh_resp.content
                else:
                    raise RuntimeError(f"Unexpected output format: {type(output)}")

                elapsed = time.time() - start
                logger.info("Replicate prediction completed: %d bytes in %.1fs",
                             len(mesh_data), elapsed)

                return MeshResult(
                    mesh_data=mesh_data,
                    format="glb",
                    provider="replicate",
                    generation_time=elapsed,
                    metadata={
                        "model": self.model_version,
                        "prediction_id": prediction.get("id"),
                        "steps": steps,
                        "seed": seed,
                    },
                )

            elif status == "failed":
                error = status_data.get("error", "Unknown error")
                raise RuntimeError(f"Replicate prediction failed: {error}")

            elif status == "canceled":
                raise RuntimeError("Replicate prediction was canceled")

        raise RuntimeError("Replicate prediction timed out")

    def health_check(self) -> bool:
        """Check if Replicate API is reachable."""
        try:
            headers = {"Authorization": f"Bearer {self.api_token}"}
            resp = requests.get(
                f"{self.api_base}/models/{self.model_version}",
                headers=headers,
                timeout=10,
            )
            return resp.status_code == 200
        except requests.RequestException:
            return False


# ─── Mock Client ─────────────────────────────────────────────────────


class MockModelClient:
    """Mock client that generates a minimal valid GLB for testing.

    Produces a tiny GLB file containing a single triangle mesh.
    Used when no GPU is available (MODEL_PROVIDER=mock).
    """

    provider_name = "mock"

    def generate_mesh(
        self,
        prompt: str,
        seed: int = 1234,
        steps: int = 30,
        guidance_scale: float = 5.5,
        octree_resolution: int = 256,
    ) -> MeshResult:
        """Generate a mock GLB mesh (minimal valid file)."""
        start = time.time()
        logger.info("Mock model: generating placeholder mesh for '%s'", prompt[:80])

        # Simulate generation delay
        time.sleep(0.5)

        glb_data = _create_minimal_glb()
        elapsed = time.time() - start

        return MeshResult(
            mesh_data=glb_data,
            format="glb",
            provider="mock",
            generation_time=elapsed,
            metadata={
                "model": "mock-placeholder",
                "prompt": prompt[:100],
                "note": "This is a placeholder mesh. Set MODEL_PROVIDER to use real AI generation.",
            },
        )

    def health_check(self) -> bool:
        """Mock is always available."""
        return True


def _create_minimal_glb() -> bytes:
    """Create a minimal valid GLB file containing a single triangle.

    The GLB (GL Binary) format is:
    - 12-byte header: magic, version, length
    - JSON chunk: glTF scene description
    - Binary chunk: vertex/index data
    """
    # Vertex positions (3 vertices of a triangle, float32)
    vertices = [
        0.0, 0.0, 0.0,   # v0
        1.0, 0.0, 0.0,   # v1
        0.5, 1.0, 0.0,   # v2
    ]
    vertex_data = struct.pack(f"<{len(vertices)}f", *vertices)

    # Indices (uint16)
    indices = [0, 1, 2]
    index_data = struct.pack(f"<{len(indices)}H", *indices)

    # Pad index data to 4-byte boundary
    index_padding = (4 - len(index_data) % 4) % 4
    index_data += b"\x00" * index_padding

    # Combined binary buffer
    bin_data = vertex_data + index_data

    # glTF JSON
    gltf = {
        "asset": {"version": "2.0", "generator": "ai-blender-mock"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "MockMesh"}],
        "meshes": [{
            "primitives": [{
                "attributes": {"POSITION": 0},
                "indices": 1,
            }],
        }],
        "accessors": [
            {  # positions
                "bufferView": 0,
                "componentType": 5126,  # FLOAT
                "count": 3,
                "type": "VEC3",
                "min": [0.0, 0.0, 0.0],
                "max": [1.0, 1.0, 0.0],
            },
            {  # indices
                "bufferView": 1,
                "componentType": 5123,  # UNSIGNED_SHORT
                "count": 3,
                "type": "SCALAR",
            },
        ],
        "bufferViews": [
            {  # vertex buffer view
                "buffer": 0,
                "byteOffset": 0,
                "byteLength": len(vertex_data),
                "target": 34962,  # ARRAY_BUFFER
            },
            {  # index buffer view
                "buffer": 0,
                "byteOffset": len(vertex_data),
                "byteLength": len(indices) * 2,
                "target": 34963,  # ELEMENT_ARRAY_BUFFER
            },
        ],
        "buffers": [{"byteLength": len(bin_data)}],
    }

    json_str = json.dumps(gltf, separators=(",", ":"))
    json_bytes = json_str.encode("utf-8")

    # Pad JSON to 4-byte boundary
    json_padding = (4 - len(json_bytes) % 4) % 4
    json_bytes += b" " * json_padding

    # Build GLB
    # Header: magic(4) + version(4) + length(4) = 12 bytes
    # JSON chunk: length(4) + type(4) + data
    # BIN chunk: length(4) + type(4) + data
    json_chunk_length = len(json_bytes)
    bin_chunk_length = len(bin_data)
    total_length = 12 + 8 + json_chunk_length + 8 + bin_chunk_length

    buf = io.BytesIO()
    # GLB header
    buf.write(struct.pack("<I", 0x46546C67))  # magic: "glTF"
    buf.write(struct.pack("<I", 2))           # version
    buf.write(struct.pack("<I", total_length))
    # JSON chunk
    buf.write(struct.pack("<I", json_chunk_length))
    buf.write(struct.pack("<I", 0x4E4F534A))  # type: "JSON"
    buf.write(json_bytes)
    # BIN chunk
    buf.write(struct.pack("<I", bin_chunk_length))
    buf.write(struct.pack("<I", 0x004E4942))  # type: "BIN\0"
    buf.write(bin_data)

    return buf.getvalue()


# ─── Factory ─────────────────────────────────────────────────────────


def create_client() -> ModelClient:
    """Create a model client based on environment configuration.

    Returns the appropriate client based on MODEL_PROVIDER env var:
        - "self_hosted": HunyuanSelfHostedClient
        - "replicate": HunyuanReplicateClient
        - "mock": MockModelClient (default)
    """
    provider = MODEL_PROVIDER.lower()

    if provider == "self_hosted":
        client = HunyuanSelfHostedClient(
            endpoint=HUNYUAN3D_ENDPOINT,
            texture=HUNYUAN3D_TEXTURE,
        )
        if client.health_check():
            logger.info("✅ Hunyuan3D self-hosted client ready")
        else:
            logger.warning("⚠️  Hunyuan3D server not reachable at %s — will retry on first request",
                           HUNYUAN3D_ENDPOINT)
        return client

    elif provider == "replicate":
        if not REPLICATE_API_TOKEN:
            logger.warning("⚠️  REPLICATE_API_TOKEN not set — falling back to mock")
            return MockModelClient()
        client = HunyuanReplicateClient(
            api_token=REPLICATE_API_TOKEN,
            model_version=REPLICATE_MODEL_VERSION,
        )
        logger.info("✅ Replicate client ready (%s)", REPLICATE_MODEL_VERSION)
        return client

    else:
        logger.info("🧪 Using mock model client (set MODEL_PROVIDER for real AI generation)")
        return MockModelClient()
