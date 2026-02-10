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
import { extname, isAbsolute, join, relative, resolve, sep } from "path";

import { runPipeline } from "./orchestrator";
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

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": "application/json; charset=utf-8",
};

const EVENT_HISTORY_LIMIT = 2_000;
const STATE_POLL_INTERVAL_MS = 750;
const SSE_HEARTBEAT_MS = 15_000;

type RunStatus = "queued" | "running" | "completed" | "failed";
type AssetFeedItemType = "asset" | "frame_start" | "frame_end" | "video";
type RunEventLevel = "info" | "error";
type RunEventType = "run_status" | "stage_transition" | "stage_completed" | "asset_generated" | "log";

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
}

interface AssetFeedItem {
  id: string;
  runId: string;
  type: AssetFeedItemType;
  key: string;
  shotNumber?: number;
  variant?: string;
  path: string;
  previewUrl?: string;
  createdAt: string;
}

interface RunEvent {
  id: number;
  runId: string;
  type: RunEventType;
  timestamp: string;
  payload: Record<string, unknown>;
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

const RUN_DB_DIR = resolve(process.env.STORYTOVIDEO_RUN_DB_DIR ?? "./output/api-server");
const RUN_DB_PATH = join(RUN_DB_DIR, "runs.json");
const RUN_OUTPUT_ROOT = resolve(process.env.STORYTOVIDEO_RUN_OUTPUT_ROOT ?? "./output/runs");

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
const runEventsByRunId = new Map<string, RunEvent[]>();
const eventSequenceByRunId = new Map<string, number>();
const eventClientsByRunId = new Map<string, Set<ServerResponse>>();
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
      reviewMode: parseBoolean(options.reviewMode, false),
    },
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
    reviewMode: options.reviewMode ?? false,
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

function sanitizeGeneratedPath(pathValue: string): string {
  return pathValue.replace(/^\[dry-run\]\s*/, "");
}

function resolveGeneratedPath(outputDir: string, pathValue: string): string | null {
  if (pathValue.startsWith("[dry-run]")) {
    return null;
  }

  const sanitized = sanitizeGeneratedPath(pathValue);
  const candidate = isAbsolute(sanitized) ? resolve(sanitized) : resolve(outputDir, sanitized);

  if (!existsSync(candidate)) {
    return null;
  }
  return candidate;
}

function toRunRelativePath(outputDir: string, filePath: string): string | null {
  const runRoot = resolve(outputDir);
  const candidate = resolve(filePath);
  const runRootPrefix = `${runRoot}${sep}`;
  if (candidate !== runRoot && !candidate.startsWith(runRootPrefix)) {
    return null;
  }

  const rel = relative(runRoot, candidate);
  return rel.split(sep).join("/");
}

function toPreviewUrl(runId: string, outputDir: string, filePath: string): string | undefined {
  const rel = toRunRelativePath(outputDir, filePath);
  if (!rel || rel.length === 0) {
    return undefined;
  }

  const encodedPath = rel
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/runs/${encodeURIComponent(runId)}/media/${encodedPath}`;
}

function toTimestamp(filePath: string | null, fallback: string): string {
  if (!filePath) {
    return fallback;
  }

  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return fallback;
  }
}

function parseAssetVariant(assetKey: string): string | undefined {
  const parts = assetKey.split(":");
  return parts.length >= 3 ? parts[2] : undefined;
}

function createAssetFeedItem(params: {
  runId: string;
  outputDir: string;
  id: string;
  type: AssetFeedItemType;
  key: string;
  path: string;
  shotNumber?: number;
  variant?: string;
  fallbackTimestamp: string;
}): AssetFeedItem {
  const {
    runId,
    outputDir,
    id,
    type,
    key,
    path,
    shotNumber,
    variant,
    fallbackTimestamp,
  } = params;

  const absolutePath = resolveGeneratedPath(outputDir, path);
  return {
    id,
    runId,
    type,
    key,
    shotNumber,
    variant,
    path,
    previewUrl: absolutePath ? toPreviewUrl(runId, outputDir, absolutePath) : undefined,
    createdAt: toTimestamp(absolutePath, fallbackTimestamp),
  };
}

function buildAssetFeed(runId: string, state: PipelineState): AssetFeedItem[] {
  const fallbackTimestamp = state.lastSavedAt || new Date().toISOString();
  const items: AssetFeedItem[] = [];

  for (const [assetKey, assetPath] of Object.entries(state.generatedAssets)) {
    items.push(
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

  for (const [shotKey, frameSet] of Object.entries(state.generatedFrames)) {
    const shotNumber = Number(shotKey);
    if (frameSet?.start) {
      items.push(
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
    if (frameSet?.end) {
      items.push(
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

  for (const [shotKey, videoPath] of Object.entries(state.generatedVideos)) {
    items.push(
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

  items.sort((a, b) => {
    const byTimestamp = a.createdAt.localeCompare(b.createdAt);
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    return a.id.localeCompare(b.id);
  });

  return items;
}

function nextEventId(runId: string): number {
  const next = (eventSequenceByRunId.get(runId) ?? 0) + 1;
  eventSequenceByRunId.set(runId, next);
  return next;
}

function writeSseEvent(res: ServerResponse, event: RunEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function emitRunEvent(runId: string, type: RunEventType, payload: Record<string, unknown>): void {
  const event: RunEvent = {
    id: nextEventId(runId),
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload,
  };

  const history = runEventsByRunId.get(runId) ?? [];
  history.push(event);
  if (history.length > EVENT_HISTORY_LIMIT) {
    history.splice(0, history.length - EVENT_HISTORY_LIMIT);
  }
  runEventsByRunId.set(runId, history);

  const clients = eventClientsByRunId.get(runId);
  if (!clients) {
    return;
  }

  for (const client of [...clients]) {
    if (client.writableEnded) {
      clients.delete(client);
      continue;
    }
    writeSseEvent(client, event);
  }

  if (clients.size === 0) {
    eventClientsByRunId.delete(runId);
  }
}

function emitLogEvent(runId: string, message: string, level: RunEventLevel = "info"): void {
  emitRunEvent(runId, "log", {
    level,
    message,
  });
}

function emitRunStatusEvent(runId: string, status: RunStatus, error?: string): void {
  emitRunEvent(runId, "run_status", {
    status,
    ...(error ? { error } : {}),
  });
  const suffix = error ? `: ${error}` : "";
  emitLogEvent(runId, `Run status changed to ${status}${suffix}`, status === "failed" ? "error" : "info");
}

function emitAssetEvent(runId: string, item: AssetFeedItem): void {
  emitRunEvent(runId, "asset_generated", {
    asset: item,
  });
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

function parseLastEventId(req: IncomingMessage, url: URL): number | undefined {
  const headerValue = req.headers["last-event-id"];
  const rawHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const raw = rawHeader ?? url.searchParams.get("lastEventId") ?? undefined;
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function streamRunEvents(req: IncomingMessage, res: ServerResponse, runId: string, url: URL): void {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: `Run not found: ${runId}` });
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.write("retry: 2000\n\n");

  const clients = eventClientsByRunId.get(runId) ?? new Set<ServerResponse>();
  clients.add(res);
  eventClientsByRunId.set(runId, clients);

  const lastEventId = parseLastEventId(req, url);
  const history = runEventsByRunId.get(runId) ?? [];
  for (const event of history) {
    if (lastEventId === undefined || event.id > lastEventId) {
      writeSseEvent(res, event);
    }
  }

  res.write(
    `event: connected\ndata: ${JSON.stringify({ runId, timestamp: new Date().toISOString() })}\n\n`,
  );

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    const existingClients = eventClientsByRunId.get(runId);
    if (!existingClients) {
      return;
    }
    existingClients.delete(res);
    if (existingClients.size === 0) {
      eventClientsByRunId.delete(runId);
    }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
}

function resolveMediaPathForRun(run: RunRecord, encodedSegments: string[]): string | null {
  if (encodedSegments.length === 0) {
    return null;
  }

  const decodedPath = encodedSegments
    .map((segment) => decodeURIComponent(segment))
    .join("/");
  const candidate = resolve(run.outputDir, decodedPath);
  const runRoot = resolve(run.outputDir);
  const runRootPrefix = `${runRoot}${sep}`;

  if (candidate !== runRoot && !candidate.startsWith(runRootPrefix)) {
    return null;
  }
  return candidate;
}

function detectMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
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

async function runInBackground(runId: string): Promise<void> {
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
    await runPipeline(record.storyText, record.options);
    pollRunState(runId);
    const state = loadState(record.outputDir);
    runStore.patch(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      currentStage: state?.currentStage ?? record.currentStage,
      completedStages: state?.completedStages ?? record.completedStages,
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

    if (method === "POST" && url.pathname === "/runs") {
      await handleCreateRun(req, res);
      return;
    }

    if (method === "GET" && url.pathname === "/runs") {
      const runs = runStore.list().map((run) => toRunResponse(run));
      sendJson(res, 200, { runs });
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
