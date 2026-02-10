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

import { runPipeline } from "./orchestrator";
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
import type { PipelineOptions, PipelineState } from "./types";

const STAGE_ORDER = [
  "analysis",
  "shot_planning",
  "asset_generation",
  "frame_generation",
  "video_generation",
  "assembly",
] as const;

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
const WEB_ROOT = resolve(process.cwd(), "src", "web");

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

function getNextPendingStage(state: PipelineState): string | null {
  for (const stage of STAGE_ORDER) {
    if (!state.completedStages.includes(stage)) {
      return stage;
    }
  }
  return null;
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

  runStore.patch(runId, {
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
  });
  emitRunStatusEvent(runId, "running");
  startRunStateMonitor(runId);

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
    runStore.patch(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: message,
      currentStage: state?.currentStage ?? record.currentStage,
      completedStages: state?.completedStages ?? record.completedStages,
    });
    emitRunStatusEvent(runId, "failed", message);
  } finally {
    stopRunStateMonitor(runId);
  }
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

  if (!run.options.reviewMode) {
    sendJson(res, 409, { error: "Run is not configured for review mode" });
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
  const stage =
    parsedRequest.stage ?? getNextPendingStage(state);
  if (!stage) {
    sendJson(res, 409, { error: "No pending stage available for instruction" });
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
  pollRunState(runId);
  emitLogEvent(runId, `Instruction added for stage ${stage}`);

  const updatedRecord = runStore.patch(runId, {
    currentStage: state.currentStage,
    completedStages: state.completedStages,
  }) ?? run;

  sendJson(res, 200, {
    run: toRunResponse(updatedRecord),
    stage,
    instructionCount: state.pendingStageInstructions[stage].length,
    submittedAt,
  });
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

  if (!run.options.reviewMode) {
    sendJson(res, 409, { error: "Run is not configured for review mode" });
    return;
  }

  if (run.status === "running" || run.status === "queued") {
    sendJson(res, 409, { error: "Run is already in progress" });
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

      try {
        const stats = statSync(mediaPath);
        if (!stats.isFile()) {
          sendJson(res, 404, { error: "Media file not found" });
          return;
        }
      } catch {
        sendJson(res, 404, { error: "Media file not found" });
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", detectMimeType(mediaPath));
      res.setHeader("Cache-Control", "no-store");
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

server.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});
