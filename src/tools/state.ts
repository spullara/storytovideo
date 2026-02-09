import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type { PipelineState } from "../types";

/**
 * Saves the pipeline state to a JSON file and creates the output directory structure.
 * Also saves a human-readable story_analysis.json if analysis is available.
 */
export async function saveState(params: {
  state: PipelineState;
}): Promise<{ saved: boolean; path: string }> {
  const { state } = params;

  // Ensure output directory structure exists
  const outputDir = state.outputDir;
  const dirs = [
    outputDir,
    path.join(outputDir, "assets", "characters"),
    path.join(outputDir, "assets", "locations"),
    path.join(outputDir, "frames"),
    path.join(outputDir, "videos"),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Save pipeline state
  const statePath = path.join(outputDir, "pipeline_state.json");
  const stateWithTimestamp = {
    ...state,
    lastSavedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, JSON.stringify(stateWithTimestamp, null, 2));

  // Save human-readable story analysis if available
  if (state.storyAnalysis) {
    const analysisPath = path.join(outputDir, "story_analysis.json");
    fs.writeFileSync(
      analysisPath,
      JSON.stringify(state.storyAnalysis, null, 2)
    );
  }

  return { saved: true, path: statePath };
}

/**
 * Loads the pipeline state from a saved JSON file.
 * Returns null if the file doesn't exist.
 */
export function loadState(outputDir: string): PipelineState | null {
  const statePath = path.join(outputDir, "pipeline_state.json");

  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(statePath, "utf-8");
    return JSON.parse(content) as PipelineState;
  } catch (error) {
    console.error(`Failed to load state from ${statePath}:`, error);
    return null;
  }
}

/**
 * Vercel AI SDK tool definition for saveState.
 * Claude calls this to checkpoint the pipeline state.
 */
export const saveStateTool = {
  description:
    "Save the pipeline state to a JSON file and create output directory structure",
  parameters: z.object({
    state: z.any(), // PipelineState is complex, use any to avoid schema issues
  }),
};

