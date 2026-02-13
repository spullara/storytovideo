import { z } from "zod";
import type { StoryAnalysis, Shot } from "../types";

// ---------------------------------------------------------------------------
// Cinematic rules — exported so the orchestrator can include them in prompts
// ---------------------------------------------------------------------------

export const CINEMATIC_RULES = `
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

SCENE TRANSITIONS:
- Scene 1 always uses "cut" (no transition before the first scene)
- "fade_black" for dramatic mood shifts or time jumps
- "cross_dissolve" for gentle time passing or location changes
- "fade_white" for dreamy, emotional, or transcendent moments
- "wipe_left" sparingly for dramatic reveals
- Keep transitions SHORT (0.5-1 second) — they shouldn't distract

CROSS-SHOT CONTINUITY:
- Set continuousFromPrevious: true when this shot continues directly from the previous shot within the same scene — same location, continuous action, no time skip. The camera angle/composition may change but the scene content is continuous.
- Set continuousFromPrevious: false when:
  - It's the first shot of a scene (always false)
  - There's a time skip from the previous shot
  - The location changes from the previous shot
  - The action is not continuous (e.g., reaction shot after a pause)
- When continuousFromPrevious is true, the system will reuse the previous shot's end frame as this shot's start frame for perfect visual continuity.
`;

// ---------------------------------------------------------------------------
// Per-scene shot schema (no shotNumber or sceneNumber — auto-assigned)
// ---------------------------------------------------------------------------

const perSceneShotSchema = z.object({
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

// ---------------------------------------------------------------------------
// Tool definition — structured save mechanism for per-scene shot data
// ---------------------------------------------------------------------------

export const planShotsForSceneTool = {
  description: "Save the planned shots for a single scene. Call once per scene, in order.",
  parameters: z.object({
    sceneNumber: z.number(),
    transition: z.enum(["cut", "fade_black", "cross_dissolve", "fade_white", "wipe_left"]),
    shots: z.array(perSceneShotSchema),
  }),
};

// ---------------------------------------------------------------------------
// Core function — merges planned shots into the analysis for one scene
// ---------------------------------------------------------------------------

/**
 * Merges planned shots for a single scene into the story analysis.
 * Auto-assigns global `shotNumber` and `sceneNumber` on each shot.
 */
export function planShotsForScene(
  sceneNumber: number,
  transition: "cut" | "fade_black" | "cross_dissolve" | "fade_white" | "wipe_left",
  shots: z.infer<typeof planShotsForSceneTool.parameters>["shots"],
  analysis: StoryAnalysis,
): StoryAnalysis {
  // Deep-clone so we don't mutate the original
  const updatedAnalysis = JSON.parse(JSON.stringify(analysis)) as StoryAnalysis;

  // Find the target scene
  const sceneIndex = updatedAnalysis.scenes.findIndex(s => s.sceneNumber === sceneNumber);
  if (sceneIndex < 0) {
    throw new Error(`Scene ${sceneNumber} not found in analysis`);
  }

  // Set the scene transition
  updatedAnalysis.scenes[sceneIndex].transition = transition;

  // Count existing shots across ALL scenes to determine the next global shotNumber
  let nextShotNumber = 1;
  for (const scene of updatedAnalysis.scenes) {
    if (scene.sceneNumber === sceneNumber) continue; // skip the scene we're about to fill
    nextShotNumber += (scene.shots?.length ?? 0);
  }

  // Process shots: assign shotNumber, sceneNumber, ensure shotType
  const processedShots: Shot[] = shots.map((shot) => ({
    ...shot,
    shotNumber: nextShotNumber++,
    sceneNumber,
    shotType: "first_last_frame" as const,
    durationSeconds: shot.durationSeconds as 4 | 6 | 8,
  }));

  updatedAnalysis.scenes[sceneIndex].shots = processedShots;

  return updatedAnalysis;
}

