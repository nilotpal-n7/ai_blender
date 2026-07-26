"""AI Blender — Headless Blender Worker

This package provides the assembly engine that:
1. Polls jobs from the Redis queue
2. Runs headless Blender to assemble AI-generated assets
3. Manages OpenUSD layer composition
4. Outputs .usdz previews and final .blend/.mp4 renders
"""

__version__ = "0.1.0"
