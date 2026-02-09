import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import type { StoryAnalysis } from "../types";

// Zod schema for story analysis (without shots)
// Using z.any() to avoid infinite recursion issues with complex nested types
const storyAnalysisSchema = z.any();

/**
 * Analyzes a story to extract characters, locations, art style, and scenes.
 * Uses Gemini 2.5 Flash with structured output.
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

  // @ts-ignore - Zod schema type inference issue with generateObject
  const { object } = await generateObject({
    model: google("gemini-2.5-flash"),
    schema: storyAnalysisSchema,
    prompt,
  });

  // Cast to StoryAnalysis (scenes won't have shots yet)
  return object as StoryAnalysis;
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

