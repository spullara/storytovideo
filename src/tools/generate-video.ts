import { z } from "zod";
import { mkdir, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";

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
    // Build request payload based on shot type
    const requestPayload: Record<string, unknown> = {
      model: "veo-3.1-generate-preview",
      prompt: videoPrompt,
    };

    if (shotType === "first_last_frame") {
      // Mode 1: First+last frame interpolation
      if (!startFramePath || !endFramePath) {
        throw new Error("first_last_frame requires both startFramePath and endFramePath");
      }

      const startImageBuffer = readFileSync(startFramePath);
      const startImage = {
        image: { imageBytes: startImageBuffer.toString("base64"), mimeType: "image/png" },
      };

      const endImageBuffer = readFileSync(endFramePath);
      const endImage = {
        image: { imageBytes: endImageBuffer.toString("base64"), mimeType: "image/png" },
      };

      requestPayload.image = startImage;

      // Build config with optional reference images
      const config: Record<string, unknown> = {
        lastFrame: endImage,
        numberOfVideos: 1,
        durationSeconds,
        aspectRatio: "16:9",
      };

      if (referenceImagePaths && referenceImagePaths.length > 0) {
        const refImages = referenceImagePaths.slice(0, 3).map((path) => {
          const buffer = readFileSync(path);
          return { image: { imageBytes: buffer.toString("base64"), mimeType: "image/png" } };
        });
        config.referenceImages = refImages;
      }

      requestPayload.config = config;
    } else {
      // Mode 2: Scene extension
      if (!previousVideoPath) {
        throw new Error("extension requires previousVideoPath");
      }

      const videoBuffer = readFileSync(previousVideoPath);
      const video = {
        video: { videoBytes: videoBuffer.toString("base64"), mimeType: "video/mp4" },
      };

      requestPayload.video = video;
      requestPayload.config = { numberOfVideos: 1 };
    }

    // Call Veo 3.1 API
    console.log(`[generateVideo] Calling Veo 3.1 API for shot ${shotNumber}`);
    console.log(`[generateVideo] Request type: ${shotType}`);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is not set");
    }

    // Call Veo 3.1 API via REST endpoint (generateVideos is a long-running operation)
    const apiUrl = "https://generativelanguage.googleapis.com/v1alpha/models/veo-3.1-generate-preview:generateVideos";

    const generateResponse = await fetch(`${apiUrl}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });

    if (!generateResponse.ok) {
      throw new Error(`Veo 3.1 API error: ${generateResponse.statusText}`);
    }

    const operationData = await generateResponse.json() as any;
    let operationName = operationData.name;

    if (!operationName) {
      throw new Error("No operation name in Veo 3.1 response");
    }

    // Poll for operation completion
    console.log(`[generateVideo] Polling for completion (operation: ${operationName})`);
    const operationsUrl = `https://generativelanguage.googleapis.com/v1alpha/${operationName}`;
    let operation = operationData;

    while (!operation.done) {
      await new Promise((resolve) => setTimeout(resolve, 10000)); // Wait 10 seconds between polls
      const pollResponse = await fetch(`${operationsUrl}?key=${apiKey}`);
      if (!pollResponse.ok) {
        throw new Error(`Failed to poll operation: ${pollResponse.statusText}`);
      }
      operation = await pollResponse.json();
    }

    // Extract generated video from response
    const video = operation.response?.generatedVideos?.[0];
    if (!video?.video?.uri) {
      throw new Error(`No video URI in response for shot ${shotNumber}`);
    }

    // Download the video from the URI
    console.log(`[generateVideo] Downloading video from ${video.video.uri}`);
    const response = await fetch(video.video.uri);
    if (!response.ok) {
      throw new Error(`Failed to download video: ${response.statusText}`);
    }

    const videoBuffer = Buffer.from(await response.arrayBuffer());
    await writeFile(outputPath, videoBuffer);

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

