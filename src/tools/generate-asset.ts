import { z } from "zod";
import { getGoogleClient } from "../google-client";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates reference images for characters and locations using Nano Banana (gemini-2.5-flash-image).
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
  let prompt = `Generate a ${artStyle} style reference image of `;
  if (assetType === "character") {
    prompt += `a character: ${description}`;
  } else {
    prompt += `a location: ${description}`;
  }

  // Prepare image input parts if reference image provided
  const imageParts: any[] = [];
  if (referenceImagePath && fs.existsSync(referenceImagePath)) {
    const imageData = fs.readFileSync(referenceImagePath);
    const base64Image = imageData.toString("base64");
    imageParts.push({
      inlineData: {
        mimeType: "image/png",
        data: base64Image,
      },
    });
    prompt += " (angle shot, maintain consistency with the reference image provided)";
  }

  // Call Nano Banana API with retry logic
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const client = getGoogleClient();
      const response = await client.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, ...imageParts],
          },
        ],
        config: {
          responseModalities: ["Image"],
        } as any,
      });

      // Extract image from response
      if (
        response.candidates &&
        response.candidates[0] &&
        response.candidates[0].content &&
        response.candidates[0].content.parts
      ) {
        const imagePart = response.candidates[0].content.parts.find(
          (part: any) => part.inlineData
        );
        if (imagePart && imagePart.inlineData && imagePart.inlineData.data) {
          const imageData = imagePart.inlineData.data;
          const imageBuffer = typeof imageData === "string"
            ? Buffer.from(imageData, "base64")
            : Buffer.from(imageData);

          // Ensure output directory exists
          const assetDir = path.join(outputDir, "assets", `${assetType}s`);
          fs.mkdirSync(assetDir, { recursive: true });

          // Save image
          const filename = `${assetName.toLowerCase()}_${angleType}.png`;
          const filePath = path.join(assetDir, filename);
          fs.writeFileSync(filePath, imageBuffer);

          return { key, path: filePath };
        }
      }

      throw new Error("No image data in response");
    } catch (error) {
      lastError = error as Error;
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
 */
export const generateAssetTool = {
  description:
    "Generate reference images for characters and locations using Nano Banana (gemini-2.5-flash-image)",
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

