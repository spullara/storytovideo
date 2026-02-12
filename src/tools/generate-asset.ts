import { z } from "zod";
import { createImage, editImage } from "../reve-client";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates reference images for characters and locations using the Reve API.
 * Returns file path for the generated image.
 */
export async function generateAsset(params: {
  characterName?: string;
  locationName?: string;
  description: string;
  artStyle: string;
  outputDir: string;
  dryRun?: boolean;
  referenceImagePath?: string;
}): Promise<{ key: string; path: string }> {
  const {
    characterName,
    locationName,
    description,
    artStyle,
    outputDir,
    dryRun = false,
    referenceImagePath,
  } = params;

  // Determine asset type and key
  let assetType: "character" | "location";
  let assetName: string;
  let angleType: "front" | "angle" = "front";

  if (characterName) {
    assetType = "character";
    assetName = characterName;
    // If reference image provided, this is an angle shot
    if (referenceImagePath) {
      angleType = "angle";
    }
  } else if (locationName) {
    assetType = "location";
    assetName = locationName;
  } else {
    throw new Error("Either characterName or locationName must be provided");
  }

  const key = `${assetType}:${assetName}:${angleType}`;

  // Dry-run mode: return placeholder path
  if (dryRun) {
    const placeholder = `[dry-run] assets/${assetType}s/${assetName}_${angleType}.png`;
    return { key, path: placeholder };
  }

  // Build the prompt
  let prompt: string;
  let isEditing = false;

  // Check if reference image provided
  if (referenceImagePath && fs.existsSync(referenceImagePath)) {
    isEditing = true;

    // Image editing prompt for consistency
    if (assetType === "character") {
      prompt = `Edit this image to show the same character from a different angle/perspective. Keep their exact appearance, clothing, facial features, body proportions, and color palette identical. Only change the viewing angle to a 3/4 perspective. Character details: ${description}`;
    } else {
      prompt = `Edit this image to show the same location from a different vantage point. Keep the exact same architecture, lighting, color palette, and atmosphere. Location details: ${description}`;
    }
  } else {
    // Generate new image
    prompt = `Generate a ${artStyle} style reference image of `;
    if (assetType === "character") {
      prompt += `a character: ${description}`;
    } else {
      prompt += `a location: ${description}`;
    }
  }

  // Log the operation
  if (isEditing) {
    console.log(`[generateAsset] Editing reference image for ${assetType}: ${assetName} (${angleType})`);
  } else {
    console.log(`[generateAsset] Generating new ${assetType}: ${assetName}`);
  }

  // Call Reve API with retry logic
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Ensure output directory exists
      const assetDir = path.join(outputDir, "assets", `${assetType}s`);
      fs.mkdirSync(assetDir, { recursive: true });

      // Save image
      const filename = `${assetName.toLowerCase()}_${angleType}.png`;
      const filePath = path.join(assetDir, filename);

      let resultPath: string;

      if (isEditing) {
        // Image edit via Reve API
        resultPath = await editImage(referenceImagePath!, prompt, { outputPath: filePath });
      } else {
        // Text to image via Reve API
        resultPath = await createImage(prompt, { aspectRatio: "1:1", outputPath: filePath });
      }

      return { key, path: resultPath };
    } catch (error) {
      lastError = error as Error;
      // Don't retry if cancelled due to pipeline interruption
      if ((error as Error)?.message?.includes('cancelled due to pipeline interruption')) {
        throw error;
      }
      if (attempt < 3) {
        // Wait before retry
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw new Error(
    `Failed to generate asset after 3 attempts: ${lastError?.message}`
  );
}

/**
 * Vercel AI SDK tool definition for generateAsset.
 * Claude calls this to generate character and location reference images.
 * When a referenceImagePath is provided, uses image editing to create variations
 * while maintaining exact consistency with the reference image.
 */
export const generateAssetTool = {
  description:
    "Generate reference images for characters and locations using the Reve API. When referenceImagePath is provided, edits the reference image to create variations (e.g., different angles) while maintaining exact consistency in appearance, clothing, features, and color palette.",
  parameters: z.object({
    characterName: z.string().optional(),
    locationName: z.string().optional(),
    description: z.string(),
    artStyle: z.string(),
    outputDir: z.string(),
    dryRun: z.boolean().optional(),
    referenceImagePath: z.string().optional(),
  }),
};

