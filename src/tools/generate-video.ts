import { z } from "zod";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { getGoogleClient } from "../google-client";
import { uploadAsset, runWorkflow, pollJob, downloadAsset, checkJob } from "../comfy-client";

// Cooldown tracking for Veo API calls to avoid rate-limit-like 400 errors
let lastVeoCallTimestamp = 0;
const VEO_COOLDOWN_MS = 30_000; // 30 seconds between Veo API calls

/** Shared parameter type for all video backends. */
type GenerateVideoParams = {
  shotNumber: number;
  shotType: "first_last_frame";
  actionPrompt: string;
  dialogue: string;
  soundEffects: string;
  cameraDirection: string;
  durationSeconds: 8;
  startFramePath: string;
  endFramePath: string;
  outputDir: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
  pendingJobStore?: {
    get: (key: string) => { jobId: string; outputPath: string } | undefined;
    set: (key: string, value: { jobId: string; outputPath: string }) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
};

/** Shared return type for all video backends. */
type GenerateVideoResult = { shotNumber: number; path: string; duration: number };

/**
 * Generates video clips for shots.
 * Dispatches to Veo 3.1 or ComfyUI backend based on VIDEO_BACKEND env var.
 */
export async function generateVideo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const backend = (process.env.VIDEO_BACKEND || "veo").toLowerCase();
  console.log(`[generateVideo] Using backend: ${backend}`);

  if (backend === "comfy") {
    return generateVideoComfy(params);
  } else if (backend === "veo") {
    return generateVideoVeo(params);
  } else {
    throw new Error(`[generateVideo] Unknown VIDEO_BACKEND: "${backend}". Use "veo" or "comfy".`);
  }
}

/**
 * Veo 3.1 backend: generates video via Google GenAI SDK.
 */
async function generateVideoVeo(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    shotType,
    actionPrompt,
    dialogue,
    soundEffects,
    cameraDirection,
    durationSeconds,
    startFramePath,
    endFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const outputPath = join(outputDir, `shot_${String(shotNumber).padStart(3, "0")}.mp4`);

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: Shot ${shotNumber} (${shotType}, ${durationSeconds}s)`);
    return { shotNumber, path: outputPath, duration: durationSeconds };
  }

  // Build video prompt from components
  const promptParts: string[] = [];
  if (actionPrompt) promptParts.push(actionPrompt);
  if (dialogue) promptParts.push(`Character says: "${dialogue}"`);
  if (soundEffects) promptParts.push(`Sound effects: ${soundEffects}`);
  if (cameraDirection) promptParts.push(`Camera: ${cameraDirection}`);
  const videoPrompt = promptParts.join(". ");

  console.log(`[generateVideo] Generating shot ${shotNumber} (${shotType}, ${durationSeconds}s)`);
  console.log(`[generateVideo] Prompt: ${videoPrompt.substring(0, 100)}...`);

  try {
    const client = getGoogleClient();
    const maxRetries = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // First+last frame interpolation
        if (!startFramePath || !endFramePath) {
          throw new Error("first_last_frame requires both startFramePath and endFramePath");
        }

        // Load images as base64
        const startImageBuffer = readFileSync(startFramePath);
        const startImage = {
          imageBytes: startImageBuffer.toString("base64"),
          mimeType: "image/png",
        };

        const endImageBuffer = readFileSync(endFramePath);
        const endImage = {
          imageBytes: endImageBuffer.toString("base64"),
          mimeType: "image/png",
        };

        // Build config
        // Veo 3.1 interpolation only supports 8s duration.
        const config: Record<string, unknown> = {
          durationSeconds: 8,
          aspectRatio: "16:9",
          personGeneration: "allow_adult",
        };

        console.log(`[generateVideo] Config: durationSeconds=${config.durationSeconds}, aspectRatio=${config.aspectRatio}`);

        // Enforce cooldown between consecutive Veo API calls
        const elapsed = Date.now() - lastVeoCallTimestamp;
        if (elapsed < VEO_COOLDOWN_MS) {
          const waitMs = VEO_COOLDOWN_MS - elapsed;
          console.log(`[generateVideo] Shot ${shotNumber}: Waiting ${Math.ceil(waitMs / 1000)}s cooldown before Veo API call...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        lastVeoCallTimestamp = Date.now();

        let operation = await client.models.generateVideos({
          model: "veo-3.1-generate-preview",
          prompt: videoPrompt,
          image: startImage,
          config: {
            ...config,
            lastFrame: endImage,
          } as any,
        });

        // Poll for operation completion
        console.log(`[generateVideo] Polling for completion (operation: ${operation.name})`);

        while (!operation.done) {
          // Check abort signal before polling
          if (abortSignal?.aborted) {
            throw new Error("Video generation cancelled due to pipeline interruption");
          }
          await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between polls
          operation = await client.operations.getVideosOperation({ operation });
        }

        // Extract generated video from response
        const response = operation.response;
        const generatedVideo = response?.generatedVideos?.[0];
        if (!generatedVideo?.video) {
          // Log full response for debugging (may include RAI filter info)
          const filterCount = response?.raiMediaFilteredCount;
          const filterReasons = response?.raiMediaFilteredReasons;
          const errorInfo = operation.error;
          console.error(`[generateVideo] Shot ${shotNumber}: No video returned.`);
          if (filterCount) console.error(`[generateVideo]   RAI filtered count: ${filterCount}`);
          if (filterReasons?.length) console.error(`[generateVideo]   RAI filter reasons: ${filterReasons.join(', ')}`);
          if (errorInfo) console.error(`[generateVideo]   Operation error: ${JSON.stringify(errorInfo)}`);
          if (!filterCount && !filterReasons?.length && !errorInfo) {
            console.error(`[generateVideo]   Full response: ${JSON.stringify(response)}`);
          }
          throw new Error(`No video in response for shot ${shotNumber}${filterReasons?.length ? ` (RAI: ${filterReasons.join(', ')})` : ''}`);
        }

        // Download the video to disk
        console.log(`[generateVideo] Downloading video for shot ${shotNumber}`);
        await client.files.download({
          file: generatedVideo.video,
          downloadPath: outputPath,
        });

        console.log(`[generateVideo] Shot ${shotNumber} saved to ${outputPath}`);
        return { shotNumber, path: outputPath, duration: 8 };
      } catch (error: any) {
        lastError = error;
        // Don't retry if cancelled due to pipeline interruption
        if (error?.message?.includes('cancelled due to pipeline interruption')) {
          throw error;
        }
        // Check if it's a 429 rate limit error
        if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn(`[generateVideo] Shot ${shotNumber}: Rate limited (429). Waiting 60s before retry ${attempt}/${maxRetries}...`);
          await new Promise((resolve) => setTimeout(resolve, 60000));
          continue;
        }
        // Non-retryable error: don't retry
        throw error;
      }
    }

    // All retries exhausted
    console.error(`[generateVideo] Shot ${shotNumber}: All ${maxRetries} retries exhausted`);
    throw lastError;
  } catch (error) {
    console.error(`[generateVideo] Error generating shot ${shotNumber}:`, error);
    throw error;
  }
}

/**
 * Vercel AI SDK tool definition for generateVideo.
 * Claude calls this to generate video clips for shots.
 */
export const generateVideoTool = {
  description:
    "Generate video clips for shots using first+last frame interpolation. Backend is selected by VIDEO_BACKEND env var.",
  parameters: z.object({
    shotNumber: z.number().describe("Global shot number"),
    shotType: z.literal("first_last_frame").describe("Video generation mode"),
    actionPrompt: z.string().describe("Action description for the shot"),
    dialogue: z.string().describe("Character dialogue (empty if none)"),
    soundEffects: z.string().describe("Sound effects description"),
    cameraDirection: z.string().describe("Camera movement and angle"),
    durationSeconds: z.literal(8).describe("Video duration in seconds (always 8)"),
    startFramePath: z.string().describe("Path to start frame image"),
    endFramePath: z.string().describe("Path to end frame image"),
    outputDir: z.string().describe("Output directory for video file"),
    dryRun: z.boolean().optional().describe("Return placeholder without calling API"),
  }),
};

/**
 * ComfyUI backend: generates video via ComfyUI frame_to_video workflow.
 * Uses exponential backoff retry (5s, 10s, 20s, 40s, 80s).
 */
async function generateVideoComfy(params: GenerateVideoParams): Promise<GenerateVideoResult> {
  const {
    shotNumber,
    shotType,
    actionPrompt,
    dialogue,
    soundEffects,
    cameraDirection,
    durationSeconds,
    startFramePath,
    endFramePath,
    outputDir,
    dryRun = false,
    abortSignal,
    pendingJobStore,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const outputPath = join(outputDir, `shot_${String(shotNumber).padStart(3, "0")}.mp4`);

  // Dry-run mode: return placeholder
  if (dryRun) {
    console.log(`[generateVideo] DRY-RUN: Shot ${shotNumber} (${shotType}, ${durationSeconds}s)`);
    return { shotNumber, path: outputPath, duration: durationSeconds };
  }

  // Check for a pending job from a previous run
  const jobKey = `video-shot-${shotNumber}`;
  if (pendingJobStore) {
    const pending = pendingJobStore.get(jobKey);
    if (pending) {
      console.log(`[generateVideo] Found pending job ${pending.jobId} for shot ${shotNumber}, checking status...`);
      const status = await checkJob(pending.jobId);
      if (status && status.status === "completed" && status.outputAssetIds.length > 0) {
        console.log(`[generateVideo] Pending job ${pending.jobId} already completed, downloading...`);
        await downloadAsset(status.outputAssetIds[0], outputPath);
        await pendingJobStore.delete(jobKey);
        console.log(`[generateVideo] Shot ${shotNumber} saved to ${outputPath}`);
        return { shotNumber, path: outputPath, duration: durationSeconds };
      }
      // Job not completed or unreachable — clear and re-submit
      console.log(`[generateVideo] Pending job ${pending.jobId} not usable (status: ${status?.status ?? "unreachable"}), re-submitting...`);
      await pendingJobStore.delete(jobKey);
    }
  }

  // Build video prompt from components
  const promptParts: string[] = [];
  if (actionPrompt) promptParts.push(actionPrompt);
  if (dialogue) promptParts.push(`Character says: "${dialogue}"`);
  if (soundEffects) promptParts.push(`Sound effects: ${soundEffects}`);
  if (cameraDirection) promptParts.push(`Camera: ${cameraDirection}`);
  const videoPrompt = promptParts.join(". ");

  console.log(`[generateVideo] Generating shot ${shotNumber} (${shotType}, ${durationSeconds}s)`);
  console.log(`[generateVideo] Prompt: ${videoPrompt.substring(0, 100)}...`);

  try {
    const maxRetries = 5;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // First+last frame interpolation
        if (!startFramePath || !endFramePath) {
          throw new Error("first_last_frame requires both startFramePath and endFramePath");
        }

        // Upload start and end frames to ComfyUI
        console.log(`[generateVideo] Uploading start frame for shot ${shotNumber}`);
        const startAssetId = await uploadAsset(startFramePath);
        console.log(`[generateVideo] Start frame uploaded: ${startAssetId}`);

        console.log(`[generateVideo] Uploading end frame for shot ${shotNumber}`);
        const endAssetId = await uploadAsset(endFramePath);
        console.log(`[generateVideo] End frame uploaded: ${endAssetId}`);

        // Convert duration to frame count (fps=16)
        const length = 16 * durationSeconds;
        console.log(`[generateVideo] Duration: ${durationSeconds}s → ${length} frames (fps=16)`);

        // Run the frame_to_video workflow
        console.log(`[generateVideo] Running frame_to_video workflow for shot ${shotNumber}`);
        const jobId = await runWorkflow("frame_to_video", {
          prompt: videoPrompt,
          start_asset_id: startAssetId,
          end_asset_id: endAssetId,
          width: 640,
          height: 640,
          length,
          fps: 16,
        });
        console.log(`[generateVideo] Workflow started: job ${jobId}`);

        // Store pending job for resume capability
        if (pendingJobStore) {
          await pendingJobStore.set(jobKey, { jobId, outputPath });
        }

        // Poll for job completion
        console.log(`[generateVideo] Polling for completion (job: ${jobId})`);
        const result = await pollJob(jobId, abortSignal);

        if (result.status !== "completed") {
          throw new Error(`Job ${jobId} did not complete successfully: ${result.status}`);
        }

        if (!result.outputAssetIds || result.outputAssetIds.length === 0) {
          throw new Error(`No output assets returned for job ${jobId}`);
        }

        // Download the output video
        console.log(`[generateVideo] Downloading video for shot ${shotNumber}`);
        await downloadAsset(result.outputAssetIds[0], outputPath);

        // Clear pending job on success
        if (pendingJobStore) {
          await pendingJobStore.delete(jobKey);
        }

        console.log(`[generateVideo] Shot ${shotNumber} saved to ${outputPath}`);
        return { shotNumber, path: outputPath, duration: durationSeconds };
      } catch (error: any) {
        lastError = error;
        // Don't retry if cancelled due to pipeline interruption
        if (error?.message?.includes('cancelled due to pipeline interruption')) {
          throw error;
        }
        const backoffMs = Math.pow(2, attempt - 1) * 5000; // Exponential backoff: 5s, 10s, 20s, 40s, 80s
        if (attempt < maxRetries) {
          console.warn(`[generateVideo] Shot ${shotNumber}: Error on attempt ${attempt}/${maxRetries}. Retrying in ${backoffMs}ms...`);
          console.warn(`[generateVideo] Error details:`, error?.message || error);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        // Last attempt failed
        throw error;
      }
    }

    // All retries exhausted
    console.error(`[generateVideo] Shot ${shotNumber}: All ${maxRetries} retries exhausted`);
    throw lastError;
  } catch (error) {
    console.error(`[generateVideo] Error generating shot ${shotNumber}:`, error);
    throw error;
  }
}
