import * as fs from "fs";
import * as path from "path";
import { interrupted } from "./signals";

/**
 * Get the ComfyUI API base URL from environment variable or default
 */
export function getComfyBaseUrl(): string {
  return process.env.COMFYUI_API_URL || "http://192.222.58.100:8000";
}

/**
 * Get authorization headers for ComfyUI API requests.
 * Returns Bearer token header if COMFYUI_API_TOKEN is set, otherwise empty object.
 */
function getAuthHeaders(): Record<string, string> {
  const token = process.env.COMFYUI_API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Upload an asset file to ComfyUI
 * @param filePath - Path to the file to upload
 * @returns Asset UUID
 */
export async function uploadAsset(filePath: string): Promise<string> {
  const baseUrl = getComfyBaseUrl();
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: "application/octet-stream" });
  formData.append("file", blob, fileName);

  const response = await fetch(`${baseUrl}/assets/upload`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upload asset: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

/**
 * Run a workflow on ComfyUI
 * @param workflow - Workflow name (e.g., "text_to_image")
 * @param params - Workflow parameters
 * @returns Job ID
 */
export async function runWorkflow(
  workflow: string,
  params: Record<string, unknown>
): Promise<string> {
  const baseUrl = getComfyBaseUrl();

  const response = await fetch(`${baseUrl}/workflows/${workflow}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to run workflow: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as { job_id: string };
  return data.job_id;
}

/**
 * Single-poll check of a job's status (no loop, no retry).
 * Used to check if a pending job from a previous run has completed.
 * @param jobId - Job ID to check
 * @returns Job status and output asset IDs, or null if unreachable/not found
 */
export async function checkJob(jobId: string): Promise<{ status: string; outputAssetIds: string[] } | null> {
  const baseUrl = getComfyBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/jobs/${jobId}`, {
      headers: getAuthHeaders(),
    });
    if (!response.ok) return null;
    const data = await response.json() as { status: string; output_asset_ids?: string[] };
    return { status: data.status, outputAssetIds: data.output_asset_ids || [] };
  } catch {
    return null;
  }
}

/**
 * Poll a job until completion or failure
 * @param jobId - Job ID to poll
 * @returns Job status and output asset IDs
 */
export async function pollJob(
  jobId: string
): Promise<{ status: string; outputAssetIds: string[] }> {
  const baseUrl = getComfyBaseUrl();
  const pollIntervalMs = 5000;

  while (true) {
    if (interrupted) {
      await cancelJob(jobId);
      throw new Error(`Job ${jobId} cancelled due to pipeline interruption`);
    }

    const response = await fetch(`${baseUrl}/jobs/${jobId}`, {
      method: "GET",
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to poll job: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      status: string;
      output_asset_ids?: string[];
    };

    if (data.status === "completed") {
      return {
        status: data.status,
        outputAssetIds: data.output_asset_ids || [],
      };
    }

    if (data.status === "failed") {
      throw new Error(`Job ${jobId} failed`);
    }

    // Wait before polling again
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Cancel a running ComfyUI job (best-effort)
 * @param jobId - Job ID to cancel
 */
export async function cancelJob(jobId: string): Promise<void> {
  const baseUrl = getComfyBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/jobs/${jobId}/cancel`, {
      method: "POST",
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      console.warn(`[cancelJob] Failed to cancel job ${jobId}: ${response.status}`);
    }
  } catch (err) {
    console.warn(`[cancelJob] Failed to cancel job ${jobId}:`, err);
  }
}

/**
 * Download an asset from ComfyUI and write to disk
 * @param assetId - Asset ID to download
 * @param outputPath - Path where to write the file
 */
export async function downloadAsset(
  assetId: string,
  outputPath: string
): Promise<void> {
  const baseUrl = getComfyBaseUrl();

  const response = await fetch(`${baseUrl}/assets/${assetId}/file`, {
    method: "GET",
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download asset: ${response.status} ${response.statusText}`
    );
  }

  const buffer = await response.arrayBuffer();
  const dir = path.dirname(outputPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

