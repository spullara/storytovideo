import { z } from "zod";
import { createImage, remixImage } from "../reve-client";
import type { Shot, AssetLibrary } from "../types";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates start/end keyframe images for shots using the Reve API.
 * For first_last_frame shots: generates both start and end frames.
 * For extension shots: returns immediately (no frames needed).
 */
export async function generateFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  outputDir: string;
  dryRun?: boolean;
  previousEndFramePath?: string;
}): Promise<{ shotNumber: number; startPath?: string; endPath?: string }> {
  const { shot, artStyle, assetLibrary, outputDir, dryRun = false, previousEndFramePath } = params;

  // Create frames directory if it doesn't exist
  const framesDir = path.join(outputDir, "frames");
  if (!dryRun && !fs.existsSync(framesDir)) {
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const startPath = path.join(framesDir, `shot_${shot.shotNumber}_start.png`);
  const endPath = path.join(framesDir, `shot_${shot.shotNumber}_end.png`);

  if (dryRun) {
    // Return placeholder paths without calling API
    return {
      shotNumber: shot.shotNumber,
      startPath,
      endPath,
    };
  }

  // Hard continuity: copy previous shot's end frame as this shot's start frame
  if (shot.continuousFromPrevious && previousEndFramePath && fs.existsSync(previousEndFramePath)) {
    console.log(`[generateFrame] Shot ${shot.shotNumber}: copying previous end frame for continuity`);
    fs.copyFileSync(previousEndFramePath, startPath);

    // Generate only the end frame
    const endFramePath = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      isEndFrame: true,
      previousStartFramePath: startPath,  // use the copied start frame as reference for end frame
      outputPath: endPath,
    });

    return {
      shotNumber: shot.shotNumber,
      startPath,
      endPath: endFramePath,
    };
  }

  try {
    // Generate start frame
    const startFramePath = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      isEndFrame: false,
      previousStartFramePath: undefined,
      previousEndFramePath,
      outputPath: startPath,
    });

    // Generate end frame (with start frame as additional input for continuity)
    const endFramePath = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      isEndFrame: true,
      previousStartFramePath: startFramePath,
      outputPath: endPath,
    });

    return {
      shotNumber: shot.shotNumber,
      startPath: startFramePath,
      endPath: endFramePath,
    };
  } catch (error) {
    throw new Error(
      `Failed to generate frames for shot ${shot.shotNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Generates a single frame (start or end) with reference images using the Reve API.
 */
async function generateSingleFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  isEndFrame: boolean;
  previousStartFramePath?: string;
  previousEndFramePath?: string;
  outputPath: string;
}): Promise<string> {
  const {
    shot,
    artStyle,
    assetLibrary,
    isEndFrame,
    previousStartFramePath,
    previousEndFramePath,
    outputPath,
  } = params;

  // Build the prompt
  const framePrompt = isEndFrame ? shot.endFramePrompt : shot.startFramePrompt;
  const prompt = buildFramePrompt({
    artStyle,
    composition: shot.composition,
    locationDescription: shot.location,
    charactersPresent: shot.charactersPresent,
    framePrompt,
    cameraDirection: shot.cameraDirection,
  });

  // Collect reference image file paths (priority: location > character > continuity)
  const referenceImagePaths: string[] = [];

  // Add location reference image if available (priority 1)
  const locationRef = assetLibrary.locationImages[shot.location];
  if (locationRef && fs.existsSync(locationRef)) {
    referenceImagePaths.push(locationRef);
  }

  // Add first character reference image if available (priority 2)
  if (shot.charactersPresent.length > 0) {
    const charName = shot.charactersPresent[0];
    const charRefs = assetLibrary.characterImages[charName];
    if (charRefs) {
      // Prefer front angle, fall back to angle
      const refPath = charRefs.front || charRefs.angle;
      if (refPath && fs.existsSync(refPath)) {
        referenceImagePaths.push(refPath);
      }
    }
  }

  // Add continuity frame if available (priority 3)
  // For start frame, add the previous shot's end frame for cross-shot continuity
  if (!isEndFrame && previousEndFramePath && fs.existsSync(previousEndFramePath)) {
    referenceImagePaths.push(previousEndFramePath);
  }

  // For end frame, add the start frame as additional input for visual continuity
  if (isEndFrame && previousStartFramePath && fs.existsSync(previousStartFramePath)) {
    referenceImagePaths.push(previousStartFramePath);
  }

  // Limit to max 4 reference images (Reve supports up to 4)
  const limitedReferencePaths = referenceImagePaths.slice(0, 4);

  if (limitedReferencePaths.length > 0) {
    // Build <img> tag prefix to reference images by index
    const imgTagParts: string[] = [];
    for (let i = 0; i < limitedReferencePaths.length; i++) {
      const refPath = limitedReferencePaths[i];
      if (refPath === locationRef) {
        imgTagParts.push(`<img>${i}</img> as location reference`);
      } else if (shot.charactersPresent.length > 0 && refPath === (assetLibrary.characterImages[shot.charactersPresent[0]]?.front || assetLibrary.characterImages[shot.charactersPresent[0]]?.angle)) {
        imgTagParts.push(`<img>${i}</img> as character reference`);
      } else {
        imgTagParts.push(`<img>${i}</img> as continuity reference`);
      }
    }
    const imgPrefix = `Using ${imgTagParts.join(", ")}: `;
    const remixPrompt = imgPrefix + prompt;

    return await remixImage(remixPrompt, limitedReferencePaths, {
      aspectRatio: "1:1",
      outputPath,
    });
  } else {
    // No reference images — use text-to-image generation
    return await createImage(prompt, {
      aspectRatio: "1:1",
      outputPath,
    });
  }
}

/**
 * Builds a detailed prompt for frame generation.
 */
function buildFramePrompt(params: {
  artStyle: string;
  composition: string;
  locationDescription: string;
  charactersPresent: string[];
  framePrompt: string;
  cameraDirection: string;
}): string {
  const {
    artStyle,
    composition,
    locationDescription,
    charactersPresent,
    framePrompt,
    cameraDirection,
  } = params;

  return `You are a professional cinematographer generating a keyframe image for a film scene.

Art Style: ${artStyle}
Composition Type: ${composition}
Location: ${locationDescription}
Characters: ${charactersPresent.join(", ")}
Camera Direction: ${cameraDirection}

Frame Description: ${framePrompt}

Generate a high-quality, cinematic image that:
1. Matches the specified composition type exactly
2. Reflects the art style consistently
3. Shows the location and characters as described
4. Follows the camera direction and framing
5. Is suitable as a keyframe for video generation
6. Maintains visual continuity with reference images provided
7. CRITICAL: If a reference image of the previous shot's end frame is provided, your start frame must visually match that moment — same characters, positions, lighting, and setting. The camera angle/composition may change, but the scene content must be continuous.

Aspect ratio: 1:1`;
}

/**
 * Zod-based tool definition for Claude to call generateFrame.
 */
export const generateFrameTool = {
  description:
    "Generate start and end keyframe images for a shot using the Reve API.",
  parameters: z.object({
    shot: z.object({
      shotNumber: z.number(),
      sceneNumber: z.number(),
      shotInScene: z.number(),
      durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]),
      shotType: z.literal("first_last_frame"),
      composition: z.string(),
      startFramePrompt: z.string(),
      endFramePrompt: z.string(),
      actionPrompt: z.string(),
      dialogue: z.string(),
      soundEffects: z.string(),
      cameraDirection: z.string(),
      charactersPresent: z.array(z.string()),
      location: z.string(),
      continuousFromPrevious: z.boolean(),
    }).describe("The shot to generate keyframes for"),
    artStyle: z.string().describe("The visual art style for the entire video"),
    assetLibrary: z.object({
      characterImages: z.record(z.string(), z.object({ front: z.string(), angle: z.string() })),
      locationImages: z.record(z.string(), z.string()),
    }).describe("AssetLibrary with character and location reference image paths"),
    outputDir: z.string().describe("Output directory for saving frame images"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, return placeholder paths without calling API"),
    previousEndFramePath: z
      .string()
      .optional()
      .describe("Path to the previous shot's end frame image for cross-shot visual continuity"),
  }),
};

