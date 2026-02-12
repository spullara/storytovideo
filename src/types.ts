export interface Character {
  name: string;
  physicalDescription: string;  // detailed: face, body, clothing, features
  personality: string;
  ageRange: string;
}

export interface Location {
  name: string;
  visualDescription: string;  // architecture, lighting, colors, atmosphere
}

export interface Shot {
  shotNumber: number;          // global shot number across entire video
  sceneNumber: number;         // which scene this belongs to
  shotInScene: number;         // shot index within the scene (1, 2, 3...)
  durationSeconds: 4 | 6 | 8;
  shotType: "first_last_frame";
  composition: string;         // "wide_establishing" | "over_the_shoulder" | "two_shot" | "close_up" | "medium_shot" | "tracking" | "pov" | "insert_cutaway" | "low_angle" | "high_angle" | "shot_reverse_shot"
  startFramePrompt: string;
  endFramePrompt: string;      // only for first_last_frame
  actionPrompt: string;
  dialogue: string;            // quoted speech (empty if none)
  soundEffects: string;
  cameraDirection: string;
  charactersPresent: string[];
  location: string;
  continuousFromPrevious: boolean;
}

export interface Scene {
  sceneNumber: number;
  title: string;
  narrativeSummary: string;
  charactersPresent: string[];
  location: string;
  estimatedDurationSeconds: number;
  shots: Shot[];               // filled by Claude orchestrator
  transition: "cut" | "fade_black" | "cross_dissolve" | "fade_white" | "wipe_left";  // transition INTO this scene (scene 1 is always "cut")
}

export interface StoryAnalysis {
  title: string;
  artStyle: string;
  characters: Character[];
  locations: Location[];
  scenes: Scene[];
}

export interface AssetLibrary {
  characterImages: Record<string, { front: string; angle: string }>;  // paths
  locationImages: Record<string, string>;                              // paths
}

export interface VerificationResult {
  passed: boolean;
  score: number;               // 0.0-1.0
  issues: string[];
  suggestions: string[];       // prompt improvements
}

export interface PipelineOptions {
  outputDir: string;
  dryRun: boolean;
  verify: boolean;
  maxRetries: number;
  skipTo?: string;
  redo?: string;
  resume: boolean;
  verbose: boolean;
  reviewMode?: boolean;
}

export interface StageInstructionRecord {
  stage: string;
  instruction: string;
  submittedAt: string;
}

export interface StageDecisionRecord {
  stage: string;
  decision: "continue" | "instruction";
  decidedAt: string;
  instructionCount: number;
}

export interface PipelineState {
  storyFile: string;
  outputDir: string;
  currentStage: string;
  completedStages: string[];
  storyAnalysis: StoryAnalysis | null;
  assetLibrary: AssetLibrary | null;
  generatedAssets: Record<string, string>;        // { "character:Bolt:front": "path", ... } — item-level tracking
  generatedFrames: Record<number, { start?: string; end?: string }>;
  generatedVideos: Record<number, string>;
  errors: Array<{ stage: string; shot?: number; error: string; timestamp: string }>;
  verifications: Array<{ stage: string; shot?: number; passed: boolean; score: number; issues: string[]; timestamp: string }>;
  interrupted: boolean;                            // true if last run was interrupted
  awaitingUserReview: boolean;                     // true when next stage needs explicit user continue
  continueRequested: boolean;                      // true when user requested continue while awaiting review
  pendingStageInstructions: Record<string, string[]>;
  instructionHistory: StageInstructionRecord[];
  decisionHistory: StageDecisionRecord[];
  pendingJobs: Record<string, { jobId: string; outputPath: string }>;
  lastSavedAt: string;                             // ISO timestamp of last state save
}
