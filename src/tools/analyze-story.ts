import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { StoryAnalysis } from "../types";

// Zod schema for story analysis (without shots)
const sceneSchema = z.object({
  sceneNumber: z.number(),
  title: z.string(),
  narrativeSummary: z.string(),
  charactersPresent: z.array(z.string()),
  location: z.string(),
  estimatedDurationSeconds: z.number(),
});

const storyAnalysisSchema = z.object({
  title: z.string(),
  artStyle: z.string(),
  characters: z.array(z.object({
    name: z.string(),
    physicalDescription: z.string(),
    personality: z.string(),
    ageRange: z.string(),
  })),
  locations: z.array(z.object({
    name: z.string(),
    visualDescription: z.string(),
  })),
  scenes: z.array(sceneSchema),
});

/**
 * Analyzes a story to extract characters, locations, art style, and scenes.
 * Uses Claude Opus 4.6 with structured output.
 */
export async function analyzeStory(storyText: string): Promise<StoryAnalysis> {
  const prompt = `Analyze the following story and extract:
1. Title
2. Visual art style (describe the visual aesthetic)
3. Characters (name, detailed physical description, personality, age range)
4. Locations (name, visual description with architecture, lighting, colors, atmosphere)
5. Scenes (numbered, with title, narrative summary, characters present, location, estimated duration)

For each character, provide vivid physical descriptions that will help generate consistent reference images.
For each location, describe the visual mood, lighting, and key objects.
Estimate scene duration based on action density and dialogue length.

Story:
${storyText}`;

  try {
    const { object } = await generateObject({
      model: anthropic("claude-opus-4-6"),
      schema: storyAnalysisSchema,
      prompt,
    } as any);

    const result = object as any;
    // Add empty shots arrays (filled by shot planner later)
    if (result.scenes) {
      result.scenes = result.scenes.map((s: any) => ({ ...s, shots: [] }));
    }
    return result as StoryAnalysis;
  } catch (error) {
    console.error("Error in analyzeStory:", error);
    throw error;
  }
}

/**
 * Vercel AI SDK tool definition for analyzeStory.
 * Claude calls this to analyze the story.
 */
export const analyzeStoryTool = {
  description: "Analyze a story to extract characters, locations, art style, and scenes",
  parameters: z.object({
    storyText: z.string(),
  }),
};

