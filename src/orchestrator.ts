import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { writeFileSync } from "fs";
import { join } from "path";

import type { PipelineOptions, PipelineState, StoryAnalysis } from "./types";
import { interrupted } from "./cli";
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
    lastSavedAt: new Date().toISOString(),
  };
}

function log(verbose: boolean, ...args: unknown[]): void {
  if (verbose) {
    console.log(...args);
  }
}

function compactState(state: PipelineState): string {
  return JSON.stringify(state, null, 2);
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
  tools: Record<string, ReturnType<typeof tool>>,
  maxSteps: number,
  verbose: boolean,
): Promise<PipelineState> {
  console.log(`\n=== Stage: ${stageName} ===`);

  const result = await generateText({
    model: anthropic("claude-opus-4-6"),
    system: systemPrompt,
    prompt: userPrompt,
    tools,
    maxSteps,
    onStepFinish: (step) => {
      if (verbose) {
        if (step.text) {
          console.log(`[${stageName}] Claude: ${step.text.substring(0, 200)}`);
        }
        if (step.toolCalls && step.toolCalls.length > 0) {
          for (const tc of step.toolCalls) {
            console.log(`[${stageName}] Tool call: ${tc.toolName}`);
          }
        }
      }
    },
  });

  log(verbose, `[${stageName}] Final text:`, result.text?.substring(0, 300) || "(no text)");

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
    analyzeStory: tool({
      description: analyzeStoryTool.description,
      parameters: analyzeStoryTool.parameters,
      execute: async (params: z.infer<typeof analyzeStoryTool.parameters>) => {
        const result = await analyzeStory(params.storyText);
        state.storyAnalysis = result;
        return result;
      },
    }),
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
    planShots: tool({
      description: planShotsTool.description,
      parameters: planShotsTool.parameters,
      execute: async (params: z.infer<typeof planShotsTool.parameters>) => {
        const result = await planShots(params.analysis as StoryAnalysis);
        state.storyAnalysis = result;
        return result;
      },
    }),
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

  if (neededAssets.length === 0) {
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

  const assetTools = {
    generateAsset: tool({
      description: generateAssetTool.description,
      parameters: generateAssetTool.parameters,
      execute: async (params: z.infer<typeof generateAssetTool.parameters>) => {
        const result = await generateAsset({
          ...params,
          dryRun: options.dryRun,
          outputDir: options.outputDir,
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
        return result;
      },
    }),
    saveState: tool({
      description: saveStateTool.description,
      parameters: saveStateTool.parameters,
      execute: async () => {
        return saveState({ state });
      },
    }),
  };

  if (options.verify) {
    (assetTools as Record<string, ReturnType<typeof tool>>).verifyOutput = tool({
      description: verifyOutputTool.description,
      parameters: verifyOutputTool.parameters,
      execute: async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      },
    });
  }

  await runStage("asset_generation", state, options, systemPrompt, userPrompt, assetTools, 60, options.verbose);

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
  const flfShots = allShots.filter((s) => s.shotType === "first_last_frame");

  // Determine which frames still need generation
  const neededFrames = flfShots.filter((s) => {
    const existing = state.generatedFrames[s.shotNumber];
    return !existing || !existing.start || !existing.end;
  });

  if (neededFrames.length === 0) {
    console.log("[frame_generation] All frames already generated, skipping.");
    state.completedStages.push("frame_generation");
    state.currentStage = "video_generation";
    return state;
  }

  const stateJson = compactState(state);
  const systemPrompt = `You are a frame generation agent. Generate start and end keyframe images for first_last_frame shots.

Current pipeline state:
${stateJson}

For each first_last_frame shot that doesn't already have frames in state.generatedFrames, call generateFrame with the shot data, art style, and asset library.

IMPORTANT:
- Only generate frames for shots with shotType "first_last_frame".
- Check state.generatedFrames[shotNumber] before generating — skip if start and end already exist.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateFrame.
- Use outputDir="${options.outputDir}".
- Art style: "${analysis.artStyle}"

Shots needing frames: ${neededFrames.map((s) => `Shot ${s.shotNumber}`).join(", ")}`;

  const userPrompt = `Generate keyframes for ${neededFrames.length} shots that need first_last_frame generation.`;

  const frameTools = {
    generateFrame: tool({
      description: generateFrameTool.description,
      parameters: generateFrameTool.parameters,
      execute: async (params: z.infer<typeof generateFrameTool.parameters>) => {
        const result = await generateFrame({
          shot: params.shot,
          artStyle: params.artStyle,
          assetLibrary: params.assetLibrary,
          outputDir: options.outputDir,
          dryRun: options.dryRun,
        });
        state.generatedFrames[result.shotNumber] = {
          start: result.startPath,
          end: result.endPath,
        };
        return result;
      },
    }),
    saveState: tool({
      description: saveStateTool.description,
      parameters: saveStateTool.parameters,
      execute: async () => {
        return saveState({ state });
      },
    }),
  };

  if (options.verify) {
    (frameTools as Record<string, ReturnType<typeof tool>>).verifyOutput = tool({
      description: verifyOutputTool.description,
      parameters: verifyOutputTool.parameters,
      execute: async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      },
    });
  }

  await runStage("frame_generation", state, options, systemPrompt, userPrompt, frameTools, 60, options.verbose);

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

  if (neededVideos.length === 0) {
    console.log("[video_generation] All videos already generated, skipping.");
    state.completedStages.push("video_generation");
    state.currentStage = "assembly";
    return state;
  }

  const stateJson = compactState(state);
  const systemPrompt = `You are a video generation agent. Generate video clips for each shot.

Current pipeline state:
${stateJson}

For each shot, call generateVideo with the appropriate parameters:
- For first_last_frame shots: provide startFramePath and endFramePath from state.generatedFrames
- For extension shots: provide previousVideoPath from the previous shot's generated video
- Generate shots SEQUENTIALLY within each scene (extension shots need the previous video)

IMPORTANT:
- Check state.generatedVideos[shotNumber] before generating — skip if already exists.
- After EACH successful generation, call saveState to checkpoint progress.
- Pass dryRun=${options.dryRun} to generateVideo.
- Use outputDir="${join(options.outputDir, "videos")}" for all videos.
- Process shots in order (by shotNumber) since extension shots depend on previous shots.
- For reference images, collect character front images from the asset library for characters in the shot.

Shots needing videos: ${neededVideos.map((s) => `Shot ${s.shotNumber} (${s.shotType})`).join(", ")}`;

  const userPrompt = `Generate video clips for ${neededVideos.length} shots. Process them in order by shot number.`;

  const videoTools = {
    generateVideo: tool({
      description: generateVideoTool.description,
      parameters: generateVideoTool.parameters,
      execute: async (params: z.infer<typeof generateVideoTool.parameters>) => {
        const result = await generateVideo({
          ...params,
          durationSeconds: parseInt(params.durationSeconds, 10) as 4 | 6 | 8,
          dryRun: options.dryRun,
          outputDir: join(options.outputDir, "videos"),
        });
        state.generatedVideos[result.shotNumber] = result.path;
        return result;
      },
    }),
    saveState: tool({
      description: saveStateTool.description,
      parameters: saveStateTool.parameters,
      execute: async () => {
        return saveState({ state });
      },
    }),
  };

  if (options.verify) {
    (videoTools as Record<string, ReturnType<typeof tool>>).verifyOutput = tool({
      description: verifyOutputTool.description,
      parameters: verifyOutputTool.parameters,
      execute: async (params: z.infer<typeof verifyOutputTool.parameters>) => {
        return verifyOutput({ ...params, dryRun: options.dryRun });
      },
    });
  }

  await runStage("video_generation", state, options, systemPrompt, userPrompt, videoTools, 80, options.verbose);

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

  const systemPrompt = `You are a video assembly agent. Assemble all generated video clips into a single final video.

Call assembleVideo with the ordered list of video paths. Then call saveState to checkpoint.

Video paths (in order): ${JSON.stringify(videoPaths)}
Output directory: "${options.outputDir}"`;

  const userPrompt = `Assemble ${videoPaths.length} video clips into the final video.`;

  const assemblyTools = {
    assembleVideo: tool({
      description: assembleVideoTool.description,
      parameters: assembleVideoTool.parameters,
      execute: async (params: z.infer<typeof assembleVideoTool.parameters>) => {
        return assembleVideo({
          ...params,
          dryRun: options.dryRun,
        });
      },
    }),
    saveState: tool({
      description: saveStateTool.description,
      parameters: saveStateTool.parameters,
      execute: async () => {
        return saveState({ state });
      },
    }),
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
    state.currentStage = options.skipTo;
    console.log(`Skipping to stage: ${options.skipTo}`);
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

    // Save state between stages
    await saveState({ state });

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