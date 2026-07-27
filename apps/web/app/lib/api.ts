/**
 * API Client — Typed wrapper for the AI Blender orchestrator REST API.
 *
 * All communication with the Go backend flows through this module.
 * Base URL is configured via NEXT_PUBLIC_API_URL environment variable.
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api/v1";

// ─── Types ──────────────────────────────────────────────────────────

export interface Scene {
  scene_id: string;
  name: string;
  status: string;
  latest_job?: string;
  created_at: string;
  updated_at: string;
}

export interface Job {
  job_id: string;
  job_type: string;
  scene_id: string;
  prompt: string;
  status: "queued" | "processing" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  result?: string;
  error?: string;
}

export interface CreateSceneResponse {
  scene_id: string;
  name: string;
  status: string;
  created_at: string;
}

export interface SubmitPromptResponse {
  job_id: string;
  scene_id: string;
  status: string;
  message: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface ComposedResponse {
  scene_id: string;
  usda: string;
  size: number;
}

export interface LayerInfo {
  scene_id: string;
  has_base_layer: boolean;
  base_layer_size: number;
  override_count: number;
  composed_size: number;
  overrides?: string[];
}

export interface OverrideResponse {
  status: string;
  scene_id: string;
  override_count: number;
  message: string;
}

// ─── Fetch Wrapper ──────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  const data = await res.json();

  if (!res.ok) {
    const err = data as ApiError;
    throw new Error(err.message || `API error: ${res.status}`);
  }

  return data as T;
}

// ─── Scene API ──────────────────────────────────────────────────────

/**
 * Create a new scene session.
 */
export async function createScene(
  name: string
): Promise<CreateSceneResponse> {
  return apiFetch<CreateSceneResponse>("/scene/create", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/**
 * Get scene metadata by ID.
 */
export async function getScene(sceneId: string): Promise<Scene> {
  return apiFetch<Scene>(`/scene/${sceneId}`);
}

// ─── Prompt API ─────────────────────────────────────────────────────

/**
 * Submit a text prompt for AI scene generation.
 * Returns a job ID that can be polled for status.
 */
export async function submitPrompt(
  sceneId: string,
  prompt: string
): Promise<SubmitPromptResponse> {
  return apiFetch<SubmitPromptResponse>(`/scene/${sceneId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

// ─── Job API ────────────────────────────────────────────────────────

/**
 * Get the current status of a job.
 */
export async function getJobStatus(jobId: string): Promise<Job> {
  return apiFetch<Job>(`/job/${jobId}/status`);
}

/**
 * Poll a job until it reaches a terminal state (completed/failed).
 * Calls onUpdate with each status transition.
 * Returns the final job state.
 */
export async function pollJobUntilDone(
  jobId: string,
  onUpdate?: (job: Job) => void,
  intervalMs = 2000,
  maxAttempts = 150 // 5 minutes at 2s intervals
): Promise<Job> {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await getJobStatus(jobId);
    onUpdate?.(job);

    if (job.status === "completed" || job.status === "failed") {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Job ${jobId} timed out after ${maxAttempts} attempts`);
}

// ─── USD Layer API ──────────────────────────────────────────────────

/**
 * Get the composed (flattened) USDA state for a scene.
 */
export async function getComposedState(
  sceneId: string
): Promise<ComposedResponse> {
  return apiFetch<ComposedResponse>(`/scene/${sceneId}/composed`);
}

/**
 * Get layer stack info for a scene.
 */
export async function getSceneLayers(
  sceneId: string,
  includeContent = false
): Promise<LayerInfo> {
  const query = includeContent ? "?content=true" : "";
  return apiFetch<LayerInfo>(`/scene/${sceneId}/layers${query}`);
}

/**
 * Submit a USD override layer to a scene.
 */
export async function submitOverride(
  sceneId: string,
  overrideUsda: string
): Promise<OverrideResponse> {
  return apiFetch<OverrideResponse>(`/scene/${sceneId}/override`, {
    method: "POST",
    body: JSON.stringify({ override_usda: overrideUsda }),
  });
}
