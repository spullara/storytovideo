import "dotenv/config";
import { Command } from "commander";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loadState } from "./tools/state";
import { setInterrupted } from "./signals";
import type { PipelineOptions, PipelineState } from "./types";

const program = new Command();

// Global state for interruption handling
let currentState: PipelineState | null = null;

// SIGINT handler for graceful interruption
process.on("SIGINT", async () => {
  console.log("\nInterrupted. Saving state...");
  setInterrupted(true);

  if (currentState) {
    try {
      // Set interrupted flag and save state
      currentState.interrupted = true;
      const { saveState } = await import("./tools/state");
      await saveState({ state: currentState });
      console.log(
        "Pipeline interrupted. Resume with: storytovideo <story> --resume"
      );
    } catch (error) {
      console.error("Failed to save state during interruption:", error);
    }
  }

  process.exit(0);
});

program
  .name("storytovideo")
  .description("Convert short stories to videos using Claude and Google APIs")
  .version("0.1.0");

program
  .argument("<story-file>", "Path to the story file")
  .option("--output <file>", "Output video file path", "final.mp4")
  .option("--output-dir <dir>", "Output directory for intermediate files", "./output")
  .option("--dry-run", "Analyze and plan shots without generating assets/videos", false)
  .option("--verify", "Enable AI verification with automatic retries", false)
  .option("--max-retries <number>", "Maximum retries for failed generations", "2")
  .option("--skip-to <stage>", "Skip to a specific pipeline stage")
  .option("--resume", "Resume from saved state", false)
  .option("--verbose", "Show detailed logs and Claude reasoning", false)
  .action(async (storyFile, options) => {
    try {
      // Validate story file exists
      const storyPath = resolve(storyFile);
      const storyText = readFileSync(storyPath, "utf-8");

      if (!storyText.trim()) {
        console.error("Error: Story file is empty");
        process.exit(1);
      }

      // Parse options
      const maxRetries = parseInt(options.maxRetries, 10);
      if (isNaN(maxRetries) || maxRetries < 0) {
        console.error("Error: --max-retries must be a non-negative number");
        process.exit(1);
      }

      const pipelineOptions: PipelineOptions = {
        outputDir: options.outputDir,
        dryRun: options.dryRun,
        verify: options.verify,
        maxRetries,
        skipTo: options.skipTo,
        resume: options.resume,
        verbose: options.verbose,
      };

      console.log("Story to Video Pipeline");
      console.log("=======================");
      console.log(`Story file: ${storyPath}`);
      console.log(`Output directory: ${pipelineOptions.outputDir}`);
      console.log(`Output file: ${options.output}`);
      console.log(`Dry run: ${pipelineOptions.dryRun}`);
      console.log(`Verify: ${pipelineOptions.verify}`);
      console.log(`Max retries: ${pipelineOptions.maxRetries}`);
      console.log(`Resume: ${pipelineOptions.resume}`);
      console.log(`Verbose: ${pipelineOptions.verbose}`);
      console.log("");

      // Handle --resume: load saved state
      if (pipelineOptions.resume) {
        const savedState = loadState(pipelineOptions.outputDir);
        if (savedState) {
          console.log("Resuming from saved state...");
          currentState = savedState;
        } else {
          console.warn(
            "No saved state found. Starting fresh pipeline."
          );
        }
      }

      // --skip-to is handled in orchestrator.ts runPipeline()

      // Import and call the orchestrator (will be created in Wave 4)
      // For now, this is a placeholder that will be filled in when orchestrator.ts exists
      try {
        const { runPipeline } = await import("./orchestrator");
        await runPipeline(storyText, pipelineOptions);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Cannot find module")
        ) {
          console.error(
            "Error: orchestrator.ts not yet implemented (Wave 4)"
          );
          console.log(
            "Pipeline setup complete. Orchestrator will be wired in Wave 4."
          );
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unknown error occurred");
      }
      process.exit(1);
    }
  });

program.parse(process.argv);

