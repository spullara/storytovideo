import { z } from "zod";
import { mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { getGoogleClient } from "../google-client";

/**
 * Generates video clips for shots using Veo 3.1 via @google/genai SDK.
 * Supports two modes:
 * 1. first_last_frame: Interpolates between start and end frame images
 * 2. extension: Extends previous video with seamless continuation
 */
export async function generateVideo(params: {
  shotNumber: number;
  shotType: "first_last_frame" | "extension";
  actionPrompt: string;
  dialogue: string;
  soundEffects: string;
  cameraDirection: string;
  durationSeconds: 4 | 6 | 8;
  startFramePath?: string;
  endFramePath?: string;
  previousVideoPath?: string;
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
    previousVideoPath,
    referenceImagePaths,
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

    // Build parameters based on shot type
    let operation;

    if (shotType === "first_last_frame") {
      // Mode 1: First+last frame interpolation
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

      // Build config with optional reference images
      // Note: Interpolation requires durationSeconds: 8 for 1080p+ per API docs
      const config: Record<string, unknown> = {
        durationSeconds: 8,
        aspectRatio: "16:9",
      };

      if (referenceImagePaths && referenceImagePaths.length > 0) {
        const refImages = referenceImagePaths.slice(0, 3).map((path) => {
          const buffer = readFileSync(path);
          return {
            image: {
              imageBytes: buffer.toString("base64"),
              mimeType: "image/png",
            },
            referenceType: "STYLE",
          };
        });
        config.referenceImages = refImages;
      }

      console.log(`[generateVideo] Config: ${JSON.stringify(config)}`);

      operation = await client.models.generateVideos({
        model: "veo-3.1-generate-preview",
        prompt: videoPrompt,
        image: startImage,
        config: {
          ...config,
          lastFrame: endImage,
        } as any,
      });
    } else {
      // Mode 2: Scene extension
      if (!previousVideoPath) {
        throw new Error("extension requires previousVideoPath");
      }

      // Load video as base64
      const videoBuffer = readFileSync(previousVideoPath);
      const previousVideo = {
        videoBytes: videoBuffer.toString("base64"),
        mimeType: "video/mp4",
      };

      operation = await client.models.generateVideos({
        model: "veo-3.1-generate-preview",
        prompt: videoPrompt,
        video: previousVideo,
        config: {
          durationSeconds: 8,
          resolution: "720p",
        } as any,
      });
    }

    // Poll for operation completion
    console.log(`[generateVideo] Polling for completion (operation: ${operation.name})`);

    while (!operation.done) {
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between polls
      operation = await client.operations.getVideosOperation({ operation });
    }

    // Extract generated video from response
    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (!generatedVideo?.video) {
      throw new Error(`No video in response for shot ${shotNumber}`);
    }

    // Download the video to disk
    console.log(`[generateVideo] Downloading video for shot ${shotNumber}`);
    await client.files.download({
      file: generatedVideo.video,
      downloadPath: outputPath,
    });

    console.log(`[generateVideo] Shot ${shotNumber} saved to ${outputPath}`);
    return { shotNumber, path: outputPath, duration: durationSeconds };
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
    "Generate video clips for shots using Veo 3.1. Supports first+last frame interpolation or scene extension.",
  parameters: z.object({
    shotNumber: z.number().describe("Global shot number"),
    shotType: z.enum(["first_last_frame", "extension"]).describe("Video generation mode"),
    actionPrompt: z.string().describe("Action description for the shot"),
    dialogue: z.string().describe("Character dialogue (empty if none)"),
    soundEffects: z.string().describe("Sound effects description"),
    cameraDirection: z.string().describe("Camera movement and angle"),
    durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).describe("Video duration in seconds"),
    startFramePath: z.string().optional().describe("Path to start frame image (first_last_frame only)"),
    endFramePath: z.string().optional().describe("Path to end frame image (first_last_frame only)"),
    previousVideoPath: z.string().optional().describe("Path to previous video (extension only)"),
    referenceImagePaths: z.array(z.string()).optional().describe("Paths to reference images (up to 3)"),
    outputDir: z.string().describe("Output directory for video file"),
    dryRun: z.boolean().optional().describe("Return placeholder without calling API"),
  }),
};

