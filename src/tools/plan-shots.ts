import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import type { StoryAnalysis, Shot } from "../types";

// Zod schema for shots array
const shotSchema = z.object({
  shotNumber: z.number(),
  sceneNumber: z.number(),
  shotInScene: z.number(),
  durationSeconds: z.enum(["4", "6", "8"]).transform(v => parseInt(v)),
  shotType: z.literal("first_last_frame"),
  composition: z.string(),
  startFramePrompt: z.string(),
  endFramePrompt: z.string(),
  actionPrompt: z.string(),
  dialogue: z.string(),
  soundEffects: z.string(),
  cameraDirection: z.string(),
  charactersPresent: z.array(z.string()),
  location: z.string(),
  continuousFromPrevious: z.boolean(),
});

const sceneShotsSchema = z.object({
  scenes: z.array(z.object({
    sceneNumber: z.number(),
    transition: z.enum(["cut", "fade_black", "cross_dissolve", "fade_white", "wipe_left"]).describe("Transition into this scene. Scene 1 is always 'cut'. Use fade_black for mood shifts, cross_dissolve for time passing, fade_white for dreamy/emotional moments, wipe_left sparingly for dramatic reveals."),
    shots: z.array(shotSchema),
  })),
});

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
- tracking: Camera follows movement. Use first_last_frame with start/end keyframes showing the movement arc.
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

SCENE TRANSITIONS:
- Scene 1 always uses "cut" (no transition before the first scene)
- "fade_black" for dramatic mood shifts or time jumps
- "cross_dissolve" for gentle time passing or location changes
- "fade_white" for dreamy, emotional, or transcendent moments
- "wipe_left" sparingly for dramatic reveals
- Keep transitions SHORT (0.5-1 second) — they shouldn't distract

Story Analysis:
${scenesJson}

For each scene:
1. Choose a transition type (cut, fade_black, cross_dissolve, fade_white, or wipe_left)
2. Break into shots (each 4, 6, or 8 seconds)
3. Assign cinematic composition types (use underscore format: wide_establishing, over_the_shoulder, etc.)
4. Distribute dialogue across shots respecting pacing rules
5. All shots use first_last_frame generation strategy
6. Write detailed frame prompts that include the composition type
7. Write action prompts for video generation
8. Include dialogue as quoted speech if present

CROSS-SHOT CONTINUITY:
- Set continuousFromPrevious: true when this shot continues directly from the previous shot within the same scene — same location, continuous action, no time skip. The camera angle/composition may change but the scene content is continuous.
- Set continuousFromPrevious: false when:
  - It's the first shot of a scene (always false)
  - There's a time skip from the previous shot
  - The location changes from the previous shot
  - The action is not continuous (e.g., reaction shot after a pause)
- When continuousFromPrevious is true, the system will reuse the previous shot's end frame as this shot's start frame for perfect visual continuity.

Return a JSON object with scenes array, where each scene has a transition field and a shots array with all required fields.`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }

  try {
    const google = createGoogleGenerativeAI({ apiKey });
    const { object } = await generateObject({
      model: google("gemini-2.5-flash"),
      schema: sceneShotsSchema,
      prompt,
    } as any);

    // Merge shots back into analysis
    const updatedAnalysis = JSON.parse(JSON.stringify(analysis)) as StoryAnalysis;
    const result = object as any;

    for (const sceneWithShots of result.scenes) {
      const sceneIndex = updatedAnalysis.scenes.findIndex(
        (s) => s.sceneNumber === sceneWithShots.sceneNumber
      );
      if (sceneIndex >= 0) {
        updatedAnalysis.scenes[sceneIndex].shots = sceneWithShots.shots as Shot[];
      }
    }

    return updatedAnalysis;
  } catch (error) {
    console.error("Error in planShots:", error);
    throw error;
  }
}

/**
 * Vercel AI SDK tool definition for planShots.
 * Claude calls this to plan shots for the analyzed story.
 */
export const planShotsTool = {
  description: "Plan cinematic shots for each scene with composition and dialogue pacing",
  parameters: z.object({
    analysis: z.object({
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
      scenes: z.array(z.object({
        sceneNumber: z.number(),
        title: z.string(),
        narrativeSummary: z.string(),
        charactersPresent: z.array(z.string()),
        location: z.string(),
        estimatedDurationSeconds: z.number(),
        transition: z.enum(["cut", "fade_black", "cross_dissolve", "fade_white", "wipe_left"]).optional().describe("Transition into this scene"),
        shots: z.array(z.any()), // shots are filled later
      })),
    }).describe("The story analysis result from analyzeStory"),
  }),
};

