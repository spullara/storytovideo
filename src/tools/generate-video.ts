import { z } from "zod";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { getGoogleClient } from "../google-client";

/**
 * Generates video clips for shots using Veo 3.1 via @google/genai SDK.
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
  referenceImagePaths?: string[];
  outputDir: string;
  dryRun?: boolean;
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
        // Veo 3.1 supports 4, 6, or 8 second durations at 720p for interpolation.
        // Duration must be 8 for extension mode, reference images, or 1080p/4k.
        const config: Record<string, unknown> = {
          durationSeconds: durationSeconds,
          aspectRatio: "16:9",
        };

        console.log(`[generateVideo] Config: durationSeconds=${config.durationSeconds}, aspectRatio=${config.aspectRatio}`);

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
        return { shotNumber, path: outputPath, duration: durationSeconds };
      } catch (error: any) {
        lastError = error;
        // Check if it's a 429 rate limit error
        if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
          console.warn(`[generateVideo] Shot ${shotNumber}: Rate limited (429). Waiting 60s before retry ${attempt}/${maxRetries}...`);
          await new Promise((resolve) => setTimeout(resolve, 60000));
          continue;
        }
        // Non-429 error: don't retry
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
    "Generate video clips for shots using Veo 3.1. Uses first+last frame interpolation to generate each shot.",
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
    referenceImagePaths: z.array(z.string()).optional().describe("Paths to reference images (up to 3)"),
    outputDir: z.string().describe("Output directory for video file"),
    dryRun: z.boolean().optional().describe("Return placeholder without calling API"),
  }),
};

