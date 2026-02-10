const STAGE_ORDER = [
  "analysis",
  "shot_planning",
  "asset_generation",
  "frame_generation",
  "video_generation",
  "assembly",
];

const MAX_EVENTS = 300;
const POLL_INTERVAL_MS = 2_500;
const REFRESH_DEBOUNCE_MS = 220;

const state = {
  runs: [],
  activeRunId: null,
  activeRun: null,
  assetsById: new Map(),
  events: [],
  eventSource: null,
  pollTimer: null,
  refreshTimer: null,
};

const elements = {
  runView: getElement("run-view"),
  createView: getElement("create-view"),
  newRunButton: getElement("new-run-button"),
  createRunForm: getElement("create-run-form"),
  storyText: getElement("story-text"),
  createRunButton: getElement("create-run-button"),
  runSelect: getElement("run-select"),
  refreshRunsButton: getElement("refresh-runs-button"),
  runId: getElement("run-id"),
  runStatus: getElement("run-status"),
  runStage: getElement("run-stage"),
  runProgress: getElement("run-progress"),
  runOutput: getElement("run-output"),
  runError: getElement("run-error"),
  connectionStatus: getElement("connection-status"),
  stageList: getElement("stage-list"),
  reviewAwaiting: getElement("review-awaiting"),
  reviewContinueState: getElement("review-continue-state"),
  reviewPendingCount: getElement("review-pending-count"),
  reviewLockMessage: getElement("review-lock-message"),
  instructionForm: getElement("instruction-form"),
  instructionText: getElement("instruction-text"),
  instructionStage: getElement("instruction-stage"),
  submitInstructionButton: getElement("submit-instruction-button"),
  continueButton: getElement("continue-button"),
  eventsList: getElement("events-list"),
  assetsList: getElement("assets-list"),
  stageOutputSection: getElement("stage-output-section"),
  stageOutput: getElement("stage-output"),
};

function getElement(id) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element;
}

function showRunView() {
  elements.runView.style.display = "";
  elements.createView.style.display = "none";
}

function showCreateView() {
  elements.runView.style.display = "none";
  elements.createView.style.display = "";
}

function formatStageLabel(stage) {
  return stage.replace(/_/g, " ");
}

function formatTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function escapeHtml(text) {
  if (typeof text !== "string") {
    return "";
  }
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function isRunActivelyExecuting(run) {
  return Boolean(run) && (run.status === "queued" || run.status === "running");
}

function isRunReviewSafe(run) {
  return Boolean(run) && run.status === "awaiting_review" && Boolean(run.review?.awaitingUserReview);
}

function setReviewLockMessage(message, tone = "locked") {
  elements.reviewLockMessage.textContent = message;
  elements.reviewLockMessage.classList.remove("lock-message-locked", "lock-message-ready");
  elements.reviewLockMessage.classList.add(tone === "ready" ? "lock-message-ready" : "lock-message-locked");
}

function setGlobalError(message) {
  if (!message) {
    elements.runError.textContent = "";
    elements.runError.classList.add("hidden");
    return;
  }
  elements.runError.textContent = message;
  elements.runError.classList.remove("hidden");
}

function setConnectionStatus(value) {
  elements.connectionStatus.textContent = value;
}

async function requestJson(url, options = {}) {
  const config = { ...options };
  const headers = new Headers(config.headers ?? {});
  if (config.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  config.headers = headers;

  const response = await fetch(url, config);
  const raw = await response.text();
  let parsed = {};
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON response from ${url}`);
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return parsed;
}

function populateInstructionStageSelect() {
  for (const stage of STAGE_ORDER) {
    const option = document.createElement("option");
    option.value = stage;
    option.textContent = formatStageLabel(stage);
    elements.instructionStage.append(option);
  }
}

function renderRunSelect() {
  const current = state.activeRunId;
  elements.runSelect.replaceChildren();

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = state.runs.length > 0 ? "Select a run..." : "No runs found";
  elements.runSelect.append(emptyOption);

  for (const run of state.runs) {
    const option = document.createElement("option");
    option.value = run.id;
    option.textContent = `${run.id.slice(0, 8)}... (${run.status})`;
    elements.runSelect.append(option);
  }

  if (current && state.runs.some((run) => run.id === current)) {
    elements.runSelect.value = current;
  } else {
    elements.runSelect.value = "";
  }
}

function renderStageProgress() {
  elements.stageList.replaceChildren();
  const run = state.activeRun;

  for (const stage of STAGE_ORDER) {
    const item = document.createElement("li");
    item.textContent = formatStageLabel(stage);

    if (!run) {
      item.classList.add("stage-pending");
    } else if (run.completedStages.includes(stage)) {
      item.classList.add("stage-complete");
      item.textContent += " - complete";
    } else if (run.currentStage === stage) {
      item.classList.add("stage-current");
      item.textContent += " - current";
    } else {
      item.classList.add("stage-pending");
      item.textContent += " - pending";
    }

    elements.stageList.append(item);
  }
}

function renderStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status status-${status}`;
  badge.textContent = formatStageLabel(status);
  elements.runStatus.replaceChildren(badge);
}

function renderRunDetails() {
  const run = state.activeRun;
  if (!run) {
    elements.runId.textContent = "-";
    elements.runStatus.textContent = "idle";
    elements.runStage.textContent = "-";
    elements.runProgress.textContent = "0 / 6 (0%)";
    elements.runOutput.textContent = "-";
    elements.reviewAwaiting.textContent = "no";
    elements.reviewContinueState.textContent = "no";
    elements.reviewPendingCount.textContent = "0";
    elements.submitInstructionButton.disabled = true;
    elements.instructionText.disabled = true;
    elements.instructionStage.disabled = true;
    elements.continueButton.disabled = true;
    setReviewLockMessage("Select a run to inspect review control lock state.");
    renderStageProgress();
    return;
  }

  renderStatusBadge(run.status);
  elements.runId.textContent = run.id;
  elements.runStage.textContent = formatStageLabel(run.currentStage);
  elements.runProgress.textContent = `${run.progress.completed} / ${run.progress.total} (${run.progress.percent}%)`;
  elements.runOutput.textContent = run.outputDir;
  setGlobalError(run.error ? `Run error: ${run.error}` : "");

  const awaiting = Boolean(run.review?.awaitingUserReview);
  const continueRequested = Boolean(run.review?.continueRequested);
  const pendingCount = Number(run.review?.pendingInstructionCount ?? 0);

  elements.reviewAwaiting.textContent = awaiting ? "yes" : "no";
  elements.reviewContinueState.textContent = continueRequested ? "yes" : "no";
  elements.reviewPendingCount.textContent = String(pendingCount);

  const reviewSafe = isRunReviewSafe(run);
  elements.submitInstructionButton.disabled = !reviewSafe;
  elements.instructionText.disabled = !reviewSafe;
  elements.instructionStage.disabled = !reviewSafe;
  elements.continueButton.disabled = !reviewSafe || continueRequested;

  if (isRunActivelyExecuting(run)) {
    setReviewLockMessage(
      "Review controls are locked while this run is executing (queued/running). Interrupt and wait for status \"awaiting review\" to unlock.",
    );
  } else if (reviewSafe) {
    if (continueRequested) {
      setReviewLockMessage(
        "Run is in review-safe state. Continue has already been requested; you can still submit instructions.",
        "ready",
      );
    } else {
      setReviewLockMessage(
        "Run is in review-safe state. Submit instructions or continue to the next stage.",
        "ready",
      );
    }
  } else {
    setReviewLockMessage(
      `Review controls are unavailable while status is \"${formatStageLabel(run.status)}\". Controls unlock when status returns to \"awaiting review\" (including after interrupt).`,
    );
  }

  renderStageProgress();
}

function createEventEntry({ level = "info", title, message, timestamp }) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    title,
    message,
    timestamp: timestamp || new Date().toISOString(),
  };
}

function appendEvent(entry) {
  state.events.unshift(entry);
  if (state.events.length > MAX_EVENTS) {
    state.events.length = MAX_EVENTS;
  }
  renderEvents();
}

function renderEvents() {
  elements.eventsList.replaceChildren();

  if (state.events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "event-info";
    empty.textContent = "No events yet.";
    elements.eventsList.append(empty);
    return;
  }

  for (const eventEntry of state.events) {
    const item = document.createElement("li");
    item.className = eventEntry.level === "error" ? "event-error" : "event-info";

    const title = document.createElement("p");
    title.className = "event-title";
    title.textContent = eventEntry.title;
    item.append(title);

    const message = document.createElement("p");
    message.className = "event-message";
    message.textContent = eventEntry.message;
    item.append(message);

    const time = document.createElement("p");
    time.className = "event-time";
    time.textContent = formatTimestamp(eventEntry.timestamp);
    item.append(time);

    elements.eventsList.append(item);
  }
}

function renderAssets() {
  const items = [...state.assetsById.values()].sort((a, b) => {
    if (a.createdAt === b.createdAt) {
      return a.id.localeCompare(b.id);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });

  elements.assetsList.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No assets yet.";
    elements.assetsList.append(empty);
    return;
  }

  for (const asset of items) {
    const item = document.createElement("li");

    if (asset.type === "document") {
      // Document assets get a special icon/preview
      const preview = document.createElement("div");
      preview.className = "asset-preview asset-preview-document";
      preview.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
      `;
      item.append(preview);
    } else if (asset.previewUrl) {
      const isVideo = asset.type === "video" || asset.previewUrl.endsWith(".mp4") || asset.previewUrl.endsWith(".mov");
      if (isVideo) {
        const preview = document.createElement("video");
        preview.className = "asset-preview";
        preview.src = asset.previewUrl;
        preview.controls = true;
        preview.preload = "metadata";
        item.append(preview);
      } else {
        const preview = document.createElement("img");
        preview.className = "asset-preview";
        preview.src = asset.previewUrl;
        preview.alt = asset.key;
        preview.loading = "lazy";
        item.append(preview);
      }
    }

    const content = document.createElement("div");
    content.className = "asset-content";

    const title = document.createElement("p");
    title.className = "asset-title";
    if (asset.type === "document") {
      title.textContent = "Story Analysis";
    } else {
      title.textContent = `${asset.type}: ${asset.key}`;
    }
    content.append(title);

    const meta = document.createElement("p");
    meta.className = "asset-meta";
    if (asset.type === "document") {
      meta.textContent = `Document | ${formatTimestamp(asset.createdAt)}`;
    } else {
      const shot = asset.shotNumber !== undefined ? `shot ${asset.shotNumber}` : "run-level";
      meta.textContent = `${shot} | ${formatTimestamp(asset.createdAt)}`;
    }
    content.append(meta);

    const pathText = document.createElement("p");
    pathText.className = "asset-meta";
    pathText.textContent = asset.path;
    content.append(pathText);

    if (asset.previewUrl) {
      const link = document.createElement("a");
      link.className = "asset-link";
      link.href = asset.previewUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      if (asset.type === "document") {
        link.textContent = "View JSON";
      } else {
        link.textContent = "Open media";
      }
      content.append(link);
    }

    item.append(content);
    elements.assetsList.append(item);
  }
}

function scheduleRunRefresh() {
  if (state.refreshTimer) {
    return;
  }
  state.refreshTimer = window.setTimeout(() => {
    state.refreshTimer = null;
    void refreshRun({ silent: true });
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshRun({ silent = false } = {}) {
  if (!state.activeRunId) {
    return;
  }
  const runId = state.activeRunId;

  try {
    const run = await requestJson(`/runs/${encodeURIComponent(runId)}`);
    if (state.activeRunId !== runId) {
      return;
    }
    state.activeRun = run;
    renderRunDetails();
    void fetchAndRenderStageOutput({ silent });
  } catch (error) {
    if (!silent) {
      setGlobalError(`Failed to fetch run: ${error.message}`);
    }
  }
}

async function refreshAssets({ silent = false } = {}) {
  if (!state.activeRunId) {
    return;
  }
  const runId = state.activeRunId;

  try {
    const response = await requestJson(`/runs/${encodeURIComponent(runId)}/assets`);
    if (state.activeRunId !== runId) {
      return;
    }
    const nextAssets = new Map();
    const assets = Array.isArray(response.assets) ? response.assets : [];
    for (const asset of assets) {
      if (asset && typeof asset.id === "string") {
        nextAssets.set(asset.id, asset);
      }
    }
    state.assetsById = nextAssets;
    renderAssets();
  } catch (error) {
    if (!silent) {
      setGlobalError(`Failed to fetch assets: ${error.message}`);
    }
  }
}

async function fetchAndRenderStageOutput({ silent = false } = {}) {
  if (!state.activeRunId) {
    elements.stageOutputSection.style.display = "none";
    return;
  }
  const runId = state.activeRunId;

  try {
    const response = await requestJson(`/runs/${encodeURIComponent(runId)}/state`);
    if (state.activeRunId !== runId) {
      return;
    }

    const { storyAnalysis } = response;
    if (!storyAnalysis) {
      elements.stageOutputSection.style.display = "none";
      return;
    }

    // Build the stage output HTML
    let html = "";

    // Title and art style
    html += `<div class="stage-output-header">`;
    html += `<h3>${escapeHtml(storyAnalysis.title)}</h3>`;
    html += `<p class="muted">Art Style: ${escapeHtml(storyAnalysis.artStyle)}</p>`;
    html += `</div>`;

    // Characters
    if (storyAnalysis.characters && storyAnalysis.characters.length > 0) {
      html += `<div class="stage-output-section">`;
      html += `<h4>Characters</h4>`;
      html += `<table class="stage-output-table">`;
      html += `<thead><tr><th>Name</th><th>Description</th><th>Age Range</th></tr></thead>`;
      html += `<tbody>`;
      for (const char of storyAnalysis.characters) {
        html += `<tr>`;
        html += `<td><strong>${escapeHtml(char.name)}</strong></td>`;
        html += `<td>${escapeHtml(char.physicalDescription)}</td>`;
        html += `<td>${escapeHtml(char.ageRange)}</td>`;
        html += `</tr>`;
      }
      html += `</tbody></table>`;
      html += `</div>`;
    }

    // Locations
    if (storyAnalysis.locations && storyAnalysis.locations.length > 0) {
      html += `<div class="stage-output-section">`;
      html += `<h4>Locations</h4>`;
      html += `<table class="stage-output-table">`;
      html += `<thead><tr><th>Name</th><th>Description</th></tr></thead>`;
      html += `<tbody>`;
      for (const loc of storyAnalysis.locations) {
        html += `<tr>`;
        html += `<td><strong>${escapeHtml(loc.name)}</strong></td>`;
        html += `<td>${escapeHtml(loc.visualDescription)}</td>`;
        html += `</tr>`;
      }
      html += `</tbody></table>`;
      html += `</div>`;
    }

    // Scenes with shot breakdowns
    if (storyAnalysis.scenes && storyAnalysis.scenes.length > 0) {
      html += `<div class="stage-output-section">`;
      html += `<h4>Scenes</h4>`;
      for (const scene of storyAnalysis.scenes) {
        html += `<div class="scene-block">`;
        html += `<h5>Scene ${scene.sceneNumber}: ${escapeHtml(scene.title)}</h5>`;
        html += `<p class="muted">${escapeHtml(scene.narrativeSummary)}</p>`;
        html += `<p class="muted"><em>Location: ${escapeHtml(scene.location)} • Duration: ${scene.estimatedDurationSeconds}s</em></p>`;

        // Show shots if they exist and are populated
        if (scene.shots && scene.shots.length > 0) {
          html += `<table class="stage-output-table scene-shots-table">`;
          html += `<thead><tr><th>Shot</th><th>Composition</th><th>Duration</th><th>Dialogue</th></tr></thead>`;
          html += `<tbody>`;
          for (const shot of scene.shots) {
            const dialogue = shot.dialogue ? escapeHtml(shot.dialogue) : "<em>—</em>";
            html += `<tr>`;
            html += `<td>${shot.shotNumber}</td>`;
            html += `<td>${escapeHtml(shot.composition)}</td>`;
            html += `<td>${shot.durationSeconds}s</td>`;
            html += `<td>${dialogue}</td>`;
            html += `</tr>`;
          }
          html += `</tbody></table>`;
        }

        html += `</div>`;
      }
      html += `</div>`;
    }

    elements.stageOutput.innerHTML = html;
    elements.stageOutputSection.style.display = "";
  } catch (error) {
    if (!silent) {
      setGlobalError(`Failed to fetch stage output: ${error.message}`);
    }
    elements.stageOutputSection.style.display = "none";
  }
}

function disconnectEventStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  setConnectionStatus("disconnected");
}

function handleRunEvent(type, messageEvent, source) {
  if (state.eventSource !== source) {
    return;
  }

  try {
    if (type === "connected") {
      const payload = JSON.parse(messageEvent.data);
      appendEvent(
        createEventEntry({
          title: "Event stream connected",
          message: `Run ${payload.runId}`,
          timestamp: payload.timestamp,
        }),
      );
      return;
    }

    const event = JSON.parse(messageEvent.data);
    const payload =
      event && typeof event.payload === "object" && event.payload !== null
        ? event.payload
        : {};
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();

    switch (type) {
      case "run_status": {
        const status = typeof payload.status === "string" ? payload.status : "unknown";
        const error = typeof payload.error === "string" ? payload.error : "";
        appendEvent(
          createEventEntry({
            title: "Run status",
            message: error ? `${status}: ${error}` : status,
            level: status === "failed" ? "error" : "info",
            timestamp,
          }),
        );
        scheduleRunRefresh();
        void fetchAndRenderStageOutput({ silent: true });
        break;
      }
      case "stage_transition": {
        appendEvent(
          createEventEntry({
            title: "Stage transition",
            message: `${formatStageLabel(String(payload.from ?? "-"))} -> ${formatStageLabel(String(payload.to ?? "-"))}`,
            timestamp,
          }),
        );
        scheduleRunRefresh();
        break;
      }
      case "stage_completed": {
        appendEvent(
          createEventEntry({
            title: "Stage completed",
            message: formatStageLabel(String(payload.stage ?? "-")),
            timestamp,
          }),
        );
        scheduleRunRefresh();
        void fetchAndRenderStageOutput({ silent: true });
        break;
      }
      case "asset_generated": {
        const asset = payload.asset;
        if (asset && typeof asset.id === "string") {
          state.assetsById.set(asset.id, asset);
          renderAssets();
          appendEvent(
            createEventEntry({
              title: "Asset generated",
              message: String(asset.key ?? asset.id),
              timestamp,
            }),
          );
        }
        break;
      }
      case "log": {
        const message = typeof payload.message === "string" ? payload.message : "Log event";
        const level = payload.level === "error" ? "error" : "info";
        appendEvent(
          createEventEntry({
            title: "Log",
            message,
            level,
            timestamp,
          }),
        );
        break;
      }
      default:
        break;
    }
  } catch (error) {
    appendEvent(
      createEventEntry({
        title: "Event parse error",
        message: error instanceof Error ? error.message : "Unable to parse event payload",
        level: "error",
      }),
    );
  }
}

function connectEventStream() {
  disconnectEventStream();
  if (!state.activeRunId) {
    return;
  }

  const runId = encodeURIComponent(state.activeRunId);
  const source = new EventSource(`/runs/${runId}/events`);
  state.eventSource = source;
  setConnectionStatus("connecting");

  source.addEventListener("open", () => {
    if (state.eventSource === source) {
      setConnectionStatus("connected");
    }
  });

  source.addEventListener("error", () => {
    if (state.eventSource === source) {
      setConnectionStatus("reconnecting");
    }
  });

  for (const eventType of [
    "connected",
    "run_status",
    "stage_transition",
    "stage_completed",
    "asset_generated",
    "log",
  ]) {
    source.addEventListener(eventType, (event) => {
      handleRunEvent(eventType, event, source);
    });
  }
}

async function loadRuns() {
  try {
    const response = await requestJson("/runs");
    state.runs = Array.isArray(response.runs) ? response.runs : [];
    renderRunSelect();
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to load runs: ${error.message}`);
    return;
  }

  const hasActive = state.activeRunId && state.runs.some((run) => run.id === state.activeRunId);
  if (hasActive) {
    return;
  }

  if (state.runs.length === 0) {
    state.activeRunId = null;
    state.activeRun = null;
    state.assetsById = new Map();
    state.events = [];
    disconnectEventStream();
    renderEvents();
    renderAssets();
    renderRunDetails();
    localStorage.removeItem("storytovideo_activeRunId");
    showCreateView();
    return;
  }

  showRunView();

  // Try to restore saved run from localStorage
  const savedRunId = localStorage.getItem("storytovideo_activeRunId");
  if (savedRunId && state.runs.some((run) => run.id === savedRunId)) {
    await setActiveRun(savedRunId);
    return;
  }

  // If saved run doesn't exist, clean up stale localStorage entry
  if (savedRunId) {
    localStorage.removeItem("storytovideo_activeRunId");
  }

  // Fall back to most recent run
  await setActiveRun(state.runs[0].id);
}

async function setActiveRun(runId) {
  if (!runId) {
    state.activeRunId = null;
    localStorage.removeItem("storytovideo_activeRunId");
    return;
  }

  const changed = runId !== state.activeRunId;
  state.activeRunId = runId;
  elements.runSelect.value = runId;
  localStorage.setItem("storytovideo_activeRunId", runId);

  if (changed) {
    state.assetsById = new Map();
    state.events = [];
    renderAssets();
    renderEvents();
  }

  await Promise.all([refreshRun(), refreshAssets()]);
  connectEventStream();
}

async function handleCreateRunSubmit(event) {
  event.preventDefault();
  const storyText = elements.storyText.value.trim();
  if (!storyText) {
    setGlobalError("Story text is required.");
    return;
  }

  elements.createRunButton.disabled = true;
  try {
    const run = await requestJson("/runs", {
      method: "POST",
      body: JSON.stringify({
        storyText,
        options: {
          reviewMode: true,
        },
      }),
    });
    elements.storyText.value = "";
    await loadRuns();
    await setActiveRun(run.id);
    appendEvent(
      createEventEntry({
        title: "Run created",
        message: run.id,
      }),
    );
    setGlobalError("");
    showRunView();
  } catch (error) {
    setGlobalError(`Failed to create run: ${error.message}`);
  } finally {
    elements.createRunButton.disabled = false;
  }
}

async function handleSubmitInstruction(event) {
  event.preventDefault();
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  if (!state.activeRun) {
    setGlobalError("Run state is unavailable. Refresh and try again.");
    return;
  }
  if (isRunActivelyExecuting(state.activeRun)) {
    setGlobalError(
      'Review controls are locked while run is executing. Interrupt and wait for status "awaiting review".',
    );
    renderRunDetails();
    return;
  }
  if (!isRunReviewSafe(state.activeRun)) {
    setGlobalError('Run is not in review-safe state. Controls unlock when status is "awaiting_review".');
    renderRunDetails();
    return;
  }

  const instruction = elements.instructionText.value.trim();
  if (!instruction) {
    setGlobalError("Instruction is required.");
    return;
  }

  const payload = { instruction };
  const stage = elements.instructionStage.value;
  if (stage) {
    payload.stage = stage;
  }

  elements.submitInstructionButton.disabled = true;
  try {
    const response = await requestJson(
      `/runs/${encodeURIComponent(state.activeRunId)}/instructions`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    elements.instructionText.value = "";
    appendEvent(
      createEventEntry({
        title: "Instruction submitted",
        message: `${response.stage} (${response.instructionCount})`,
        timestamp: response.submittedAt,
      }),
    );
    await refreshRun();
    await refreshAssets();
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to submit instruction: ${error.message}`);
  } finally {
    renderRunDetails();
  }
}

async function handleContinueClick() {
  if (!state.activeRunId) {
    setGlobalError("No active run selected.");
    return;
  }
  if (!state.activeRun) {
    setGlobalError("Run state is unavailable. Refresh and try again.");
    return;
  }
  if (isRunActivelyExecuting(state.activeRun)) {
    setGlobalError(
      'Review controls are locked while run is executing. Interrupt and wait for status "awaiting review".',
    );
    renderRunDetails();
    return;
  }
  if (!isRunReviewSafe(state.activeRun)) {
    setGlobalError('Run is not in review-safe state. Controls unlock when status is "awaiting_review".');
    renderRunDetails();
    return;
  }

  elements.continueButton.disabled = true;
  try {
    const response = await requestJson(
      `/runs/${encodeURIComponent(state.activeRunId)}/continue`,
      {
        method: "POST",
        body: "{}",
      },
    );
    const decision =
      response &&
      typeof response === "object" &&
      response.decision &&
      typeof response.decision === "object"
        ? response.decision
        : null;

    if (decision && typeof decision.stage === "string") {
      appendEvent(
        createEventEntry({
          title: "Continue requested",
          message: `${decision.stage} (${decision.instructionCount ?? 0})`,
          timestamp: typeof decision.decidedAt === "string" ? decision.decidedAt : undefined,
        }),
      );
    } else {
      const message =
        response && typeof response.message === "string"
          ? response.message
          : "Continue request accepted";
      appendEvent(
        createEventEntry({
          title: "Continue status",
          message,
        }),
      );
    }
    await refreshRun();
    setGlobalError("");
  } catch (error) {
    setGlobalError(`Failed to continue run: ${error.message}`);
  } finally {
    renderRunDetails();
  }
}

function startPollingFallback() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  state.pollTimer = window.setInterval(() => {
    if (!state.activeRunId) {
      return;
    }
    void refreshRun({ silent: true });
    void refreshAssets({ silent: true });
  }, POLL_INTERVAL_MS);
}

function bindEvents() {
  elements.newRunButton.addEventListener("click", () => {
    showCreateView();
  });

  elements.createRunForm.addEventListener("submit", (event) => {
    void handleCreateRunSubmit(event);
  });

  elements.runSelect.addEventListener("change", (event) => {
    const target = event.target;
    const runId = target.value;
    if (!runId) {
      return;
    }
    void setActiveRun(runId);
  });

  elements.refreshRunsButton.addEventListener("click", () => {
    void loadRuns();
  });

  elements.instructionForm.addEventListener("submit", (event) => {
    void handleSubmitInstruction(event);
  });

  elements.continueButton.addEventListener("click", () => {
    void handleContinueClick();
  });

  window.addEventListener("beforeunload", () => {
    disconnectEventStream();
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
    }
  });
}

function initialize() {
  populateInstructionStageSelect();
  renderStageProgress();
  renderEvents();
  renderAssets();
  renderRunDetails();
  bindEvents();
  startPollingFallback();
  void loadRuns();
}

initialize();
