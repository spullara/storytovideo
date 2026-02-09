import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import type { StoryAnalysis, Shot } from "../types";

// Zod schema for shots array
// Using z.any() to avoid infinite recursion issues with complex nested types
const shotsSchema = z.any();

/**
 * Plans shots for each scene with cinematic composition and dialogue pacing.
 * Uses Gemini 2.5 Flash with structured output.
 */
export async function planShots(analysis: StoryAnalysis): Promise<StoryAnalysis> {
  const cinematicRules = `
CINEMATIC COMPOSITION RULES:

Dialogue Scenes:
- over_the_shoulder: Camera behind speaker A's shoulder, focused on speaker B's face. Alternate between speakers.
- shot_reverse_shot: Cut between close-ups of each speaker.
- two_shot: Both characters in frame, medium shot. Establishes the conversation.
- close_up: Tight on face during emotional beats.
- insert_cutaway: Close-up of hand gesture, object, or detail.

Action/Establishing Scenes:
- wide_establishing: Full location, characters small. First shot of new location.
- medium_shot: Waist up, action with body language.
- tracking: Camera follows movement. Use extension type for seamless continuation.
- low_angle / high_angle: Power dynamics, drama.
- pov: Camera sees what character sees.

Typical dialogue scene pattern (2 characters, ~24s):
1. Wide two-shot establishing (8s) - both characters, location visible
2. OTS on character A speaking (8s) - over B's shoulder
3. OTS on character B responding (8s) - over A's shoulder
4. Close-up reaction of A (4-6s) - emotional beat

DIALOGUE PACING:
- ~2.5 words/second in film
- 8s clip: ~15-20 words
- 6s clip: ~10-12 words
- 4s clip: ~6-8 words
- Not every shot needs dialogue - silence and reactions are valid
`;

  const scenesJson = JSON.stringify(analysis.scenes, null, 2);

  const prompt = `You are a cinematic shot planner. Break down each scene into shots respecting the 8-second clip limit.

${cinematicRules}

Story Analysis:
${scenesJson}

For each scene:
1. Break into shots (each 4, 6, or 8 seconds)
2. Assign cinematic composition types (use underscore format: wide_establishing, over_the_shoulder, etc.)
3. Distribute dialogue across shots respecting pacing rules
4. Choose generation strategy (first_last_frame for composition changes, extension for continuity)
5. Write detailed frame prompts that include the composition type
6. Write action prompts for video generation
7. Include dialogue as quoted speech if present

Return a JSON object with scenes array, where each scene has a shots array with all required fields.`;

  // @ts-ignore - Zod schema type inference issue with generateObject
  const { object } = await generateObject({
    model: google("gemini-2.5-flash"),
    schema: shotsSchema,
    prompt,
  });

  // Merge shots back into analysis
  const updatedAnalysis = JSON.parse(JSON.stringify(analysis)) as StoryAnalysis;

  for (const sceneWithShots of object.scenes) {
    const sceneIndex = updatedAnalysis.scenes.findIndex(
      (s) => s.sceneNumber === sceneWithShots.sceneNumber
    );
    if (sceneIndex >= 0) {
      updatedAnalysis.scenes[sceneIndex].shots = sceneWithShots.shots as Shot[];
    }
  }

  return updatedAnalysis;
}

/**
 * Vercel AI SDK tool definition for planShots.
 * Claude calls this to plan shots for the analyzed story.
 */
export const planShotsTool = {
  description: "Plan cinematic shots for each scene with composition and dialogue pacing",
  parameters: z.object({
    analysis: z.any(),
  }),
};

