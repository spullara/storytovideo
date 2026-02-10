import "dotenv/config";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join, resolve } from "path";

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

type RunStatus = "queued" | "running" | "completed" | "failed";

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

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    error: undefined,
  });

  try {
    await runPipeline(record.storyText, record.options);
    const state = loadState(record.outputDir);
    runStore.patch(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
      currentStage: state?.currentStage ?? record.currentStage,
      completedStages: state?.completedStages ?? record.completedStages,
    });
  } catch (error) {
    const state = loadState(record.outputDir);
    runStore.patch(runId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      currentStage: state?.currentStage ?? record.currentStage,
      completedStages: state?.completedStages ?? record.completedStages,
    });
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
