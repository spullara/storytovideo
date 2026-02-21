import { z } from "zod";
import type { StoryAnalysis, Shot } from "../types";

// ---------------------------------------------------------------------------
// Cinematic rules — exported so the orchestrator can include them in prompts
// ---------------------------------------------------------------------------

export const CINEMATIC_RULES = `
FIXED CAMERA RULE (MOST IMPORTANT):
A shot is what a single, stationary camera sees. The camera does not move, pan, or change its target during a shot.
- The start frame and end frame are what this SAME fixed camera sees at the beginning and end of the shot.
- If the start frame is pointed at Person A, the end frame is ALSO pointed at Person A. You CANNOT switch to Person B.
- If the start frame shows a wide view of a room, the end frame shows the SAME wide view of the SAME room.
- The ONLY things that can change between start and end: facial expressions, small gestures, body language, a person entering/exiting the frame edges.
- If you need to show a different person or a different angle: that is a DIFFERENT SHOT. Use a cut.
- WRONG: Start frame = "close-up of Alice speaking" → End frame = "close-up of Bob reacting" (this is TWO different shots!)
- RIGHT: Start frame = "close-up of Alice speaking" → End frame = "close-up of Alice finishing her sentence with a slight smile"
- To switch focus to a different person, END the current shot and START a new shot on that person. This is how real films work — cut to the new subject.
- Example: Shot 3 = close-up of Alice speaking (start & end both on Alice). Shot 4 = close-up of Bob reacting (start & end both on Bob). Two shots, one cut.

FRAME INTERPOLATION CONSTRAINTS:
Each shot generates a START frame and an END frame. A video model then interpolates between them.
- The start and end frames MUST show the SAME scene from the SAME camera angle and composition.
- Only small, interpolatable changes between frames: character movement within frame, entering/leaving frame, gestures, facial expressions.
- Characters visible in the start frame must remain visible in the end frame (unless specifically exiting the frame).
- New characters may enter the frame between start and end.
- If you need a different camera angle or different character focus, that is a NEW SHOT (cut to it).
- Radically different start and end frames produce bad video — keep changes subtle.

COMPOSITION TYPES (start/end frame differences):
- wide_establishing: Static wide shot. Start: empty scene or characters entering. End: characters in position. Small motion only. The SAME wide view throughout — do not change the camera position or angle.
- over_the_shoulder: Camera locked behind ONE character's shoulder for the ENTIRE shot. The person being looked AT stays in frame throughout. Start/end show the SAME framing. Subject speaks or reacts — only expression and small gestures change.
- two_shot: Both characters in frame throughout. Start/end differ only in body language, gestures, expressions. The SAME two characters remain in frame for the entire shot.
- close_up: Tight on ONE face for the ENTIRE shot. Start and end show the SAME person's face — only expression changes. NEVER switch to a different person's face.
- medium_shot: Waist-up of ONE character for the ENTIRE shot. Character gestures or shifts weight between start and end. The SAME person stays in frame throughout.
- tracking: Camera follows ONE subject. Start: subject at position A. End: subject at position B. Same background/environment visible throughout. The SAME person is tracked the entire time.
- pov: What ONE character sees. Start/end show the same view with small changes (hand reaches for object, door opens, etc.).
- insert_cutaway: Close detail shot. Start/end show the same object with a small change (hand picks it up, liquid pours, etc.).
- low_angle: Fixed dramatic low angle on ONE subject. Same framing rules as medium_shot — only gestures/expressions change. The SAME subject throughout.
- high_angle: Fixed dramatic high angle on ONE subject. Same framing rules as medium_shot — only gestures/expressions change. The SAME subject throughout.

COMMON MISTAKES TO AVOID:
- Do NOT write a close_up that starts on Character A and ends on Character B — that is two shots.
- Do NOT write an over_the_shoulder that changes which character's shoulder we're behind — that is two shots.
- Do NOT write a start frame showing a room from one angle and end frame showing it from another angle — that is two shots.
- If dialogue passes from A to B during a shot, keep the CAMERA on whoever the shot is framed on. The other character's dialogue happens off-screen or in the next shot.
- Want to show B's reaction to what A said? Great — make that the NEXT shot (a new close_up on B). Don't try to cram both into one shot.

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

