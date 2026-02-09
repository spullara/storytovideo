# storytovideo

Convert short stories into videos using AI. An agentic Claude Opus 4.6 orchestrator drives the entire pipeline — analyzing stories, planning cinematic shots, generating assets and video clips via Google APIs, and assembling the final output.

**Status:** Experimental (uses preview APIs like Veo 3.1)

## Quick Start

```bash
# Install dependencies
npm install

# Set up API keys
cp .env.example .env
# Edit .env with your Anthropic and Google AI API keys

# Dry run — preview the shot plan without generating anything
npx tsx src/cli.ts story.txt --dry-run --verbose

# Full run with AI verification
npx tsx src/cli.ts story.txt --verify --verbose

# Resume after interruption
npx tsx src/cli.ts story.txt --resume --verbose
```

## How It Works

storytovideo breaks down story-to-video generation into six stages:

```
Story Text
    ↓
[1] Story Analysis (Gemini)
    ↓ Extract: characters, locations, art style, scenes
[2] Shot Planning (Gemini)
    ↓ Break into ≤8s shots with cinematic composition
[3] Asset Generation (Nano Banana)
    ↓ Reference images: front view + 3/4 angle per character, one per location
[4] Frame Generation (Nano Banana)
    ↓ Start + end keyframes for each shot
[5] Video Generation (Veo 3.1)
    ↓ 8-second clips via first+last frame interpolation
[6] Assembly (ffmpeg)
    ↓
Final MP4 Video
```

### The AI Stack

- **Claude Opus 4.6** (Vercel AI SDK) — Agentic orchestrator that drives the entire pipeline
- **Gemini 2.5 Flash** (Vercel AI SDK) — Story analysis, shot planning, quality verification
- **Gemini 2.5 Flash Image** (Google GenAI) — Reference images and keyframe generation
- **Veo 3.1** (Google GenAI) — 8-second video clip generation
- **ffmpeg** — Final video assembly

## CLI Options

```bash
npx tsx src/cli.ts <story-file> [options]

Options:
  --dry-run              Preview shot plan without generating assets/videos
  --verify               Enable Gemini quality checks with automatic retries
  --resume               Continue from where the pipeline was interrupted
  --skip-to <stage>      Jump to a specific stage (analysis, shot_planning,
                         asset_generation, frame_generation, video_generation, assembly)
  --verbose              Show Claude's reasoning and all tool calls
  --max-retries <n>      Max retries for failed generations (default: 2)
  --output <file>        Output video path (default: final.mp4)
  --output-dir <dir>     Directory for intermediate files (default: ./output)
```

## Key Features

### Graceful Interruption & Resume
Press Ctrl+C to interrupt. The pipeline saves its state and exits cleanly. Use `--resume` to pick up exactly where it left off — even at the item level (e.g., "assets for characters Bolt and Luna are done, but location Junkyard is not").

### Dry-Run Mode
Preview the full shot plan without spending on generation:
```bash
npx tsx src/cli.ts story.txt --dry-run --verbose
cat output/story_analysis.json | jq .
```

### AI Verification
Enable `--verify` to have Gemini check every generated asset, frame, and video. On failure, Claude automatically retries with specific feedback.

### Context Windowing
The orchestrator uses stage-based context windowing — each pipeline stage runs as a separate Claude conversation with fresh context. This keeps token usage reasonable even for complex stories.

### 429 Retry with Backoff
Rate limit errors automatically retry after 60 seconds (up to 5 times).

## Prerequisites

- **Node.js 20+**
- **ffmpeg** installed and on PATH
- **Anthropic API key** (for Claude Opus 4.6)
- **Google AI API key** (for Gemini + Veo)

## Setup

1. Clone the repository:
```bash
git clone https://github.com/spullara/storytovideo.git
cd storytovideo
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file with your API keys:
```bash
cp .env.example .env
```

4. Edit `.env`:
```
ANTHROPIC_API_KEY=your_anthropic_key_here
GEMINI_API_KEY=your_google_ai_key_here
```

## Example

Try the included test story:

```bash
npx tsx src/cli.ts test_story.txt --dry-run --verbose
```

This will:
1. Analyze the story
2. Plan cinematic shots
3. Save the full analysis to `output/story_analysis.json`
4. Exit without generating images or videos

Then run the full pipeline:

```bash
npx tsx src/cli.ts test_story.txt --verify --verbose
```

Watch the progress as Claude orchestrates each stage. The final video will be saved to `final.mp4`.

## Output Structure

Intermediate files are saved to the output directory:

```
output/
  story_analysis.json       — Full story analysis + shot plan
  pipeline_state.json       — Pipeline state for resume
  assets/                   — Character and location reference images
  frames/                   — Start/end keyframes per shot
  videos/                   — Generated 8-second video clips
  final.mp4                 — Assembled final video
```

## Cinematic Shot Composition

The shot planner uses real film techniques, especially for dialogue:

- **Over-the-shoulder (OTS)** — Camera behind speaker A, focused on speaker B
- **Shot/reverse-shot** — Cut between close-ups of each speaker
- **Two-shot** — Both characters in frame
- **Close-up reaction** — Tight on face during emotional beats
- **Wide/establishing** — Full location, characters small
- **Tracking** — Camera follows movement

Dialogue is paced at ~2.5 words/second, so an 8-second clip holds ~15-20 words.

## Architecture

The pipeline is designed for **interruption and resumption**. Every stage saves its progress to `pipeline_state.json`, tracking:
- Which stages are complete
- Which individual items within a stage are complete (character assets, frames, videos)
- The full story analysis and shot plan

When you resume, Claude receives the saved state and skips already-completed items.

## Troubleshooting

**"ffmpeg not found"**
- Install ffmpeg: `brew install ffmpeg` (macOS) or `apt-get install ffmpeg` (Linux)

**"API rate limit (429)"**
- The pipeline automatically retries after 60 seconds. Wait and let it continue.

**"Out of memory during TypeScript compilation"**
- This is a known issue with complex generic types. Run `npm run build` to compile.

**"Ctrl+C doesn't save state"**
- The pipeline waits for the current API call to finish (up to 30 seconds) before saving and exiting.

## File Structure

```
src/
  cli.ts                    — CLI entry point (commander)
  orchestrator.ts           — Claude Opus 4.6 agentic loop
  types.ts                  — TypeScript interfaces
  google-client.ts          — Google GenAI singleton
  signals.ts                — SIGINT handler for graceful interruption
  tools/
    analyze-story.ts        — Gemini story analysis
    plan-shots.ts           — Gemini shot planning
    generate-asset.ts       — Nano Banana reference images
    generate-frame.ts       — Nano Banana keyframes
    generate-video.ts       — Veo 3.1 video generation
    verify-output.ts        — Gemini quality verification
    assemble-video.ts       — ffmpeg concatenation
    state.ts                — PipelineState save/load
```

## License

MIT
