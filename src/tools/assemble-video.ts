import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execFileAsync = promisify(execFile);

/**
 * Get the duration of a video file in seconds using ffprobe.
 */
async function getVideoDuration(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    return parseFloat(stdout.trim());
  } catch (error) {
    console.error(`Failed to get duration for ${videoPath}:`, error);
    throw error;
  }
}

/**
 * Map transition type to ffmpeg xfade transition name.
 */
function getXfadeTransitionName(transitionType: string): string {
  const mapping: Record<string, string> = {
    "fade_black": "fadeblack",
    "cross_dissolve": "dissolve",
    "fade_white": "fadewhite",
    "wipe_left": "wipeleft",
  };
  return mapping[transitionType] || "dissolve";
}

/**
 * Assembles multiple video clips into a single final video with optional scene transitions.
 * Uses ffmpeg xfade filter for transitions, or concat demuxer for all-cut videos.
 * Returns the path to the final assembled video.
 */
export async function assembleVideo(params: {
  videoPaths: string[];
  transitions?: Array<{ type: "cut" | "fade_black" | "cross_dissolve" | "fade_white" | "wipe_left"; durationMs: number }>;
  outputDir: string;
  outputFile?: string;
  dryRun?: boolean;
}): Promise<{ path: string }> {
  const {
    videoPaths,
    transitions = [],
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

  const outputPath = path.join(outputDir, outputFile);

  // Check if all transitions are "cut" (no xfade needed)
  const hasTransitions = transitions.length > 0 && transitions.some(t => t.type !== "cut");

  if (!hasTransitions) {
    // Use fast concat demuxer for all-cut videos
    return assembleWithConcat(videoPaths, outputPath);
  }

  // Use xfade filter for videos with transitions
  return assembleWithXfade(videoPaths, transitions, outputPath);
}

/**
 * Assemble videos using ffmpeg concat demuxer (fast, no re-encoding).
 */
async function assembleWithConcat(videoPaths: string[], outputPath: string): Promise<{ path: string }> {
  const concatListPath = path.join(path.dirname(outputPath), ".concat_list.txt");
  const concatContent = videoPaths
    .map((videoPath) => `file '${path.resolve(videoPath)}'`)
    .join("\n");

  fs.writeFileSync(concatListPath, concatContent);

  try {
    await execFileAsync("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      "-y",
      outputPath,
    ]);
    return { path: outputPath };
  } finally {
    try {
      fs.unlinkSync(concatListPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Assemble videos using ffmpeg xfade filter (requires re-encoding).
 */
async function assembleWithXfade(
  videoPaths: string[],
  transitions: Array<{ type: string; durationMs: number }>,
  outputPath: string,
): Promise<{ path: string }> {
  // Get durations for all videos
  const durations: number[] = [];
  for (const videoPath of videoPaths) {
    const duration = await getVideoDuration(videoPath);
    durations.push(duration);
  }

  // Build filter_complex string with chained xfade filters
  let filterComplex = "";
  const inputs: string[] = [];

  // Add input files
  for (const videoPath of videoPaths) {
    inputs.push("-i");
    inputs.push(videoPath);
  }

  // Build filter chain
  let cumulativeDuration = durations[0];
  let previousLabel = "0:v";

  for (let i = 1; i < videoPaths.length; i++) {
    const transition = transitions[i - 1] || { type: "cut", durationMs: 500 };
    const transitionDurationSec = transition.durationMs / 1000;

    if (transition.type === "cut") {
      // For cuts, just concatenate without xfade
      const nextLabel = `concat${i}`;
      filterComplex += `[${previousLabel}][${i}:v]concat=n=2:v=1:a=0[${nextLabel}];`;
      previousLabel = nextLabel;
      cumulativeDuration += durations[i];
    } else {
      // For transitions, use xfade
      const xfadeType = getXfadeTransitionName(transition.type);
      const offset = cumulativeDuration - transitionDurationSec;
      const xfadeLabel = `xfade${i}`;
      filterComplex += `[${previousLabel}][${i}:v]xfade=transition=${xfadeType}:duration=${transitionDurationSec}:offset=${offset}[${xfadeLabel}];`;
      previousLabel = xfadeLabel;
      cumulativeDuration += durations[i] - transitionDurationSec;
    }
  }

  // Remove trailing semicolon
  filterComplex = filterComplex.slice(0, -1);

  // Build ffmpeg command
  const ffmpegArgs = [
    ...inputs,
    "-filter_complex", filterComplex,
    "-map", `[${previousLabel}]`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-y",
    outputPath,
  ];

  await execFileAsync("ffmpeg", ffmpegArgs);
  return { path: outputPath };
}

/**
 * Vercel AI SDK tool definition for assembleVideo.
 * Claude calls this to assemble the final video from all shot clips.
 */
export const assembleVideoTool = {
  description: "Assemble multiple video clips into a single final video with optional scene transitions (fade, dissolve, etc.)",
  parameters: z.object({
    videoPaths: z.array(z.string()).describe("Ordered list of video clip paths"),
    transitions: z.array(z.object({
      type: z.enum(["cut", "fade_black", "cross_dissolve", "fade_white", "wipe_left"]).describe("Transition type"),
      durationMs: z.number().describe("Transition duration in milliseconds (typically 500-1000)")
    })).optional().describe("One transition per scene boundary. If omitted, all cuts."),
    outputDir: z.string().describe("Output directory for the final video"),
    outputFile: z.string().optional().describe("Output filename (default: final.mp4)"),
    dryRun: z.boolean().optional().describe("If true, return placeholder path without calling ffmpeg"),
  }),
};

