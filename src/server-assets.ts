import { existsSync, statSync } from "fs";
import { extname, isAbsolute, relative, resolve, sep } from "path";

import type { PipelineState } from "./types";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": "application/json; charset=utf-8",
};

export type AssetFeedItemType = "asset" | "frame_start" | "frame_end" | "video" | "document";

export interface AssetFeedItem {
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

export interface AssetFeedItemInput {
  runId: string;
  outputDir: string;
  id: string;
  type: AssetFeedItemType;
  key: string;
  path: string;
  shotNumber?: number;
  variant?: string;
  fallbackTimestamp: string;
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

export function createAssetFeedItem(params: AssetFeedItemInput): AssetFeedItem {
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

export function buildAssetFeed(runId: string, state: PipelineState): AssetFeedItem[] {
  const fallbackTimestamp = state.lastSavedAt || new Date().toISOString();
  const items: AssetFeedItem[] = [];

  // Add story_analysis.json as a document asset if it exists
  if (state.storyAnalysis) {
    items.push(
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

  if (state.completedStages.includes("assembly")) {
    items.push(
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

  items.sort((a, b) => {
    const byTimestamp = a.createdAt.localeCompare(b.createdAt);
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    return a.id.localeCompare(b.id);
  });

  return items;
}

export function resolveMediaPathForRun(outputDir: string, encodedSegments: string[]): string | null {
  if (encodedSegments.length === 0) {
    return null;
  }

  const decodedPath = encodedSegments
    .map((segment) => decodeURIComponent(segment))
    .join("/");
  const candidate = resolve(outputDir, decodedPath);
  const runRoot = resolve(outputDir);
  const runRootPrefix = `${runRoot}${sep}`;

  if (candidate !== runRoot && !candidate.startsWith(runRootPrefix)) {
    return null;
  }
  return candidate;
}

export function detectMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
