import { generateText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join } from "path";

import type { PipelineOptions, PipelineState, StoryAnalysis } from "./types";
import { interrupted } from "./signals";
import { analyzeStory, analyzeStoryTool } from "./tools/analyze-story";
import { planShots, planShotsTool } from "./tools/plan-shots";
import { generateAsset, generateAssetTool } from "./tools/generate-asset";
import { generateFrame, generateFrameTool } from "./tools/generate-frame";
import { generateVideo, generateVideoTool } from "./tools/generate-video";
import { verifyOutput, verifyOutputTool } from "./tools/verify-output";
import { assembleVideo, assembleVideoTool } from "./tools/assemble-video";
import { saveState, loadState, saveStateTool } from "./tools/state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StageName =
  | "analysis"
  | "shot_planning"
  | "asset_generation"
  | "frame_generation"
  | "video_generation"
  | "assembly";

const STAGE_ORDER: StageName[] = [
  "analysis",
  "shot_planning",
  "asset_generation",
  "frame_generation",
  "video_generation",
  "assembly",
];

// ---------------------------------------------------------------------------
// Tool execute wrapper — logs success/failure for debugging
// ---------------------------------------------------------------------------

function wrapToolExecute<T>(stageName: string, toolName: string, fn: (params: any) => Promise<T>): (params: any) => Promise<T> {
  return async (params: any) => {
    try {
      const result = await fn(params);
      console.log(`[${stageName}] Tool success (${toolName}): ${JSON.stringify(result)?.substring(0, 200)}`);
      return result;
    } catch (error) {
      console.error(`[${stageName}] Tool FAILED (${toolName}):`, error instanceof Error ? error.message : error);
      console.error(`[${stageName}] Tool params were:`, JSON.stringify(params)?.substring(0, 500));
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createInitialState(storyFile: string, outputDir: string): PipelineState {
  return {
    storyFile,
    outputDir,
    currentStage: "analysis",
    completedStages: [],
    storyAnalysis: null,
    assetLibrary: null,
    generatedAssets: {},
    generatedFrames: {},
    generatedVideos: {},
    errors: [],
    verifications: [],
    interrupted: false,
    awaitingUserReview: false,
    continueRequested: false,
    pendingStageInstructions: {},
    instructionHistory: [],
    decisionHistory: [],
    pendingJobs: {},
    lastSavedAt: new Date().toISOString(),
  };
}



function compactState(state: PipelineState): string {
  return JSON.stringify(state, null, 2);
}

function getStageInstructions(state: PipelineState, stageName: string): string[] {
  return state.pendingStageInstructions[stageName] ?? [];
}

function buildInstructionInjectionBlock(instructions: string[]): string {
  if (instructions.length === 0) {
    return "";
  }

  const numbered = instructions
    .map((instruction, index) => `${index + 1}. ${instruction}`)
    .join("\n");

  return `\n\nAdditional user instructions for this stage:\n${numbered}\nApply these instructions when executing this stage unless they conflict with tool schemas or safety constraints.`;
}

/**
 * Clear item-level data for a given stage and all subsequent stages.
 * This is used by the --redo option to reset state before re-running a stage.
 *
 * Data clearing rules by stage:
 * - analysis (0): clear storyAnalysis, assetLibrary, generatedAssets, generatedFrames, generatedVideos
 * - shot_planning (1): clear assetLibrary, generatedAssets, generatedFrames, generatedVideos
 * - asset_generation (2): clear generatedAssets, generatedFrames, generatedVideos
 * - frame_generation (3): clear generatedFrames, generatedVideos
 * - video_generation (4): clear generatedVideos
 * - assembly (5): nothing to clear
 */
export function clearStageData(state: PipelineState, fromStage: StageName): void {
  const stageIdx = STAGE_ORDER.indexOf(fromStage);
  if (stageIdx < 0) {
    throw new Error(`Unknown stage: ${fromStage}`);
  }

  // Clear data based on stage index
  if (stageIdx <= 0) {
    // analysis: clear everything
    state.storyAnalysis = null;
    state.assetLibrary = null;
    state.generatedAssets = {};
    state.generatedFrames = {};
    state.generatedVideos = {};
  } else if (stageIdx <= 1) {
    // shot_planning: clear asset-related and downstream
    state.assetLibrary = null;
    state.generatedAssets = {};
    state.generatedFrames = {};
    state.generatedVideos = {};
  } else if (stageIdx <= 2) {
    // asset_generation: clear generated assets and downstream
    state.generatedAssets = {};
    state.generatedFrames = {};
    state.generatedVideos = {};
  } else if (stageIdx <= 3) {
    // frame_generation: clear generated frames and videos
    state.generatedFrames = {};
    state.generatedVideos = {};
  } else if (stageIdx <= 4) {
    // video_generation: clear generated videos
    state.generatedVideos = {};
  }
  // assembly (5): nothing to clear

  // Remove the target stage and all subsequent stages from completedStages
  for (let i = stageIdx; i < STAGE_ORDER.length; i++) {
    const idx = state.completedStages.indexOf(STAGE_ORDER[i]);
    if (idx !== -1) {
      state.completedStages.splice(idx, 1);
    }
  }

  // Set currentStage to the target stage
  state.currentStage = fromStage;
}

// ---------------------------------------------------------------------------
// Stage runner — each stage is a separate generateText() call
// ---------------------------------------------------------------------------

async function runStage(
  stageName: string,
  state: PipelineState,
  _options: PipelineOptions,
  systemPrompt: string,
  userPrompt: string,
  tools: Record<string, any>,
  maxSteps: number,
  _verbose: boolean,
): Promise<PipelineState> {
  console.log(`\n=== Stage: ${stageName} ===`);
  const stageInstructions = getStageInstructions(state, stageName);
  if (stageInstructions.length > 0) {
    console.log(
      `[${stageName}] Applying ${stageInstructions.length} user instruction(s)`,
    );
  }
  const injectedSystemPrompt =
    systemPrompt + buildInstructionInjectionBlock(stageInstructions);

  const result = await generateText({
    model: anthropic("claude-opus-4-6") as any,
    system: injectedSystemPrompt,
    prompt: userPrompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: (step: any) => {
      console.log(`[${stageName}] Step keys:`, Object.keys(step).join(', '));
      if (step.text) {
        console.log(`[${stageName}] Claude: ${step.text.substring(0, 200)}`);
      }
      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const tc of step.toolCalls) {
          console.log(`[${stageName}] Tool call: ${tc.toolName}`);
        }
      }
      if (step.toolResults && step.toolResults.length > 0) {
        for (const tr of step.toolResults) {
          const resultStr = JSON.stringify(tr.result);
          if (tr.type === 'error' || (resultStr && resultStr.includes('"error"'))) {
            console.error(`[${stageName}] Tool error (${tr.toolName}):`, resultStr);
          } else {
            console.log(`[${stageName}] Tool result (${tr.toolName}): ${resultStr?.substring(0, 200) ?? '(no result)'}`);
          }
        }
      }
    },
  } as any);

  // Always log why the agent stopped
  const stepCount = result.steps?.length ?? 0;
  const finishReason = result.finishReason ?? "unknown";
  console.log(`[${stageName}] Agent finished: reason=${finishReason}, steps=${stepCount}/${maxSteps}`);
  if (result.usage) {
    const input = result.usage.inputTokens ?? 0;
    const output = result.usage.outputTokens ?? 0;
    console.log(`[${stageName}] Token usage: input=${input}, output=${output}, total=${input + output}`);
  }

  console.log(`[${stageName}] Final text:`, result.text?.substring(0, 300) || "(no text)");

  return state;
}

// ---------------------------------------------------------------------------
// Stage 1: Analysis
// ---------------------------------------------------------------------------

async function runAnalysisStage(
  state: PipelineState,
  storyText: string,
  options: PipelineOptions,
): Promise<PipelineState> {
  const systemPrompt = `You are a story analysis agent. Your job is to analyze the provided story text and extract structured information.

Call the analyzeStory tool with the full story text. The tool will return a StoryAnalysis object with characters, locations, art style, and scenes.

After receiving the analysis, respond with a brief summary of what was found.`;

  const userPrompt = `Analyze this story:\n\n${storyText}`;

  const analysisTools = {
    analyzeStory: {
      description: analyzeStoryTool.description,
      inputSchema: analyzeStoryTool.parameters,
      execute: wrapToolExecute("analysis", "analyzeStory", async (params: z.infer<typeof analyzeStoryTool.parameters>) => {
        const result = await analyzeStory(params.storyText);
        state.storyAnalysis = result;
        return result;
      }),
    },
  };

  await runStage("analysis", state, options, systemPrompt, userPrompt, analysisTools, 5, options.verbose);

  if (!state.storyAnalysis) {
    throw new Error("Analysis stage did not produce a StoryAnalysis");
  }

  state.completedStages.push("analysis");
  state.currentStage = "shot_planning";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 2: Shot Planning
// ---------------------------------------------------------------------------

async function runShotPlanningStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Shot planning requires storyAnalysis in state");
  }

  const systemPrompt = `You are a cinematic shot planner. Your job is to break down each scene into shots with cinematic composition.

Call the planShots tool with the story analysis. The tool will return an updated StoryAnalysis with shots populated for each scene.

After receiving the shot plan, respond with a brief summary of the shots planned.`;

  const analysisJson = JSON.stringify(state.storyAnalysis, null, 2);
  const userPrompt = `Plan cinematic shots for this story analysis:\n\n${analysisJson}`;

  const shotTools = {
    planShots: {
      description: planShotsTool.description,
      inputSchema: planShotsTool.parameters,
      execute: wrapToolExecute("shot_planning", "planShots", async (params: z.infer<typeof planShotsTool.parameters>) => {
        const result = await planShots(params.analysis as StoryAnalysis);
        state.storyAnalysis = result;
        return result;
      }),
    },
  };

  await runStage("shot_planning", state, options, systemPrompt, userPrompt, shotTools, 5, options.verbose);

  if (!state.storyAnalysis?.scenes?.some((s) => s.shots && s.shots.length > 0)) {
    throw new Error("Shot planning stage did not produce shots");
  }

  state.completedStages.push("shot_planning");
  state.currentStage = "asset_generation";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 3: Asset Generation
// ---------------------------------------------------------------------------

async function runAssetGenerationStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Asset generation requires storyAnalysis in state");
  }

  const analysis = state.storyAnalysis;

  // Build list of needed assets
  const neededAssets: string[] = [];
  for (const char of analysis.characters) {
    const frontKey = `character:${char.name}:front`;
    const angleKey = `character:${char.name}:angle`;
    if (!state.generatedAssets[frontKey]) neededAssets.push(frontKey);
    if (!state.generatedAssets[angleKey]) neededAssets.push(angleKey);
  }
  for (const loc of analysis.locations) {
    const locKey = `location:${loc.name}:front`;
    if (!state.generatedAssets[locKey]) neededAssets.push(locKey);
  }

  const hasPendingInstructions = (state.pendingStageInstructions["asset_generation"]?.length ?? 0) > 0;
  if (neededAssets.length === 0 && !hasPendingInstructions) {
    console.log("[asset_generation] All assets already generated, skipping.");
    state.completedStages.push("asset_generation");
    state.currentStage = "frame_generation";
    return state;
  }

  const stateJson = compactState(state);
  const systemPrompt = `You are an asset generation agent. Generate reference images for characters and locations.

Current pipeline state:
${stateJson}

For each character, generate TWO images:
1. Front-facing reference (call generateAsset with characterName, no referenceImagePath)
2. Angle reference (call generateAsset with characterName AND referenceImagePath pointing to the front image)

For each location, generate ONE image (call generateAsset with locationName).

IMPORTANT:
- Check state.generatedAssets before generating — skip items that already have paths.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateAsset.
- Use outputDir="${options.outputDir}" for all assets.
- Use the art style: "${analysis.artStyle}"

Assets still needed: ${JSON.stringify(neededAssets)}`;

  const userPrompt = `Generate all needed reference assets. Characters: ${analysis.characters.map((c) => c.name).join(", ")}. Locations: ${analysis.locations.map((l) => l.name).join(", ")}.`;

  const assetTools: Record<string, any> = {
    generateAsset: {
      description: generateAssetTool.description,
      inputSchema: generateAssetTool.parameters,
      execute: wrapToolExecute("asset_generation", "generateAsset", async (params: z.infer<typeof generateAssetTool.parameters>) => {
        const result = await generateAsset({
          ...params,
          dryRun: options.dryRun,
          outputDir: options.outputDir,
          pendingJobStore: {
            get: (key) => state.pendingJobs[key],
            set: async (key, value) => { state.pendingJobs[key] = value; await saveState({ state }); },
            delete: async (key) => { delete state.pendingJobs[key]; await saveState({ state }); },
          },
        });
        state.generatedAssets[result.key] = result.path;
        // Update asset library
        if (!state.assetLibrary) {
          state.assetLibrary = { characterImages: {}, locationImages: {} };
        }
        if (params.characterName) {
          if (!state.assetLibrary.characterImages[params.characterName]) {
            state.assetLibrary.characterImages[params.characterName] = { front: "", angle: "" };
          }
          if (params.referenceImagePath) {
            state.assetLibrary.characterImages[params.characterName].angle = result.path;
          } else {
            state.assetLibrary.characterImages[params.characterName].front = result.path;
          }
        }
        if (params.locationName) {
          state.assetLibrary.locationImages[params.locationName] = result.path;
        }
        await saveState({ state });
        return result;
      }),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("asset_generation", "saveState", async () => {
        return saveState({ state });
      }),
    },
  };

  if (options.verify) {
    assetTools.verifyOutput = {
      description: verifyOutputTool.description,
      inputSchema: verifyOutputTool.parameters,
      execute: wrapToolExecute("asset_generation", "verifyOutput", async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      }),
    };
  }

  await runStage("asset_generation", state, options, systemPrompt, userPrompt, assetTools, 60, options.verbose);

  // Recompute remaining assets after stage execution (same logic as neededAssets above)
  const remainingAssets: string[] = [];
  for (const char of analysis.characters) {
    const frontKey = `character:${char.name}:front`;
    const angleKey = `character:${char.name}:angle`;
    if (!state.generatedAssets[frontKey]) remainingAssets.push(frontKey);
    if (!state.generatedAssets[angleKey]) remainingAssets.push(angleKey);
  }
  for (const loc of analysis.locations) {
    const locKey = `location:${loc.name}:front`;
    if (!state.generatedAssets[locKey]) remainingAssets.push(locKey);
  }
  if (remainingAssets.length > 0) {
    console.warn(`[asset_generation] WARNING: ${remainingAssets.length} assets still missing. NOT marking as complete — will resume on next run.`);
    return state;
  }
  state.completedStages.push("asset_generation");
  state.currentStage = "frame_generation";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 4: Frame Generation
// ---------------------------------------------------------------------------

async function runFrameGenerationStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis || !state.assetLibrary) {
    throw new Error("Frame generation requires storyAnalysis and assetLibrary in state");
  }

  const analysis = state.storyAnalysis;
  const allShots = analysis.scenes.flatMap((s) => s.shots || []);

  // Determine which frames still need generation (all shots use first_last_frame)
  const neededFrames = allShots.filter((s) => {
    const existing = state.generatedFrames[s.shotNumber];
    return !existing || !existing.start || !existing.end;
  });

  const hasPendingInstructions = (state.pendingStageInstructions["frame_generation"]?.length ?? 0) > 0;
  if (neededFrames.length === 0 && !hasPendingInstructions) {
    console.log("[frame_generation] All frames already generated, skipping.");
    state.completedStages.push("frame_generation");
    state.currentStage = "video_generation";
    return state;
  }

  const stateJson = compactState(state);
  const systemPrompt = `You are a frame generation agent. Generate start and end keyframe images for all shots.

Current pipeline state:
${stateJson}

For each shot that doesn't already have frames in state.generatedFrames, call generateFrame with the shot data, art style, and asset library.

IMPORTANT:
- All shots use first_last_frame generation and need keyframes.
- Check state.generatedFrames[shotNumber] before generating — skip if start and end already exist.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateFrame.
- Use outputDir="${options.outputDir}".
- Art style: "${analysis.artStyle}"

CROSS-SHOT CONTINUITY (CRITICAL):
- Generate frames IN SHOT ORDER within each scene (shot 1 first, then shot 2, etc.)
- For each shot AFTER the first in a scene, pass previousEndFramePath = the end frame path of the immediately preceding shot
- This ensures visual continuity: the end of shot N visually matches the start of shot N+1
- The first shot of each scene does NOT need previousEndFramePath
- Look up the previous shot's end frame from state.generatedFrames[previousShotNumber].end

Example: When generating shot 3, if shot 2's end frame is at state.generatedFrames[2].end = "./output/frames/shot_2_end.png", pass previousEndFramePath="./output/frames/shot_2_end.png" to generateFrame for shot 3.

Shots needing frames: ${neededFrames.map((s) => `Shot ${s.shotNumber}`).join(", ")}`;

  const userPrompt = `Generate keyframes for ${neededFrames.length} shots that need first_last_frame generation.`;

  const frameTools: Record<string, any> = {
    generateFrame: {
      description: generateFrameTool.description,
      inputSchema: generateFrameTool.parameters,
      execute: wrapToolExecute("frame_generation", "generateFrame", async (params: z.infer<typeof generateFrameTool.parameters>) => {
        const result = await generateFrame({
          shot: params.shot,
          artStyle: params.artStyle,
          assetLibrary: params.assetLibrary,
          outputDir: options.outputDir,
          dryRun: options.dryRun,
          previousEndFramePath: params.previousEndFramePath,
          pendingJobStore: {
            get: (key) => state.pendingJobs[key],
            set: async (key, value) => { state.pendingJobs[key] = value; await saveState({ state }); },
            delete: async (key) => { delete state.pendingJobs[key]; await saveState({ state }); },
          },
        });
        state.generatedFrames[result.shotNumber] = {
          start: result.startPath,
          end: result.endPath,
        };
        await saveState({ state });
        return result;
      }),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("frame_generation", "saveState", async () => {
        return saveState({ state });
      }),
    },
  };

  if (options.verify) {
    frameTools.verifyOutput = {
      description: verifyOutputTool.description,
      inputSchema: verifyOutputTool.parameters,
      execute: wrapToolExecute("frame_generation", "verifyOutput", async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      }),
    };
  }

  await runStage("frame_generation", state, options, systemPrompt, userPrompt, frameTools, 60, options.verbose);

  // Recompute remaining frames after stage execution
  const remainingFrames = allShots.filter((s) => {
    const existing = state.generatedFrames[s.shotNumber];
    return !existing || !existing.start || !existing.end;
  });
  if (remainingFrames.length > 0) {
    console.warn(`[frame_generation] WARNING: ${remainingFrames.length}/${allShots.length} frames still missing. NOT marking as complete — will resume on next run.`);
    return state;
  }
  state.completedStages.push("frame_generation");
  state.currentStage = "video_generation";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 5: Video Generation
// ---------------------------------------------------------------------------

async function runVideoGenerationStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Video generation requires storyAnalysis in state");
  }

  const analysis = state.storyAnalysis;
  const allShots = analysis.scenes.flatMap((s) => s.shots || []);

  // Determine which videos still need generation
  const neededVideos = allShots.filter((s) => !state.generatedVideos[s.shotNumber]);

  const hasPendingInstructions = (state.pendingStageInstructions["video_generation"]?.length ?? 0) > 0;
  if (neededVideos.length === 0 && !hasPendingInstructions) {
    console.log("[video_generation] All videos already generated, skipping.");
    state.completedStages.push("video_generation");
    state.currentStage = "assembly";
    return state;
  }

  const stateJson = compactState(state);
  const systemPrompt = `You are a video generation agent. Generate video clips for each shot using first+last frame interpolation.

Current pipeline state:
${stateJson}

Generate video clips ONE AT A TIME. Call generateVideo for ONE shot, wait for the result, then proceed to the next shot.

CRITICAL: You MUST only call generateVideo ONCE per response. After each call completes, call saveState, then call generateVideo for the next shot. NEVER call generateVideo multiple times in the same response.

For each shot:
- Provide startFramePath and endFramePath from state.generatedFrames
- All shots use first_last_frame generation with start and end keyframes

Rules:
- Generate ONE video per step. Do NOT batch multiple generateVideo calls.
- Check state.generatedVideos[shotNumber] before generating — skip if already exists.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateVideo.
- Use outputDir="${join(options.outputDir, "videos")}" for all videos.
- Process shots in order (by shotNumber).

Shots needing videos: ${neededVideos.map((s) => `Shot ${s.shotNumber}`).join(", ")}`;

  const userPrompt = `Generate video clips for ${neededVideos.length} shots. Process them in order by shot number.`;

  const videoTools: Record<string, any> = {
    generateVideo: {
      description: generateVideoTool.description,
      inputSchema: generateVideoTool.parameters,
      execute: wrapToolExecute("video_generation", "generateVideo", async (params: z.infer<typeof generateVideoTool.parameters>) => {
        const result = await generateVideo({
          ...params,
          dryRun: options.dryRun,
          outputDir: join(options.outputDir, "videos"),
          pendingJobStore: {
            get: (key) => state.pendingJobs[key],
            set: async (key, value) => { state.pendingJobs[key] = value; await saveState({ state }); },
            delete: async (key) => { delete state.pendingJobs[key]; await saveState({ state }); },
          },
        });
        state.generatedVideos[result.shotNumber] = result.path;
        await saveState({ state });
        return result;
      }),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("video_generation", "saveState", async () => {
        return saveState({ state });
      }),
    },
  };

  if (options.verify) {
    videoTools.verifyOutput = {
      description: verifyOutputTool.description,
      inputSchema: verifyOutputTool.parameters,
      execute: wrapToolExecute("video_generation", "verifyOutput", async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      }),
    };
  }

  await runStage("video_generation", state, options, systemPrompt, userPrompt, videoTools, 80, options.verbose);

  // Recompute remaining videos after stage execution
  const remainingVideos = allShots.filter((s) => !state.generatedVideos[s.shotNumber]);
  if (remainingVideos.length > 0) {
    console.warn(`[video_generation] WARNING: ${remainingVideos.length}/${allShots.length} videos still missing. NOT marking as complete — will resume on next run.`);
    return state;
  }
  state.completedStages.push("video_generation");
  state.currentStage = "assembly";
  return state;
}

// ---------------------------------------------------------------------------
// Stage 6: Assembly
// ---------------------------------------------------------------------------

async function runAssemblyStage(
  state: PipelineState,
  options: PipelineOptions,
): Promise<PipelineState> {
  if (!state.storyAnalysis) {
    throw new Error("Assembly requires storyAnalysis in state");
  }

  // Collect all video paths in shot order
  const allShots = state.storyAnalysis.scenes.flatMap((s) => s.shots || []);
  const sortedShots = [...allShots].sort((a, b) => a.shotNumber - b.shotNumber);
  const videoPaths = sortedShots
    .map((s) => state.generatedVideos[s.shotNumber])
    .filter((p): p is string => !!p);

  if (videoPaths.length === 0) {
    console.log("[assembly] No videos to assemble.");
    state.completedStages.push("assembly");
    return state;
  }

  // Extract transitions from scenes
  // Build a map of scene number to transition type
  const sceneTransitions: Record<number, string> = {};
  for (const scene of state.storyAnalysis.scenes) {
    sceneTransitions[scene.sceneNumber] = scene.transition || "cut";
  }

  // Build transitions array: one per scene boundary
  // transitions[i] is the transition BEFORE the first video of scene i+2
  const transitions: Array<{ type: "cut" | "fade_black" | "cross_dissolve" | "fade_white" | "wipe_left"; durationMs: number }> = [];

  for (let i = 0; i < sortedShots.length - 1; i++) {
    const currentShot = sortedShots[i];
    const nextShot = sortedShots[i + 1];

    // Check if we're crossing a scene boundary
    if (nextShot.sceneNumber !== currentShot.sceneNumber) {
      // Add transition for the next scene
      const nextSceneTransition = sceneTransitions[nextShot.sceneNumber] || "cut";
      const durationMs = nextSceneTransition === "fade_black" ? 750 : 500;
      transitions.push({
        type: nextSceneTransition as "cut" | "fade_black" | "cross_dissolve" | "fade_white" | "wipe_left",
        durationMs,
      });
    }
  }

  const systemPrompt = `You are a video assembly agent. Assemble all generated video clips into a single final video with scene transitions.

Scene transitions from the shot plan:
${JSON.stringify(state.storyAnalysis.scenes.map(s => ({ scene: s.sceneNumber, transition: s.transition || "cut" })))}

Call assembleVideo with the ordered list of video paths and the transitions array. Then call saveState to checkpoint.

Video paths (in order): ${JSON.stringify(videoPaths)}
Transitions (one per scene boundary): ${JSON.stringify(transitions)}
Output directory: "${options.outputDir}"`;

  const userPrompt = `Assemble ${videoPaths.length} video clips into the final video with ${transitions.length} scene transitions.`;

  const assemblyTools = {
    assembleVideo: {
      description: assembleVideoTool.description,
      inputSchema: assembleVideoTool.parameters,
      execute: wrapToolExecute("assembly", "assembleVideo", async (params: z.infer<typeof assembleVideoTool.parameters>) => {
        return assembleVideo({
          ...params,
          dryRun: options.dryRun,
        });
      }),
    },
    saveState: {
      description: saveStateTool.description,
      inputSchema: saveStateTool.parameters,
      execute: wrapToolExecute("assembly", "saveState", async () => {
        return saveState({ state });
      }),
    },
  };

  await runStage("assembly", state, options, systemPrompt, userPrompt, assemblyTools, 10, options.verbose);

  state.completedStages.push("assembly");
  return state;
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

export async function runPipeline(
  storyText: string,
  options: PipelineOptions,
): Promise<void> {
  // Load or create state
  let state: PipelineState;

  if (options.resume) {
    const loaded = loadState(options.outputDir);
    if (loaded) {
      console.log("Resuming from saved state...");
      console.log(`  Completed stages: ${loaded.completedStages.join(", ") || "(none)"}`);
      console.log(`  Current stage: ${loaded.currentStage}`);
      state = loaded;
      state.interrupted = false;
    } else {
      console.log("No saved state found, starting fresh.");
      state = createInitialState("(resumed)", options.outputDir);
    }
  } else {
    state = createInitialState("(input)", options.outputDir);
  }

  // Handle --skip-to: mark earlier stages as completed
  if (options.skipTo) {
    const skipIdx = STAGE_ORDER.indexOf(options.skipTo as StageName);
    if (skipIdx < 0) {
      throw new Error(`Unknown stage: ${options.skipTo}. Valid stages: ${STAGE_ORDER.join(", ")}`);
    }
    // Load state for skip-to (need prior stage data)
    const loaded = loadState(options.outputDir);
    if (loaded) {
      state = loaded;
      state.interrupted = false;
    }
    // Mark all stages before skipTo as completed
    for (let i = 0; i < skipIdx; i++) {
      if (!state.completedStages.includes(STAGE_ORDER[i])) {
        state.completedStages.push(STAGE_ORDER[i]);
      }
    }
    // Remove the target stage and all subsequent stages from completedStages
    // so they will be re-run
    for (let i = skipIdx; i < STAGE_ORDER.length; i++) {
      const idx = state.completedStages.indexOf(STAGE_ORDER[i]);
      if (idx !== -1) {
        state.completedStages.splice(idx, 1);
      }
    }
    state.currentStage = options.skipTo;
    console.log(`Skipping to stage: ${options.skipTo}`);
  }

  // Handle --redo: clear data from target stage onward and re-run
  if (options.redo) {
    const redoIdx = STAGE_ORDER.indexOf(options.redo as StageName);
    if (redoIdx < 0) {
      throw new Error(`Unknown stage: ${options.redo}. Valid stages: ${STAGE_ORDER.join(", ")}`);
    }
    // Load existing state
    const loaded = loadState(options.outputDir);
    if (loaded) {
      state = loaded;
      state.interrupted = false;
    }
    // Clear data from the target stage onward
    clearStageData(state, options.redo as StageName);
    // Save the cleared state immediately
    await saveState({ state });
    console.log(`Redoing stage: ${options.redo}`);
    console.log(`Cleared data from ${options.redo} onward`);
  }

  if (options.reviewMode && state.awaitingUserReview) {
    if (!state.continueRequested) {
      console.log("\nAwaiting user review before continuing.");
      return;
    }
    state.awaitingUserReview = false;
    state.continueRequested = false;
  }

  // Stage loop
  const stageRunners: Record<StageName, (s: PipelineState, o: PipelineOptions) => Promise<PipelineState>> = {
    analysis: (s, o) => runAnalysisStage(s, storyText, o),
    shot_planning: runShotPlanningStage,
    asset_generation: runAssetGenerationStage,
    frame_generation: runFrameGenerationStage,
    video_generation: runVideoGenerationStage,
    assembly: runAssemblyStage,
  };

  // Before the stage loop, check if any completed stage has pending instructions
  // If so, remove it from completedStages so it gets re-run
  const stagesToRerun: string[] = [];
  for (const stageName of [...state.completedStages]) {
    if (state.pendingStageInstructions[stageName]?.length > 0) {
      console.log(`Re-running completed stage ${stageName} due to pending instructions`);
      stagesToRerun.push(stageName);
    }
  }
  if (stagesToRerun.length > 0) {
    state.completedStages = state.completedStages.filter(s => !stagesToRerun.includes(s));
    // Update currentStage to the earliest stage being re-run so the UI shows the correct stage
    const earliestIdx = Math.min(...stagesToRerun.map(s => STAGE_ORDER.indexOf(s as StageName)));
    state.currentStage = STAGE_ORDER[earliestIdx];
    await saveState({ state });
  }

  for (const stageName of STAGE_ORDER) {
    // Skip completed stages
    if (state.completedStages.includes(stageName)) {
      console.log(`Skipping completed stage: ${stageName}`);
      continue;
    }

    // Check for interruption between stages
    if (interrupted) {
      console.log("\nInterrupted between stages. Saving state...");
      state.interrupted = true;
      await saveState({ state });
      console.log("Pipeline interrupted. Resume with: storytovideo <story> --resume");
      return;
    }

    // Dry-run: skip generation stages 3-5, skip assembly entirely
    if (options.dryRun && stageName === "assembly") {
      console.log("\n[dry-run] Skipping assembly stage.");
      break;
    }

    state.currentStage = stageName;
    await saveState({ state });

    // Re-run stage until it completes (handles partial completions from AI agent hitting maxSteps)
    while (!state.completedStages.includes(stageName)) {
      // Check for interruption before each attempt
      if (interrupted) {
        console.log("\nInterrupted during stage retry. Saving state...");
        state.interrupted = true;
        await saveState({ state });
        console.log("Pipeline interrupted. Resume with: storytovideo <story> --resume");
        return;
      }

      try {
        state = await stageRunners[stageName](state, options);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`\nError in stage ${stageName}: ${errMsg}`);
        state.errors.push({
          stage: stageName,
          error: errMsg,
          timestamp: new Date().toISOString(),
        });
        await saveState({ state });
        throw error;
      }

      if (!state.completedStages.includes(stageName)) {
        console.log(`[${stageName}] Stage incomplete, re-running...`);
        await saveState({ state });
      }
    }

    delete state.pendingStageInstructions[stageName];

    const shouldPauseForReview =
      Boolean(options.reviewMode) && stageName !== "assembly";
    if (shouldPauseForReview) {
      state.awaitingUserReview = true;
      state.continueRequested = false;
    }

    // Save state between stages
    await saveState({ state });

    if (shouldPauseForReview) {
      console.log(
        `\nPaused after ${stageName}. Awaiting user review before ${state.currentStage}.`,
      );
      return;
    }

    // After shot_planning in dry-run mode, save analysis and stop
    if (options.dryRun && stageName === "shot_planning") {
      if (state.storyAnalysis) {
        const analysisPath = join(options.outputDir, "story_analysis.json");
        writeFileSync(analysisPath, JSON.stringify(state.storyAnalysis, null, 2));
        console.log(`\n[dry-run] Shot plan saved to ${analysisPath}`);

        // Log shot plan summary
        const allShots = state.storyAnalysis.scenes.flatMap((s) => s.shots || []);
        console.log(`\n=== Shot Plan Summary ===`);
        console.log(`Title: ${state.storyAnalysis.title}`);
        console.log(`Art Style: ${state.storyAnalysis.artStyle}`);
        console.log(`Characters: ${state.storyAnalysis.characters.map((c) => c.name).join(", ")}`);
        console.log(`Locations: ${state.storyAnalysis.locations.map((l) => l.name).join(", ")}`);
        console.log(`Scenes: ${state.storyAnalysis.scenes.length}`);
        console.log(`Total shots: ${allShots.length}`);
        for (const scene of state.storyAnalysis.scenes) {
          console.log(`\n  Scene ${scene.sceneNumber}: ${scene.title}`);
          for (const shot of scene.shots || []) {
            console.log(`    Shot ${shot.shotNumber}: ${shot.composition} (${shot.shotType}, ${shot.durationSeconds}s)`);
            if (shot.dialogue) {
              console.log(`      Dialogue: "${shot.dialogue.substring(0, 60)}${shot.dialogue.length > 60 ? "..." : ""}"`);
            }
          }
        }
      }
      console.log("\n[dry-run] Pipeline complete. Generation stages skipped.");
      return;
    }
  }

  console.log("\n=== Pipeline Complete ===");
  if (state.storyAnalysis) {
    const allShots = state.storyAnalysis.scenes.flatMap((s) => s.shots || []);
    console.log(`Generated ${Object.keys(state.generatedAssets).length} assets`);
    console.log(`Generated ${Object.keys(state.generatedFrames).length} frame sets`);
    console.log(`Generated ${Object.keys(state.generatedVideos).length} videos`);
    console.log(`Total shots: ${allShots.length}`);
  }
}

// Export types and constants for use by other modules (e.g., server, CLI)
export type { StageName };
export { STAGE_ORDER };
