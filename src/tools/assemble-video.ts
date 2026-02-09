import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileAsync = promisify(execFile);

/**
 * Assembles multiple video clips into a single final video using ffmpeg concat demuxer.
 * Returns the path to the final assembled video.
 */
export async function assembleVideo(params: {
  videoPaths: string[];
  outputDir: string;
  outputFile?: string;
  dryRun?: boolean;
}): Promise<{ path: string }> {
  const {
    videoPaths,
    outputDir,
    outputFile = "final.mp4",
    dryRun = false,
  } = params;

  if (!videoPaths || videoPaths.length === 0) {
    throw new Error("No video paths provided for assembly");
  }

  // Dry-run mode: return mock path without calling ffmpeg
  if (dryRun) {
    const mockPath = path.join(outputDir, outputFile);
    console.log(`[dry-run] Would assemble ${videoPaths.length} videos into ${mockPath}`);
    return { path: mockPath };
  }

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Create temporary concat list file
  const concatListPath = path.join(outputDir, ".concat_list.txt");
  const concatContent = videoPaths
    .map((videoPath) => `file '${path.resolve(videoPath)}'`)
    .join("\n");

  fs.writeFileSync(concatListPath, concatContent);

  try {
    const outputPath = path.join(outputDir, outputFile);

    // Run ffmpeg with concat demuxer
    await execFileAsync("ffmpeg", [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      "-y",
      outputPath,
    ]);

    return { path: outputPath };
  } finally {
    // Clean up temporary concat list file
    try {
      fs.unlinkSync(concatListPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Vercel AI SDK tool definition for assembleVideo.
 * Claude calls this to assemble the final video from all shot clips.
 */
export const assembleVideoTool = {
  description:
    "Assemble multiple video clips into a single final video using ffmpeg concat demuxer",
  parameters: z.object({
    videoPaths: z.array(z.string()),
    outputDir: z.string(),
    outputFile: z.string().optional(),
    dryRun: z.boolean().optional(),
  }),
};

