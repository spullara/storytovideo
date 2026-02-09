import { z } from "zod";
import { getGoogleClient } from "../google-client";
import type { Shot, AssetLibrary } from "../types";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates start/end keyframe images for shots using Nano Banana (gemini-2.5-flash-image).
 * For first_last_frame shots: generates both start and end frames.
 * For extension shots: returns immediately (no frames needed).
 */
export async function generateFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  outputDir: string;
  dryRun?: boolean;
}): Promise<{ shotNumber: number; startPath?: string; endPath?: string }> {
  const { shot, artStyle, assetLibrary, outputDir, dryRun = false } = params;

  // Extension shots don't need frames
  if (shot.shotType === "extension") {
    return { shotNumber: shot.shotNumber };
  }

  // Only first_last_frame shots need frame generation
  if (shot.shotType !== "first_last_frame") {
    return { shotNumber: shot.shotNumber };
  }

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

  try {
    // Generate start frame
    const startFramePath = await generateSingleFrame({
      shot,
      artStyle,
      assetLibrary,
      isEndFrame: false,
      previousStartFramePath: undefined,
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
 * Generates a single frame (start or end) with reference images.
 */
async function generateSingleFrame(params: {
  shot: Shot;
  artStyle: string;
  assetLibrary: AssetLibrary;
  isEndFrame: boolean;
  previousStartFramePath?: string;
  outputPath: string;
}): Promise<string> {
  const {
    shot,
    artStyle,
    assetLibrary,
    isEndFrame,
    previousStartFramePath,
    outputPath,
  } = params;

  const client = getGoogleClient();

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

  // Collect reference images
  const imageParts: Array<{ inlineData: { mimeType: string; data: string } }> =
    [];

  // Add location reference image if available
  const locationRef = assetLibrary.locationImages[shot.location];
  if (locationRef && fs.existsSync(locationRef)) {
    const locationData = fs.readFileSync(locationRef, "base64");
    imageParts.push({
      inlineData: { mimeType: "image/png", data: locationData },
    });
  }

  // Add character reference images (up to 2)
  for (let i = 0; i < Math.min(shot.charactersPresent.length, 2); i++) {
    const charName = shot.charactersPresent[i];
    const charRefs = assetLibrary.characterImages[charName];
    if (charRefs) {
      // Prefer front angle, fall back to angle
      const refPath = charRefs.front || charRefs.angle;
      if (refPath && fs.existsSync(refPath)) {
        const charData = fs.readFileSync(refPath, "base64");
        imageParts.push({
          inlineData: { mimeType: "image/png", data: charData },
        });
      }
    }
  }

  // For end frame, add the start frame as additional input for visual continuity
  if (isEndFrame && previousStartFramePath && fs.existsSync(previousStartFramePath)) {
    const startFrameData = fs.readFileSync(previousStartFramePath, "base64");
    imageParts.push({
      inlineData: { mimeType: "image/png", data: startFrameData },
    });
  }

  // Build the request
  const contents = [
    {
      role: "user" as const,
      parts: [
        { text: prompt },
        ...imageParts,
      ],
    },
  ];

  // Call Nano Banana API
  const response = await client.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents,
    config: {
      responseModalities: ["Image"],
    } as any,
  });

  // Extract the generated image from response
  if (!response.candidates || response.candidates.length === 0) {
    throw new Error("No candidates in response from Nano Banana API");
  }

  const candidate = response.candidates[0];
  if (!candidate.content || !candidate.content.parts) {
    throw new Error("No content parts in response candidate");
  }

  // Find the image part
  const imagePart = candidate.content.parts.find(
    (part: any) => part.inlineData && part.inlineData.mimeType === "image/png"
  );

  if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
    throw new Error("No image data in response");
  }

  // Save the image to disk
  const imageData = imagePart.inlineData.data;
  const imageBuffer = typeof imageData === "string"
    ? Buffer.from(imageData, "base64")
    : Buffer.from(imageData as any);
  fs.writeFileSync(outputPath, imageBuffer);

  return outputPath;
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

Aspect ratio: 16:9`;
}

/**
 * Zod-based tool definition for Claude to call generateFrame.
 */
export const generateFrameTool = {
  description:
    "Generate start and end keyframe images for a shot using Nano Banana (gemini-2.5-flash-image). For first_last_frame shots, generates both frames. For extension shots, returns immediately without generating frames.",
  parameters: z.object({
    shot: z.object({
      shotNumber: z.number(),
      sceneNumber: z.number(),
      shotInScene: z.number(),
      durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]),
      shotType: z.enum(["first_last_frame", "extension"]),
      composition: z.string(),
      startFramePrompt: z.string(),
      endFramePrompt: z.string(),
      actionPrompt: z.string(),
      dialogue: z.string(),
      soundEffects: z.string(),
      cameraDirection: z.string(),
      charactersPresent: z.array(z.string()),
      location: z.string(),
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
  }),
};

