import "dotenv/config";
import { randomUUID } from "crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join, resolve } from "path";

import { runPipeline, clearStageData, STAGE_ORDER } from "./orchestrator";
import {
  buildAssetFeed as buildAssetFeedFromState,
  createAssetFeedItem as createAssetFeedItemFromState,
  detectMimeType as detectMimeTypeFromPath,
  resolveMediaPathForRun as resolveMediaPathForOutputDir,
  type AssetFeedItem,
  type AssetFeedItemInput,
} from "./server-assets";
import {
  RunEventStream,
  type RunEventLevel,
  type RunEventType,
} from "./server-events";
import { loadState, saveState } from "./tools/state";
import { setInterrupted } from "./signals";
import type { PipelineOptions, PipelineState } from "./types";



const STATE_POLL_INTERVAL_MS = 750;

type RunStatus = "queued" | "running" | "awaiting_review" | "completed" | "failed";

interface RunRecord {
  id: string;
  storyText: string;
  outputDir: string;
  options: PipelineOptions;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  currentStage: string;
  completedStages: string[];
}

interface Progress {
  completed: number;
  total: number;
  percent: number;
}

interface ReviewState {
  awaitingUserReview: boolean;
  continueRequested: boolean;
  pendingInstructionCount: number;
  pendingInstructions: string[];
}

interface RunResponse {
  id: string;
  status: RunStatus;
  outputDir: string;
  currentStage: string;
  completedStages: string[];
  progress: Progress;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options: PipelineOptions;
  review: ReviewState;
}

interface StateSnapshot {
  currentStage: string;
  completedStages: string[];
  generatedAssets: Record<string, string>;
  generatedFrames: Record<string, { start?: string; end?: string }>;
  generatedVideos: Record<string, string>;
  errors: PipelineState["errors"];
  hasStoryAnalysis: boolean;
}

interface CreateRunRequest {
  storyText: string;
  outputDir?: string;
  options?: {
    dryRun?: boolean;
    verify?: boolean;
    maxRetries?: number;
    skipTo?: string;
    resume?: boolean;
    verbose?: boolean;
    reviewMode?: boolean;
  };
}

interface SubmitInstructionRequest {
  instruction: string;
  stage?: string;
}

const RUN_DB_DIR = resolve(process.env.STORYTOVIDEO_RUN_DB_DIR ?? "./output/api-server");
const RUN_DB_PATH = join(RUN_DB_DIR, "runs.json");
const RUN_OUTPUT_ROOT = resolve(process.env.STORYTOVIDEO_RUN_OUTPUT_ROOT ?? "./output/runs");
const SERVER_DIAGNOSTICS_PATH = join(RUN_DB_DIR, "server-diagnostics.ndjson");
const WEB_ROOT = resolve(process.cwd(), "src", "web");
const FATAL_SHUTDOWN_TIMEOUT_MS = 1_500;

const WEB_ASSET_BY_PATH: Record<string, { filePath: string; contentType: string }> = {
  "/": {
    filePath: join(WEB_ROOT, "index.html"),
    contentType: "text/html; charset=utf-8",
  },
  "/index.html": {
    filePath: join(WEB_ROOT, "index.html"),
    contentType: "text/html; charset=utf-8",
  },
  "/app.js": {
    filePath: join(WEB_ROOT, "app.js"),
    contentType: "text/javascript; charset=utf-8",
  },
  "/styles.css": {
    filePath: join(WEB_ROOT, "styles.css"),
    contentType: "text/css; charset=utf-8",
  },
};

class RunStore {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly dbPath: string) {
    this.load();
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  upsert(record: RunRecord): RunRecord {
    this.runs.set(record.id, record);
    this.persist();
    return record;
  }

  patch(id: string, patch: Partial<RunRecord>): RunRecord | undefined {
    const existing = this.runs.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: RunRecord = {
      ...existing,
      ...patch,
    };
    this.runs.set(id, updated);
    this.persist();
    return updated;
  }

  private load(): void {
    mkdirSync(RUN_DB_DIR, { recursive: true });

    if (!existsSync(this.dbPath)) {
      return;
    }

    try {
      const raw = readFileSync(this.dbPath, "utf-8");
      const parsed = JSON.parse(raw) as RunRecord[];
      for (const run of parsed) {
        this.runs.set(run.id, run);
      }
    } catch (error) {
      console.error("Failed to load run store:", error);
    }
  }

  private persist(): void {
    mkdirSync(RUN_DB_DIR, { recursive: true });
    const serialized = JSON.stringify(this.list(), null, 2);
    writeFileSync(this.dbPath, serialized, "utf-8");
  }
}

const runStore = new RunStore(RUN_DB_PATH);
const runEventStream = new RunEventStream();
const stateSnapshotByRunId = new Map<string, StateSnapshot>();
const stateMonitorByRunId = new Map<string, NodeJS.Timeout>();
/** Track running pipeline promises so we can await them during redo */
const runningPipelines = new Map<string, Promise<void>>();
let shutdownReason: string | null = null;
let shutdownInProgress = false;
let processExitLogged = false;

function normalizeDiagnosticValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function appendServerDiagnostic(event: string, context: Record<string, unknown> = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event,
    ...context,
  };

  try {
    mkdirSync(RUN_DB_DIR, { recursive: true });
    writeFileSync(
      SERVER_DIAGNOSTICS_PATH,
      `${JSON.stringify(entry)}\n`,
      { encoding: "utf-8", flag: "a" },
    );
  } catch (error) {
    console.error("Failed to persist server diagnostics:", error);
  }
}

function listActiveRunsForDiagnostics(): Array<{
  runId: string;
  status: RunStatus;
  currentStage: string;
  outputDir: string;
}> {
  return runStore
    .list()
    .filter((run) => run.status === "queued" || run.status === "running")
    .map((run) => ({
      runId: run.id,
      status: run.status,
      currentStage: run.currentStage,
      outputDir: run.outputDir,
    }));
}

function createInitialApiState(outputDir: string): PipelineState {
  return {
    storyFile: "(api-input)",
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

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function parseMaxRetries(value: unknown): number {
  if (value === undefined) {
    return 2;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error("options.maxRetries must be a non-negative integer");
}

function parseCreateRunRequest(body: unknown): CreateRunRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be a JSON object");
  }

  const request = body as Record<string, unknown>;
  const storyText = request.storyText;
  if (typeof storyText !== "string" || storyText.trim().length === 0) {
    throw new Error("storyText is required and must be a non-empty string");
  }

  const outputDirValue = request.outputDir;
  if (outputDirValue !== undefined && typeof outputDirValue !== "string") {
    throw new Error("outputDir must be a string when provided");
  }

  const optionsRaw = request.options;
  if (
    optionsRaw !== undefined &&
    (typeof optionsRaw !== "object" || optionsRaw === null || Array.isArray(optionsRaw))
  ) {
    throw new Error("options must be an object when provided");
  }

  const options = (optionsRaw ?? {}) as Record<string, unknown>;
  const skipTo = options.skipTo;
  if (skipTo !== undefined && typeof skipTo !== "string") {
    throw new Error("options.skipTo must be a string when provided");
  }

  return {
    storyText,
    outputDir: outputDirValue,
    options: {
      dryRun: parseBoolean(options.dryRun, false),
      verify: parseBoolean(options.verify, false),
      maxRetries: parseMaxRetries(options.maxRetries),
      skipTo,
      resume: parseBoolean(options.resume, false),
      verbose: parseBoolean(options.verbose, false),
      reviewMode: parseBoolean(options.reviewMode, true),
    },
  };
}

function parseStageName(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }
  if (!STAGE_ORDER.includes(value as (typeof STAGE_ORDER)[number])) {
    throw new Error(
      `${fieldName} must be one of: ${STAGE_ORDER.join(", ")}`,
    );
  }
  return value;
}

function parseSubmitInstructionRequest(body: unknown): SubmitInstructionRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }

  const request = body as Record<string, unknown>;
  const instruction = request.instruction;
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    throw new Error("instruction is required and must be a non-empty string");
  }

  const stageValue = request.stage;
  if (stageValue === undefined) {
    return { instruction: instruction.trim() };
  }

  const stage = parseStageName(stageValue, "stage");
  return {
    instruction: instruction.trim(),
    stage,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let total = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const asBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += asBuffer.length;
    if (total > 1_000_000) {
      throw new Error("Request body exceeds 1MB limit");
    }
    chunks.push(asBuffer);
  }

  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON request body");
  }
}

function buildPipelineOptions(request: CreateRunRequest, runId: string): PipelineOptions {
  const outputDir = request.outputDir
    ? resolve(request.outputDir)
    : resolve(join(RUN_OUTPUT_ROOT, runId));

  const options = request.options ?? {};

  return {
    outputDir,
    dryRun: options.dryRun ?? false,
    verify: options.verify ?? false,
    maxRetries: options.maxRetries ?? 2,
    skipTo: options.skipTo,
    resume: options.resume ?? false,
    verbose: options.verbose ?? false,
    reviewMode: options.reviewMode ?? true,
    onToolError: (stage: string, tool: string, error: string) => {
      emitLogEvent(runId, `[${stage}] ${tool} failed: ${error}`, "error");
    },
  };
}

function toProgress(completedStages: string[]): Progress {
  const completed = completedStages.filter((stage) =>
    STAGE_ORDER.includes(stage as (typeof STAGE_ORDER)[number]),
  ).length;
  const total = STAGE_ORDER.length;
  const percent = Math.round((completed / total) * 100);

  return { completed, total, percent };
}

function toRunResponse(record: RunRecord): RunResponse {
  const state = loadState(record.outputDir);
  const currentStage = state?.currentStage ?? record.currentStage;
  const completedStages = state?.completedStages ?? record.completedStages;
  const pendingInstructions =
    state?.pendingStageInstructions[currentStage] ?? [];

  return {
    id: record.id,
    status: record.status,
    outputDir: record.outputDir,
    currentStage,
    completedStages,
    progress: toProgress(completedStages),
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    error: record.error,
    options: record.options,
    review: {
      awaitingUserReview: state?.awaitingUserReview ?? false,
      continueRequested: state?.continueRequested ?? false,
      pendingInstructionCount: pendingInstructions.length,
      pendingInstructions,
    },
  };
}

function cloneGeneratedFrames(
  generatedFrames: PipelineState["generatedFrames"],
): Record<string, { start?: string; end?: string }> {
  const cloned: Record<string, { start?: string; end?: string }> = {};
  for (const [shotNumber, frameSet] of Object.entries(generatedFrames)) {
    cloned[shotNumber] = {
      start: frameSet?.start,
      end: frameSet?.end,
    };
  }
  return cloned;
}

function toStateSnapshot(state: PipelineState): StateSnapshot {
  return {
    currentStage: state.currentStage,
    completedStages: [...state.completedStages],
    generatedAssets: { ...state.generatedAssets },
    generatedFrames: cloneGeneratedFrames(state.generatedFrames),
    generatedVideos: { ...state.generatedVideos },
    errors: [...state.errors],
    hasStoryAnalysis: Boolean(state.storyAnalysis),
  };
}

function createAssetFeedItem(params: AssetFeedItemInput): AssetFeedItem {
  return createAssetFeedItemFromState(params);
}

function buildAssetFeed(runId: string, state: PipelineState): AssetFeedItem[] {
  return buildAssetFeedFromState(runId, state);
}

function parseAssetVariant(assetKey: string): string | undefined {
  const parts = assetKey.split(":");
  return parts.length >= 3 ? parts[2] : undefined;
}

function emitRunEvent(runId: string, type: RunEventType, payload: Record<string, unknown>): void {
  runEventStream.emitRunEvent(runId, type, payload);
}

function emitLogEvent(runId: string, message: string, level: RunEventLevel = "info"): void {
  runEventStream.emitLogEvent(runId, message, level);
}

function emitRunStatusEvent(runId: string, status: RunStatus, error?: string): void {
  runEventStream.emitRunStatusEvent(runId, status, error);
}

function emitAssetEvent(runId: string, item: AssetFeedItem): void {
  runEventStream.emitAssetEvent(runId, item);
}

function detectStateChanges(runId: string, state: PipelineState, previous: StateSnapshot, current: StateSnapshot): void {
  if (current.currentStage !== previous.currentStage) {
    emitRunEvent(runId, "stage_transition", {
      from: previous.currentStage,
      to: current.currentStage,
    });
    emitLogEvent(runId, `Stage transition: ${previous.currentStage} -> ${current.currentStage}`);
  }

  const completedBefore = new Set(previous.completedStages);
  for (const stage of current.completedStages) {
    if (!completedBefore.has(stage)) {
      emitRunEvent(runId, "stage_completed", { stage });
      emitLogEvent(runId, `Stage completed: ${stage}`);
    }
  }

  const fallbackTimestamp = state.lastSavedAt || new Date().toISOString();

  // Emit story_analysis.json as a document asset when it becomes available
  if (current.hasStoryAnalysis && !previous.hasStoryAnalysis) {
    emitAssetEvent(
      runId,
      createAssetFeedItem({
        runId,
        outputDir: state.outputDir,
        id: `${runId}-story-analysis`,
        type: "document",
        key: "story_analysis",
        path: "story_analysis.json",
        fallbackTimestamp,
      }),
    );
  }

  for (const [assetKey, assetPath] of Object.entries(current.generatedAssets)) {
    if (previous.generatedAssets[assetKey] !== assetPath) {
      emitAssetEvent(
        runId,
        createAssetFeedItem({
          runId,
          outputDir: state.outputDir,
          id: `asset:${assetKey}`,
          type: "asset",
          key: assetKey,
          path: assetPath,
          variant: parseAssetVariant(assetKey),
          fallbackTimestamp,
        }),
      );
    }
  }

  for (const [shotKey, frameSet] of Object.entries(current.generatedFrames)) {
    const previousFrameSet = previous.generatedFrames[shotKey];
    const shotNumber = Number(shotKey);

    if (frameSet.start && frameSet.start !== previousFrameSet?.start) {
      emitAssetEvent(
        runId,
        createAssetFeedItem({
          runId,
          outputDir: state.outputDir,
          id: `frame:${shotKey}:start`,
          type: "frame_start",
          key: `frame:${shotKey}:start`,
          path: frameSet.start,
          shotNumber,
          variant: "start",
          fallbackTimestamp,
        }),
      );
    }

    if (frameSet.end && frameSet.end !== previousFrameSet?.end) {
      emitAssetEvent(
        runId,
        createAssetFeedItem({
          runId,
          outputDir: state.outputDir,
          id: `frame:${shotKey}:end`,
          type: "frame_end",
          key: `frame:${shotKey}:end`,
          path: frameSet.end,
          shotNumber,
          variant: "end",
          fallbackTimestamp,
        }),
      );
    }
  }

  for (const [shotKey, videoPath] of Object.entries(current.generatedVideos)) {
    if (previous.generatedVideos[shotKey] !== videoPath) {
      emitAssetEvent(
        runId,
        createAssetFeedItem({
          runId,
          outputDir: state.outputDir,
          id: `video:${shotKey}`,
          type: "video",
          key: `video:${shotKey}`,
          path: videoPath,
          shotNumber: Number(shotKey),
          fallbackTimestamp,
        }),
      );
    }
  }

  const assemblyNewlyCompleted =
    current.completedStages.includes("assembly") &&
    !previous.completedStages.includes("assembly");

  if (assemblyNewlyCompleted) {
    emitAssetEvent(
      runId,
      createAssetFeedItem({
        runId,
        outputDir: state.outputDir,
        id: "final-video",
        type: "video",
        key: "final.mp4",
        path: "final.mp4",
        fallbackTimestamp,
      }),
    );
  }

  if (current.errors.length > previous.errors.length) {
    for (const errorEntry of current.errors.slice(previous.errors.length)) {
      emitLogEvent(
        runId,
        `Stage error (${errorEntry.stage}): ${errorEntry.error}`,
        "error",
      );
    }
  }
}

function pollRunState(runId: string): void {
  const run = runStore.get(runId);
  if (!run) {
    return;
  }

  const state = loadState(run.outputDir);
  if (!state) {
    return;
  }

  const previous = stateSnapshotByRunId.get(runId);
  const current = toStateSnapshot(state);

  if (previous) {
    detectStateChanges(runId, state, previous, current);
  }

  stateSnapshotByRunId.set(runId, current);
}

function startRunStateMonitor(runId: string): void {
  if (stateMonitorByRunId.has(runId)) {
    return;
  }

  pollRunState(runId);
  const timer = setInterval(() => {
    pollRunState(runId);
  }, STATE_POLL_INTERVAL_MS);
  stateMonitorByRunId.set(runId, timer);
}

function stopRunStateMonitor(runId: string): void {
  const timer = stateMonitorByRunId.get(runId);
  if (timer) {
    clearInterval(timer);
    stateMonitorByRunId.delete(runId);
  }
  stateSnapshotByRunId.delete(runId);
}

function streamRunEvents(req: IncomingMessage, res: ServerResponse, runId: string, url: URL): void {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  runEventStream.streamRunEvents(req, res, runId, url);
}

function resolveMediaPathForRun(run: RunRecord, encodedSegments: string[]): string | null {
  return resolveMediaPathForOutputDir(run.outputDir, encodedSegments);
}

function detectMimeType(filePath: string): string {
  return detectMimeTypeFromPath(filePath);
}

function sendStaticFile(
  res: ServerResponse,
  filePath: string,
  contentType: string,
): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.end(readFileSync(filePath));
  return true;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function isRunActivelyExecuting(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

function sendRunMutationLockedResponse(res: ServerResponse, run: RunRecord): void {
  sendJson(res, 409, {
    error: "Run is actively executing; interrupt or wait for review-safe state before mutating",
    code: "RUN_ACTIVE_LOCKED",
    runStatus: run.status,
  });
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

async function runInBackground(runId: string, resume = false): Promise<void> {
  const record = runStore.get(runId);
  if (!record) {
    return;
  }

  // If there's already a pipeline running for this run, don't start another
  if (runningPipelines.has(runId)) {
    console.warn(`[runInBackground] Pipeline already running for ${runId}, skipping`);
    return;
  }

  // Clear any stale interruption flag from a previous stop/redo
  setInterrupted(false);

  runStore.patch(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
  });
  emitRunStatusEvent(runId, "running");
  startRunStateMonitor(runId);

  const pipeline = (async () => {
    try {
      const pipelineOptions = resume
        ? { ...record.options, resume: true }
        : record.options;
      await runPipeline(record.storyText, pipelineOptions);
      pollRunState(runId);
      const state = loadState(record.outputDir);
      const currentStage = state?.currentStage ?? record.currentStage;
      const completedStages = state?.completedStages ?? record.completedStages;
      const isAwaitingReview = Boolean(record.options.reviewMode && state?.awaitingUserReview);

      if (isAwaitingReview) {
        runStore.patch(runId, {
          status: "awaiting_review",
          completedAt: undefined,
          currentStage,
          completedStages,
        });
        emitRunStatusEvent(runId, "awaiting_review");
        emitLogEvent(runId, `Awaiting user review before stage ${currentStage}`);
        return;
      }

      runStore.patch(runId, {
        status: "completed",
        completedAt: new Date().toISOString(),
        currentStage,
        completedStages,
      });
      emitRunStatusEvent(runId, "completed");
    } catch (error) {
      pollRunState(runId);
      const message = error instanceof Error ? error.message : String(error);
      const state = loadState(record.outputDir);
      const failedStage = state?.currentStage ?? record.currentStage;
      const completedStages = state?.completedStages ?? record.completedStages;
      const lifecycleContext = shutdownReason ? `shutdown:${shutdownReason}` : "running";
      runStore.patch(runId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message,
        currentStage: failedStage,
        completedStages,
      });
      emitRunStatusEvent(runId, "failed", message);
      emitLogEvent(
        runId,
        `Run failed at stage ${failedStage} (source=pipeline_error lifecycle=${lifecycleContext}): ${message}`,
        "error",
      );
      appendServerDiagnostic("run_failure", {
        runId,
        resume,
        outputDir: record.outputDir,
        stage: failedStage,
        message,
        lifecycleContext,
        error: normalizeDiagnosticValue(error),
        completedStages,
      });
    } finally {
      runningPipelines.delete(runId);
      stopRunStateMonitor(runId);
    }
  })();

  runningPipelines.set(runId, pipeline);
}

async function handleCreateRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsedBody = await readJsonBody(req);
  const request = parseCreateRunRequest(parsedBody);
  const runId = randomUUID();
  const pipelineOptions = buildPipelineOptions(request, runId);
  const createdAt = new Date().toISOString();

  mkdirSync(pipelineOptions.outputDir, { recursive: true });
  await saveState({ state: createInitialApiState(pipelineOptions.outputDir) });

  const record: RunRecord = {
    id: runId,
    storyText: request.storyText,
    outputDir: pipelineOptions.outputDir,
    options: pipelineOptions,
    status: "queued",
    createdAt,
    currentStage: "analysis",
    completedStages: [],
  };

  runStore.upsert(record);
  emitRunStatusEvent(runId, "queued");
  startRunStateMonitor(runId);
  setImmediate(() => {
    void runInBackground(runId);
  });

  sendJson(res, 201, toRunResponse(record));
}

async function handleSubmitInstruction(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  if (isRunActivelyExecuting(run.status)) {
    sendRunMutationLockedResponse(res, run);
    return;
  }

  const state = loadState(run.outputDir);
  if (!state) {
    sendJson(res, 409, { error: "Run state is not available" });
    return;
  }

  if (!state.awaitingUserReview) {
    sendJson(res, 409, { error: "Run is not awaiting review" });
    return;
  }

  const parsedBody = await readJsonBody(req);
  const parsedRequest = parseSubmitInstructionRequest(parsedBody);

  // Default to the first uncompleted stage (the one about to run or being retried)
  // This matches the UI's "Add guidance for the next stage..." placeholder
  let stage = parsedRequest.stage;
  if (!stage) {
    stage = STAGE_ORDER.find(s => !state.completedStages.includes(s)) ?? state.currentStage;
  }

  if (!stage) {
    sendJson(res, 409, { error: "No stage available for instruction" });
    return;
  }
  const submittedAt = new Date().toISOString();

  const nextInstructions = state.pendingStageInstructions[stage] ?? [];
  nextInstructions.push(parsedRequest.instruction);
  state.pendingStageInstructions[stage] = nextInstructions;
  state.instructionHistory.push({
    stage,
    instruction: parsedRequest.instruction,
    submittedAt,
  });

  await saveState({ state });

  // Auto-continue the run (same logic as handleContinueRun)
  state.continueRequested = true;
  const decidedAt = new Date().toISOString();
  const instructionCount = state.pendingStageInstructions[stage].length;
  state.decisionHistory.push({
    stage,
    decision: "instruction",
    decidedAt,
    instructionCount,
  });
  await saveState({ state });

  const updatedRecord = runStore.patch(runId, {
    status: "queued",
    completedAt: undefined,
    error: undefined,
    currentStage: state.currentStage,
    completedStages: state.completedStages,
  }) ?? run;

  emitRunStatusEvent(runId, "queued");
  emitLogEvent(runId, `Instruction added for stage ${stage}`);
  startRunStateMonitor(runId);
  setImmediate(() => {
    void runInBackground(runId, true);
  });

  sendJson(res, 200, {
    run: toRunResponse(updatedRecord),
    stage,
    instructionCount: state.pendingStageInstructions[stage].length,
    submittedAt,
  });
}

async function handleRetryRun(
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  if (run.status !== "failed") {
    sendJson(res, 409, { error: "Only failed runs can be retried" });
    return;
  }

  const state = loadState(run.outputDir);
  if (!state) {
    sendJson(res, 409, { error: "No saved state available for retry" });
    return;
  }

  const updatedRecord = runStore.patch(runId, {
    status: "queued",
    completedAt: undefined,
    error: undefined,
  }) ?? run;

  emitRunStatusEvent(runId, "queued");
  emitLogEvent(runId, "Retrying run from last checkpoint");
  startRunStateMonitor(runId);
  setImmediate(() => {
    void runInBackground(runId, true);
  });

  sendJson(res, 200, { run: toRunResponse(updatedRecord) });
}

async function handleRedoRun(
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  url: URL,
): Promise<void> {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  console.log('[handleRedoRun] Redo requested for run ' + runId);

  // If there's a running pipeline, interrupt and wait for it to finish
  const existingPipeline = runningPipelines.get(runId);
  if (existingPipeline) {
    console.log('[handleRedoRun] Interrupting running pipeline for ' + runId + '...');
    setInterrupted(true);
    // Wait for the old pipeline to actually finish (30s timeout as safety net)
    const timeoutPromise = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 30_000));
    const result = await Promise.race([
      existingPipeline.then(() => 'done' as const),
      timeoutPromise,
    ]);
    if (result === 'timeout') {
      // Old pipeline didn't finish in time — force-remove it from the map
      // so the new pipeline can start. Keep interrupted=true so the old
      // pipeline will stop at the next checkpoint.
      console.warn(`[handleRedoRun] Pipeline for ${runId} did not stop within 30s, force-removing`);
      runningPipelines.delete(runId);
      // Clear interrupted after a delay to give old pipeline time to see it
      setTimeout(() => setInterrupted(false), 5_000);
    } else {
      console.log('[handleRedoRun] Pipeline for ' + runId + ' stopped successfully');
      setInterrupted(false);
    }
  } else {
    console.log('[handleRedoRun] No running pipeline for ' + runId);
  }

  // Parse and validate stage query parameter
  const stage = url.searchParams.get("stage");
  if (!stage) {
    sendJson(res, 400, { error: "Missing required query parameter: stage" });
    return;
  }

  // Validate stage name
  if (!STAGE_ORDER.includes(stage as any)) {
    sendJson(res, 400, { error: `Invalid stage: ${stage}. Valid stages: ${STAGE_ORDER.join(", ")}` });
    return;
  }

  // Load state
  const state = loadState(run.outputDir);
  if (!state) {
    sendJson(res, 409, { error: "No saved state available for redo" });
    return;
  }

  // Clear data from the target stage onward
  clearStageData(state, stage as any);

  // Save the cleared state
  await saveState({ state });

  console.log('[handleRedoRun] State cleared. Remaining completedStages: ' + (state.completedStages.join(', ') || '(none)'));

  // Update run record
  const updatedRecord = runStore.patch(runId, {
    status: "queued",
    completedAt: undefined,
    error: undefined,
    currentStage: stage,
    completedStages: state.completedStages,
  }) ?? run;

  // Emit events
  emitRunStatusEvent(runId, "queued");
  emitLogEvent(runId, `Redoing from stage: ${stage}`);
  startRunStateMonitor(runId);
  console.log('[handleRedoRun] Starting new pipeline for ' + runId + ' from stage ' + stage);
  setImmediate(() => {
    void runInBackground(runId, true);
  });

  sendJson(res, 200, { run: toRunResponse(updatedRecord) });
}

async function handleRedoItem(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  console.log('[handleRedoItem] Redo-item requested for run ' + runId);

  // Parse and validate request body
  const body = await readJsonBody(req) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    sendJson(res, 400, { error: "Request body must be a JSON object" });
    return;
  }

  const { type, shotNumber, assetKey } = body as { type?: string; shotNumber?: number; assetKey?: string };

  const validTypes = ["frame", "video", "asset", "start_frame", "end_frame"];
  if (!type || !validTypes.includes(type)) {
    sendJson(res, 400, { error: `Invalid or missing "type". Must be one of: ${validTypes.join(", ")}.` });
    return;
  }

  // shotNumber is required for frame, video, start_frame, end_frame
  const needsShotNumber = type === "frame" || type === "video" || type === "start_frame" || type === "end_frame";
  if (needsShotNumber && (shotNumber === undefined || shotNumber === null || typeof shotNumber !== "number" || !Number.isInteger(shotNumber))) {
    sendJson(res, 400, { error: 'Invalid or missing "shotNumber". Must be an integer.' });
    return;
  }

  // assetKey is required for asset type
  if (type === "asset" && (!assetKey || typeof assetKey !== "string")) {
    sendJson(res, 400, { error: 'Invalid or missing "assetKey". Must be a string (e.g., "character:Lily:front", "location:Forest:front").' });
    return;
  }

  // If there's a running pipeline, interrupt and wait for it to finish
  const existingPipeline = runningPipelines.get(runId);
  if (existingPipeline) {
    console.log('[handleRedoItem] Interrupting running pipeline for ' + runId + '...');
    setInterrupted(true);
    const timeoutPromise = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 30_000));
    const result = await Promise.race([
      existingPipeline.then(() => 'done' as const),
      timeoutPromise,
    ]);
    if (result === 'timeout') {
      console.warn(`[handleRedoItem] Pipeline for ${runId} did not stop within 30s, force-removing`);
      runningPipelines.delete(runId);
      setTimeout(() => setInterrupted(false), 5_000);
    } else {
      console.log('[handleRedoItem] Pipeline for ' + runId + ' stopped successfully');
      setInterrupted(false);
    }
  } else {
    console.log('[handleRedoItem] No running pipeline for ' + runId);
  }

  // Load state
  const state = loadState(run.outputDir);
  if (!state) {
    sendJson(res, 409, { error: "No saved state available for redo" });
    return;
  }

  // Validate based on type
  let earliestStage: string;

  if (type === "asset") {
    // Validate that the assetKey exists in generatedAssets
    if (!state.generatedAssets[assetKey!]) {
      sendJson(res, 400, { error: `Asset key "${assetKey}" not found in generatedAssets` });
      return;
    }

    // Parse the asset key: "character:Name:front", "character:Name:angle", "location:Name:front"
    const parts = assetKey!.split(":");
    const assetType = parts[0]; // "character" or "location"
    const assetName = parts[1];
    const angleType = parts[2]; // "front" or "angle"

    if (assetType === "character" && angleType === "front") {
      // Deleting front → also delete angle (angle is derived from front via image editing)
      delete state.generatedAssets[assetKey!];
      const angleKey = `character:${assetName}:angle`;
      delete state.generatedAssets[angleKey];
      // Clear entire character from assetLibrary
      if (state.assetLibrary?.characterImages[assetName]) {
        delete state.assetLibrary.characterImages[assetName];
      }
    } else if (assetType === "character" && angleType === "angle") {
      // Deleting angle only — keep front
      delete state.generatedAssets[assetKey!];
      // Update assetLibrary: clear angle, keep front
      if (state.assetLibrary?.characterImages[assetName]) {
        state.assetLibrary.characterImages[assetName].angle = "";
      }
    } else if (assetType === "location") {
      // Delete location asset
      delete state.generatedAssets[assetKey!];
      // Clear from assetLibrary
      if (state.assetLibrary?.locationImages[assetName]) {
        delete state.assetLibrary.locationImages[assetName];
      }
    }

    // Cascade: frames and videos depend on assets
    state.completedStages = state.completedStages.filter(
      s => s !== "asset_generation" && s !== "frame_generation" && s !== "video_generation" && s !== "assembly"
    );
    earliestStage = "asset_generation";
  } else {
    // Types that require shotNumber: frame, video, start_frame, end_frame
    // Validate that shotNumber exists in the state
    const hasFrame = state.generatedFrames[shotNumber!] !== undefined;
    const hasVideo = state.generatedVideos[shotNumber!] !== undefined;
    if (!hasFrame && !hasVideo) {
      sendJson(res, 400, { error: `Shot ${shotNumber} not found in generated frames or videos` });
      return;
    }

    if (type === "frame") {
      // Delete frame and its dependent video
      delete state.generatedFrames[shotNumber!];
      delete state.generatedVideos[shotNumber!];
      state.completedStages = state.completedStages.filter(
        s => s !== "frame_generation" && s !== "video_generation" && s !== "assembly"
      );
      earliestStage = "frame_generation";
    } else if (type === "start_frame") {
      // Delete start frame → also cascade to end frame (end uses start as reference) and video
      if (state.generatedFrames[shotNumber!]) {
        state.generatedFrames[shotNumber!].start = undefined;
        state.generatedFrames[shotNumber!].end = undefined;
      }
      delete state.generatedVideos[shotNumber!];
      state.completedStages = state.completedStages.filter(
        s => s !== "frame_generation" && s !== "video_generation" && s !== "assembly"
      );
      earliestStage = "frame_generation";
    } else if (type === "end_frame") {
      // Delete end frame only → cascade to video
      if (state.generatedFrames[shotNumber!]) {
        state.generatedFrames[shotNumber!].end = undefined;
      }
      delete state.generatedVideos[shotNumber!];
      state.completedStages = state.completedStages.filter(
        s => s !== "frame_generation" && s !== "video_generation" && s !== "assembly"
      );
      earliestStage = "frame_generation";
    } else {
      // type === "video"
      delete state.generatedVideos[shotNumber!];
      state.completedStages = state.completedStages.filter(
        s => s !== "video_generation" && s !== "assembly"
      );
      earliestStage = "video_generation";
    }
  }

  // Set currentStage to the earliest cleared stage
  state.currentStage = earliestStage;

  // Save the cleared state
  await saveState({ state });

  const itemLabel = type === "asset" ? `asset ${assetKey}` : `${type} for shot ${shotNumber}`;
  console.log(`[handleRedoItem] Cleared ${itemLabel}. currentStage=${earliestStage}, completedStages=[${state.completedStages.join(', ')}]`);

  // Update run record
  const updatedRecord = runStore.patch(runId, {
    status: "queued",
    completedAt: undefined,
    error: undefined,
    currentStage: earliestStage,
    completedStages: state.completedStages,
  }) ?? run;

  // Emit events
  emitRunStatusEvent(runId, "queued");
  emitLogEvent(runId, `Redoing ${itemLabel}`);
  startRunStateMonitor(runId);
  console.log('[handleRedoItem] Starting new pipeline for ' + runId + ' from stage ' + earliestStage);
  setImmediate(() => {
    void runInBackground(runId, true);
  });

  sendJson(res, 200, { run: toRunResponse(updatedRecord), type, ...(shotNumber !== undefined && { shotNumber }), ...(assetKey !== undefined && { assetKey }) });
}

async function handleStopRun(
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  console.log('[handleStopRun] Stop requested for run ' + runId);

  const existingPipeline = runningPipelines.get(runId);
  if (!existingPipeline) {
    console.log('[handleStopRun] No running pipeline for ' + runId);
    sendJson(res, 200, { message: "No running pipeline to stop" });
    return;
  }

  console.log('[handleStopRun] Interrupting pipeline for ' + runId + '...');
  setInterrupted(true);

  const timeoutPromise = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 30_000));
  const result = await Promise.race([
    existingPipeline.then(() => 'done' as const),
    timeoutPromise,
  ]);

  if (result === 'timeout') {
    console.warn('[handleStopRun] Pipeline for ' + runId + ' did not stop within 30s, force-removing');
    runningPipelines.delete(runId);
    setTimeout(() => setInterrupted(false), 5_000);
  } else {
    console.log('[handleStopRun] Pipeline for ' + runId + ' stopped successfully');
    setInterrupted(false);
  }

  sendJson(res, 200, { message: "Pipeline stopped" });
}

async function handleSetReviewMode(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  const body = await readJsonBody(req);
  const reviewMode = parseBoolean(
    (body as Record<string, unknown> | null)?.reviewMode,
    run.options.reviewMode ?? true,
  );

  const updatedOptions = { ...run.options, reviewMode };
  const updatedRecord = runStore.patch(runId, { options: updatedOptions });

  sendJson(res, 200, { run: toRunResponse(updatedRecord ?? run) });
}

async function handleContinueRun(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  if (isRunActivelyExecuting(run.status)) {
    sendRunMutationLockedResponse(res, run);
    return;
  }

  const state = loadState(run.outputDir);
  if (!state) {
    sendJson(res, 409, { error: "Run state is not available" });
    return;
  }

  if (!state.awaitingUserReview) {
    sendJson(res, 409, { error: "Run is not awaiting review" });
    return;
  }

  if (state.continueRequested) {
    sendJson(res, 202, {
      run: toRunResponse(run),
      message: "Continue already requested",
    });
    return;
  }

  await readJsonBody(req);
  const stage = parseStageName(state.currentStage, "current stage");
  const decidedAt = new Date().toISOString();
  const instructionCount =
    (state.pendingStageInstructions[stage] ?? []).length;

  state.continueRequested = true;
  state.decisionHistory.push({
    stage,
    decision: "continue",
    decidedAt,
    instructionCount,
  });
  await saveState({ state });

  const updatedRecord = runStore.patch(runId, {
    status: "queued",
    completedAt: undefined,
    error: undefined,
    currentStage: state.currentStage,
    completedStages: state.completedStages,
  }) ?? run;

  emitRunStatusEvent(runId, "queued");
  emitLogEvent(runId, `Continue requested for stage ${stage}`);
  startRunStateMonitor(runId);
  setImmediate(() => {
    void runInBackground(runId, true);
  });

  sendJson(res, 202, {
    run: toRunResponse(updatedRecord),
    decision: {
      stage,
      decidedAt,
      instructionCount,
    },
  });
}

async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathParts = url.pathname.split("/").filter(Boolean);

  try {
    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "GET") {
      const webAsset = WEB_ASSET_BY_PATH[url.pathname];
      if (webAsset) {
        const served = sendStaticFile(
          res,
          webAsset.filePath,
          webAsset.contentType,
        );
        if (served) {
          return;
        }
      }
    }

    if (method === "POST" && url.pathname === "/runs") {
      await handleCreateRun(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/runs") {
      const runs = runStore.list().map((run) => toRunResponse(run));
      sendJson(res, 200, { runs });
      return;
    }

    if (method === "POST" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "instructions") {
      const runId = decodeURIComponent(pathParts[1]);
      await handleSubmitInstruction(req, res, runId);
      return;
    }

    if (method === "POST" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "continue") {
      const runId = decodeURIComponent(pathParts[1]);
      await handleContinueRun(req, res, runId);
      return;
    }

    if (method === "POST" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "retry") {
      const runId = decodeURIComponent(pathParts[1]);
      await handleRetryRun(req, res, runId);
      return;
    }

    if (method === "POST" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "redo") {
      const runId = decodeURIComponent(pathParts[1]);
      await handleRedoRun(req, res, runId, url);
      return;
    }

    if (method === "POST" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "redo-item") {
      const runId = decodeURIComponent(pathParts[1]);
      await handleRedoItem(req, res, runId);
      return;
    }

    if (method === "POST" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "stop") {
      const runId = decodeURIComponent(pathParts[1]);
      await handleStopRun(req, res, runId);
      return;
    }

    if (method === "POST" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "review-mode") {
      const runId = decodeURIComponent(pathParts[1]);
      await handleSetReviewMode(req, res, runId);
      return;
    }

    if (method === "GET" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "events") {
      const runId = decodeURIComponent(pathParts[1]);
      streamRunEvents(req, res, runId, url);
      return;
    }

    if (method === "GET" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "assets") {
      const runId = decodeURIComponent(pathParts[1]);
      const run = runStore.get(runId);
      if (!run) {
        sendJson(res, 404, { error: `Run not found: ${runId}` });
        return;
      }

      const state = loadState(run.outputDir);
      const assets = state ? buildAssetFeed(runId, state) : [];
      sendJson(res, 200, { runId, assets });
      return;
    }

    if (method === "GET" && pathParts.length >= 4 && pathParts[0] === "runs" && pathParts[2] === "media") {
      const runId = decodeURIComponent(pathParts[1]);
      const run = runStore.get(runId);
      if (!run) {
        sendJson(res, 404, { error: `Run not found: ${runId}` });
        return;
      }

      const mediaPath = resolveMediaPathForRun(run, pathParts.slice(3));
      if (!mediaPath) {
        sendJson(res, 400, { error: "Invalid media path" });
        return;
      }
      if (!existsSync(mediaPath)) {
        sendJson(res, 404, { error: "Media file not found" });
        return;
      }

      let stats;
      try {
        stats = statSync(mediaPath);
        if (!stats.isFile()) {
          sendJson(res, 404, { error: "Media file not found" });
          return;
        }
      } catch {
        sendJson(res, 404, { error: "Media file not found" });
        return;
      }

      const fileSize = stats.size;
      const rangeHeader = req.headers.range;

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", detectMimeType(mediaPath));
      res.setHeader("Cache-Control", "no-store");

      if (!rangeHeader) {
        // No Range header: return full file with 200 OK
        res.statusCode = 200;
        res.setHeader("Content-Length", fileSize);
        const stream = createReadStream(mediaPath);
        stream.on("error", () => {
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end();
          }
        });
        stream.pipe(res);
        return;
      }

      // Parse Range header (format: bytes=START-END or bytes=-SUFFIX)
      const rangeMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!rangeMatch || (rangeMatch[1] === "" && rangeMatch[2] === "")) {
        // Invalid range format
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        res.end();
        return;
      }

      const startStr = rangeMatch[1];
      const endStr = rangeMatch[2];

      let start: number;
      let end: number;

      // Handle suffix range (bytes=-N means last N bytes)
      if (startStr === "" && endStr !== "") {
        const suffixLength = parseInt(endStr, 10);
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
      } else {
        start = startStr ? parseInt(startStr, 10) : 0;
        end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      }

      // Validate range
      if (start >= fileSize || start > end) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        res.end();
        return;
      }

      // Clamp end to fileSize - 1 (RFC 7233 compliance)
      if (end >= fileSize) {
        end = fileSize - 1;
      }

      // Return 206 Partial Content
      res.statusCode = 206;
      const contentLength = end - start + 1;
      res.setHeader("Content-Length", contentLength);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);

      const stream = createReadStream(mediaPath, { start, end });
      stream.on("error", () => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end();
        }
      });
      stream.pipe(res);
      return;
    }

    if (method === "GET" && pathParts.length === 3 && pathParts[0] === "runs" && pathParts[2] === "state") {
      const runId = decodeURIComponent(pathParts[1]);
      const run = runStore.get(runId);
      if (!run) {
        sendJson(res, 404, { error: `Run not found: ${runId}` });
        return;
      }

      const state = loadState(run.outputDir);
      if (!state) {
        sendJson(res, 200, { storyAnalysis: null });
        return;
      }

      sendJson(res, 200, {
        storyAnalysis: state.storyAnalysis,
        currentStage: state.currentStage,
        completedStages: state.completedStages,
        assetLibrary: state.assetLibrary,
      });
      return;
    }

    if (method === "GET" && pathParts.length === 2 && pathParts[0] === "runs") {
      const runId = decodeURIComponent(pathParts[1]);
      const run = runStore.get(runId);
      if (!run) {
        sendJson(res, 404, { error: `Run not found: ${runId}` });
        return;
      }

      sendJson(res, 200, toRunResponse(run));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    sendJson(res, 400, { error: message });
  }
}

const portFromEnv = process.env.PORT ? Number(process.env.PORT) : 3000;
const port = Number.isFinite(portFromEnv) ? portFromEnv : 3000;

const server = createServer((req, res) => {
  void requestHandler(req, res);
});

function registerProcessLifecycleHandlers(apiServer: typeof server): void {
  const initiateShutdown = (reason: string, exitCode: number): void => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    shutdownReason = reason;
    appendServerDiagnostic("server_shutdown", {
      reason,
      exitCode,
      activeRuns: listActiveRunsForDiagnostics(),
    });

    const exitTimer = setTimeout(() => {
      process.exit(exitCode);
    }, FATAL_SHUTDOWN_TIMEOUT_MS);
    exitTimer.unref();

    apiServer.close((error) => {
      if (error) {
        appendServerDiagnostic("server_shutdown_close_error", {
          reason,
          error: normalizeDiagnosticValue(error),
        });
      }
      process.exit(exitCode);
    });
  };

  process.on("SIGINT", () => {
    initiateShutdown("signal:SIGINT", 130);
  });

  process.on("SIGTERM", () => {
    initiateShutdown("signal:SIGTERM", 143);
  });

  process.on("uncaughtException", (error) => {
    appendServerDiagnostic("fatal_uncaught_exception", {
      reason: shutdownReason,
      error: normalizeDiagnosticValue(error),
      activeRuns: listActiveRunsForDiagnostics(),
    });
    initiateShutdown("fatal:uncaught_exception", 1);
  });

  process.on("unhandledRejection", (reason) => {
    appendServerDiagnostic("fatal_unhandled_rejection", {
      reason: shutdownReason,
      rejection: normalizeDiagnosticValue(reason),
      activeRuns: listActiveRunsForDiagnostics(),
    });
    initiateShutdown("fatal:unhandled_rejection", 1);
  });

  process.on("exit", (code) => {
    if (processExitLogged) {
      return;
    }
    processExitLogged = true;
    appendServerDiagnostic("process_exit", {
      code,
      reason: shutdownReason ?? "process_exit",
    });
  });
}

async function resumeStaleRuns(): Promise<void> {
  const allRuns = runStore.list();
  const staleRuns = allRuns.filter(
    (run) => run.status === "queued" || run.status === "running" || run.status === "awaiting_review"
  );

  if (staleRuns.length === 0) {
    console.log("[Recovery] No stale runs to recover");
    return;
  }

  console.log(`[Recovery] Found ${staleRuns.length} stale run(s) to process`);
  let recovered = 0;
  let awaitingReview = 0;
  let failed = 0;

  for (const run of staleRuns) {
    try {
      const state = loadState(run.outputDir);

      if (!state) {
        // No state file found - mark as failed
        runStore.patch(run.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "Server restarted; no saved state to resume from",
        });
        console.log(`[Recovery] Run ${run.id} marked failed — no state to resume`);
        appendServerDiagnostic("run_recovery_failed", {
          runId: run.id,
          outputDir: run.outputDir,
          reason: "no_state",
        });
        failed++;
        continue;
      }

      if (state.awaitingUserReview && state.continueRequested) {
        // User already clicked "Continue" before crash - resume the pipeline
        state.continueRequested = false;
        state.awaitingUserReview = false;
        await saveState({ state });

        runStore.patch(run.id, {
          status: "queued",
          currentStage: state.currentStage,
          completedStages: state.completedStages,
        });
        startRunStateMonitor(run.id);
        setImmediate(() => {
          void runInBackground(run.id, true);
        });
        console.log(`[Recovery] Run ${run.id} auto-resuming after continue request`);
        appendServerDiagnostic("run_recovery_resumed_after_continue", {
          runId: run.id,
          outputDir: run.outputDir,
          currentStage: state.currentStage,
          completedStages: state.completedStages,
        });
        recovered++;
      } else if (state.awaitingUserReview) {
        // Run was awaiting review - restore to awaiting_review status
        runStore.patch(run.id, {
          status: "awaiting_review",
          currentStage: state.currentStage,
          completedStages: state.completedStages,
        });
        console.log(`[Recovery] Run ${run.id} restored to awaiting_review`);
        appendServerDiagnostic("run_recovery_awaiting_review", {
          runId: run.id,
          outputDir: run.outputDir,
          currentStage: state.currentStage,
        });
        awaitingReview++;
      } else {
        // Run was in progress - resume execution
        runStore.patch(run.id, {
          status: "queued",
          currentStage: state.currentStage,
          completedStages: state.completedStages,
        });
        startRunStateMonitor(run.id);
        setImmediate(() => {
          void runInBackground(run.id, true);
        });
        console.log(`[Recovery] Run ${run.id} auto-resuming from last checkpoint`);
        appendServerDiagnostic("run_recovery_resumed", {
          runId: run.id,
          outputDir: run.outputDir,
          currentStage: state.currentStage,
          completedStages: state.completedStages,
        });
        recovered++;
      }
    } catch (error) {
      // Individual recovery failure shouldn't block others
      const message = error instanceof Error ? error.message : String(error);
      runStore.patch(run.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: `Recovery failed: ${message}`,
      });
      console.error(`[Recovery] Failed to recover run ${run.id}:`, error);
      appendServerDiagnostic("run_recovery_error", {
        runId: run.id,
        outputDir: run.outputDir,
        error: normalizeDiagnosticValue(error),
      });
      failed++;
    }
  }

  console.log(
    `[Recovery] Processed ${staleRuns.length} stale runs: ${recovered} resumed, ${awaitingReview} awaiting review, ${failed} failed`
  );
  appendServerDiagnostic("run_recovery_complete", {
    total: staleRuns.length,
    resumed: recovered,
    awaitingReview,
    failed,
  });
}

registerProcessLifecycleHandlers(server);

server.listen(port, () => {
  appendServerDiagnostic("server_startup", {
    port,
  });
  console.log(`API server listening on http://localhost:${port}`);

  // Resume stale runs after server is ready
  setImmediate(() => {
    void resumeStaleRuns();
  });
});
