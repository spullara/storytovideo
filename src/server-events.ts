import type { IncomingMessage, ServerResponse } from "http";

import type { AssetFeedItem } from "./server-assets";

const EVENT_HISTORY_LIMIT = 2_000;
const SSE_HEARTBEAT_MS = 15_000;

export type RunEventLevel = "info" | "error";
export type RunEventType = "run_status" | "stage_transition" | "stage_completed" | "asset_generated" | "log";

export interface RunEvent {
  id: number;
  runId: string;
  type: RunEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class RunEventStream {
  private readonly runEventsByRunId = new Map<string, RunEvent[]>();
  private readonly eventSequenceByRunId = new Map<string, number>();
  private readonly eventClientsByRunId = new Map<string, Set<ServerResponse>>();

  emitRunEvent(runId: string, type: RunEventType, payload: Record<string, unknown>): void {
    const event: RunEvent = {
      id: this.nextEventId(runId),
      runId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };

    const history = this.runEventsByRunId.get(runId) ?? [];
    history.push(event);
    if (history.length > EVENT_HISTORY_LIMIT) {
      history.splice(0, history.length - EVENT_HISTORY_LIMIT);
    }
    this.runEventsByRunId.set(runId, history);

    const clients = this.eventClientsByRunId.get(runId);
    if (!clients) {
      return;
    }

    for (const client of [...clients]) {
      if (client.writableEnded) {
        clients.delete(client);
        continue;
      }
      this.writeSseEvent(client, event);
    }

    if (clients.size === 0) {
      this.eventClientsByRunId.delete(runId);
    }
  }

  emitLogEvent(runId: string, message: string, level: RunEventLevel = "info"): void {
    this.emitRunEvent(runId, "log", {
      level,
      message,
    });
  }

  emitRunStatusEvent(runId: string, status: string, error?: string): void {
    this.emitRunEvent(runId, "run_status", {
      status,
      ...(error ? { error } : {}),
    });
    const suffix = error ? `: ${error}` : "";
    this.emitLogEvent(
      runId,
      `Run status changed to ${status}${suffix}`,
      status === "failed" ? "error" : "info",
    );
  }

  emitAssetEvent(runId: string, item: AssetFeedItem): void {
    this.emitRunEvent(runId, "asset_generated", {
      asset: item,
    });
  }

  streamRunEvents(req: IncomingMessage, res: ServerResponse, runId: string, url: URL): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write("retry: 2000\n\n");

    const clients = this.eventClientsByRunId.get(runId) ?? new Set<ServerResponse>();
    clients.add(res);
    this.eventClientsByRunId.set(runId, clients);

    const lastEventId = this.parseLastEventId(req, url);
    const history = this.runEventsByRunId.get(runId) ?? [];
    for (const event of history) {
      if (lastEventId === undefined || event.id > lastEventId) {
        this.writeSseEvent(res, event);
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
      const existingClients = this.eventClientsByRunId.get(runId);
      if (!existingClients) {
        return;
      }
      existingClients.delete(res);
      if (existingClients.size === 0) {
        this.eventClientsByRunId.delete(runId);
      }
    };

    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  private nextEventId(runId: string): number {
    const next = (this.eventSequenceByRunId.get(runId) ?? 0) + 1;
    this.eventSequenceByRunId.set(runId, next);
    return next;
  }

  private writeSseEvent(res: ServerResponse, event: RunEvent): void {
    res.write(`id: ${event.id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private parseLastEventId(req: IncomingMessage, url: URL): number | undefined {
    const headerValue = req.headers["last-event-id"];
    const rawHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const raw = rawHeader ?? url.searchParams.get("lastEventId") ?? undefined;
    if (!raw) {
      return undefined;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
