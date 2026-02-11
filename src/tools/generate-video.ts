import { z } from "zod";
import { mkdir } from "fs/promises";
import { join } from "path";
import { uploadAsset, runWorkflow, pollJob, downloadAsset, checkJob } from "../comfy-client";

/**
 * Generates video clips for shots using ComfyUI frame_to_video workflow.
 * Uses first+last frame interpolation to generate each shot.
 */
export async function generateVideo(params: {
  shotNumber: number;
  shotType: "first_last_frame";
  actionPrompt: string;
  dialogue: string;
  soundEffects: string;
  cameraDirection: string;
  durationSeconds: 4 | 6 | 8;
  startFramePath: string;
  endFramePath: string;
  outputDir: string;
  dryRun?: boolean;
  pendingJobStore?: {
    get: (key: string) => { jobId: string; outputPath: string } | undefined;
    set: (key: string, value: { jobId: string; outputPath: string }) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
}): Promise<{ shotNumber: number; path: string; duration: number }> {
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
    pendingJobStore,
  } = params;

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  const outputPath = join(outputDir, `shot_${String(shotNumber).padStart(3, "0")}.mp4`);

  // Check for a pending job from a previous run
  const pendingKey = `video:${shotNumber}`;
  if (pendingJobStore) {
    const pending = pendingJobStore.get(pendingKey);
    if (pending) {
      console.log(`[generateVideo] Found pending job ${pending.jobId} for shot ${shotNumber}, checking status...`);
      const check = await checkJob(pending.jobId);
      if (check?.status === 'completed' && check.outputAssetIds.length > 0) {
        console.log(`[generateVideo] Pending job completed! Downloading result...`);
        await downloadAsset(check.outputAssetIds[0], pending.outputPath);
        await pendingJobStore.delete(pendingKey);
        console.log(`[generateVideo] Shot ${shotNumber} recovered from pending job`);
        return { shotNumber, path: pending.outputPath, duration: durationSeconds };
      }
      console.log(`[generateVideo] Pending job status: ${check?.status ?? 'unknown'}, starting fresh`);
      await pendingJobStore.delete(pendingKey);
    }
  }

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
        const length = 16 * durationSeconds + 1;
        console.log(`[generateVideo] Duration: ${durationSeconds}s → ${length} frames (16*${durationSeconds}+1, fps=16)`);

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

        // Persist job ID so it can be recovered after restart
        if (pendingJobStore) {
          await pendingJobStore.set(pendingKey, { jobId, outputPath });
        }

        // Poll for job completion
        console.log(`[generateVideo] Polling for completion (job: ${jobId})`);
        const result = await pollJob(jobId);

        if (result.status !== "completed") {
          throw new Error(`Job ${jobId} did not complete successfully: ${result.status}`);
        }

        if (!result.outputAssetIds || result.outputAssetIds.length === 0) {
          throw new Error(`No output assets returned for job ${jobId}`);
        }

        // Download the output video
        console.log(`[generateVideo] Downloading video for shot ${shotNumber}`);
        await downloadAsset(result.outputAssetIds[0], outputPath);

        // Clean up pending job entry
        if (pendingJobStore) {
          await pendingJobStore.delete(pendingKey);
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

/**
 * Vercel AI SDK tool definition for generateVideo.
 * Claude calls this to generate video clips for shots.
 */
export const generateVideoTool = {
  description:
    "Generate video clips for shots using ComfyUI frame_to_video. Uses first+last frame interpolation to generate each shot.",
  parameters: z.object({
    shotNumber: z.number().describe("Global shot number"),
    shotType: z.literal("first_last_frame").describe("Video generation mode"),
    actionPrompt: z.string().describe("Action description for the shot"),
    dialogue: z.string().describe("Character dialogue (empty if none)"),
    soundEffects: z.string().describe("Sound effects description"),
    cameraDirection: z.string().describe("Camera movement and angle"),
    durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).describe("Video duration in seconds"),
    startFramePath: z.string().describe("Path to start frame image"),
    endFramePath: z.string().describe("Path to end frame image"),
    outputDir: z.string().describe("Output directory for video file"),
    dryRun: z.boolean().optional().describe("Return placeholder without calling API"),
  }),
};

