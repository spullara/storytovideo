import { z } from "zod";
import type { StoryAnalysis, Shot } from "../types";

// ---------------------------------------------------------------------------
// Cinematic rules — exported so the orchestrator can include them in prompts
// ---------------------------------------------------------------------------

export const CINEMATIC_RULES = `
FRAME INTERPOLATION CONSTRAINTS:
Each shot generates a START frame and an END frame. A video model then interpolates between them.
- The start and end frames MUST show the SAME scene from the SAME camera angle and composition.
- Only small, interpolatable changes between frames: character movement within frame, entering/leaving frame, gestures, facial expressions.
- Characters visible in the start frame must remain visible in the end frame (unless specifically exiting the frame).
- New characters may enter the frame between start and end.
- If you need a different camera angle or different character focus, that is a NEW SHOT (cut to it).
- Radically different start and end frames produce bad video — keep changes subtle.

COMPOSITION TYPES (start/end frame differences):
- wide_establishing: Static wide shot. Start: empty scene or characters entering. End: characters in position. Small motion only.
- over_the_shoulder: Camera locked behind one character's shoulder. Start/end show the SAME framing. Subject speaks or reacts — only expression and small gestures change.
- two_shot: Both characters in frame throughout. Start/end differ only in body language, gestures, expressions.
- close_up: Tight on one face throughout. Start/end differ only in facial expression.
- medium_shot: Waist-up framing stays consistent. Character gestures or shifts weight between start and end.
- tracking: Camera follows subject. Start: subject at position A. End: subject at position B. Same background/environment visible throughout.
- pov: What a character sees. Start/end show the same view with small changes (hand reaches for object, door opens, etc.).
- insert_cutaway: Close detail shot. Start/end show the same object with a small change (hand picks it up, liquid pours, etc.).
- low_angle: Fixed dramatic low angle. Same framing rules as medium_shot — only gestures/expressions change.
- high_angle: Fixed dramatic high angle. Same framing rules as medium_shot — only gestures/expressions change.

Typical dialogue scene pattern (2 characters, ~26s):
1. Wide two-shot establishing (8s) — both characters visible. Start: standing apart. End: facing each other.
2. Close-up on Character A (6s) — A speaks. Only expression/mouth changes between start and end.
3. Close-up on Character B (6s) — B reacts. Only expression changes between start and end.
4. OTS on A from behind B's shoulder (6s) — A continues speaking, small gesture between start and end.

DIALOGUE PACING:
- ~2.5 words/second in film
- 8s clip: ~15-20 words
- 6s clip: ~10-12 words
- 4s clip: ~6-8 words
- Not every shot needs dialogue — silence and reactions are valid

SCENE TRANSITIONS:
- Scene 1 always uses "cut" (no transition before the first scene)
- "cut" for immediate cuts between scenes (default, most common)
- "fade_black" for dramatic mood shifts, time jumps, or emotional beats — quick fade out to black then fade in
- Keep transitions SHORT (0.5-0.75 second) — they shouldn't distract

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
    transition: z.enum(["cut", "fade_black"]),
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
  transition: "cut" | "fade_black",
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

