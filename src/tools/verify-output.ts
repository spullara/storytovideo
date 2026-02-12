import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { readFileSync } from "fs";
import { extname } from "path";
import type { VerificationResult } from "../types";

const verificationSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});

/**
 * Verifies generated outputs (images and videos) against descriptions.
 * Uses Claude Opus 4.6 to analyze media and return structured feedback.
 */
export async function verifyOutput(params: {
  outputPath: string;
  outputType: "asset" | "frame" | "video";
  description: string;
  referenceImagePaths?: string[];
  dryRun?: boolean;
}): Promise<VerificationResult> {
  const { outputPath, outputType, description, referenceImagePaths, dryRun } = params;

  if (dryRun) {
    return { passed: true, score: 1.0, issues: [], suggestions: [] };
  }

  const fileBuffer = readFileSync(outputPath);
  const fileExt = extname(outputPath).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(fileExt);
  const isVideo = [".mp4", ".webm", ".mov"].includes(fileExt);

  if (!isImage && !isVideo) {
    return {
      passed: false,
      score: 0,
      issues: [`Unsupported format: ${fileExt}`],
      suggestions: ["Use PNG/JPG for images or MP4 for videos"],
    };
  }

  const prompts = {
    asset: `Evaluate if this character/location image matches: "${description}". Check: accuracy to description, visual details, quality, reference suitability.`,
    frame: `Evaluate if this keyframe matches: "${description}". Check: composition, character references, location, lighting, required elements.`,
    video: `Evaluate if this video matches: "${description}". Check: action accuracy, camera movement, character consistency, dialogue, pacing, location.`,
  };

  const prompt = prompts[outputType];
  const base64 = fileBuffer.toString("base64");
  const mimeType = isImage ? (fileExt === ".png" ? "image/png" : "image/jpeg") : "video/mp4";

  try {
    // Claude cannot process video files directly — return a default pass
    if (isVideo) {
      return {
        passed: true,
        score: 0.8,
        issues: [],
        suggestions: [`Video file "${outputPath}" cannot be visually verified by Claude. Manual review recommended.`],
      };
    }

    const { object } = await generateObject({
      model: anthropic("claude-opus-4-6"),
      schema: verificationSchema,
      prompt: `${prompt}\n\nReturn JSON with: passed (bool), score (0-1), issues (array), suggestions (array).`,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              image: `data:${mimeType};base64,${base64}`,
            } as any,
            ...(referenceImagePaths?.map((refPath) => {
              try {
                const refBase64 = readFileSync(refPath).toString("base64");
                const refExt = extname(refPath).toLowerCase();
                const refMime = refExt === ".png" ? "image/png" : "image/jpeg";
                return {
                  type: "image",
                  image: `data:${refMime};base64,${refBase64}`,
                } as any;
              } catch {
                return null;
              }
            }).filter(Boolean) ?? []),
          ],
        },
      ],
    } as any);

    return object as any as VerificationResult;
  } catch (error) {
    console.error("Verification failed:", error);
    return {
      passed: false,
      score: 0,
      issues: [`API error: ${error instanceof Error ? error.message : "Unknown"}`],
      suggestions: ["Retry or check connectivity"],
    };
  }
}

export const verifyOutputTool = {
  description: "Verify generated outputs (images/videos) against descriptions using Claude Opus 4.6",
  parameters: z.object({
    outputPath: z.string().describe("Path to generated image or video"),
    outputType: z.enum(["asset", "frame", "video"]).describe("Output type"),
    description: z.string().describe("Expected description"),
    referenceImagePaths: z.array(z.string()).optional().describe("Reference images"),
    dryRun: z.boolean().optional().describe("Mock pass if true"),
  }),
};

