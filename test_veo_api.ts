import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Create output directory
const outputDir = 'test_output';
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollOperation(operationName: string, maxWaitMs: number = 600000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const operation = await client.operations.get({ name: operationName } as any);
      console.log(`[Poll] Status: ${(operation as any).done ? 'DONE' : 'IN_PROGRESS'}`);
      if ((operation as any).done) {
        return operation;
      }
    } catch (err) {
      console.error(`[Poll Error]`, err);
    }
    await sleep(10000); // Poll every 10 seconds
  }
  throw new Error(`Operation ${operationName} did not complete within ${maxWaitMs}ms`);
}

async function test1TextToVideo() {
  console.log('\n=== TEST 1: Simple Text-to-Video ===');
  try {
    const prompt = 'A slow cinematic pan across a beautiful mountain landscape at sunset, golden light, peaceful atmosphere';
    
    console.log(`[Test1] Calling generateVideos with prompt: "${prompt}"`);
    const operation = await client.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt,
      config: {
        numberOfVideos: 1,
        durationSeconds: 8,
        aspectRatio: '16:9',
      },
    } as any);

    console.log(`[Test1] Operation name: ${operation.name}`);
    console.log(`[Test1] Initial done status: ${operation.done}`);

    const completedOp = await pollOperation((operation as any).name!);

    const response = (completedOp as any).response;
    if (response?.generatedVideos?.[0]?.video) {
      const videoFile = response.generatedVideos[0].video;
      console.log(`[Test1] Video generated: ${videoFile.uri || videoFile.mimeType}`);

      // Download the video
      const downloadPath = join(outputDir, 'test1_text_to_video.mp4');
      await client.files.download({
        file: videoFile,
        downloadPath,
      });
      console.log(`[Test1] ✅ Downloaded to ${downloadPath}`);
    } else {
      console.error('[Test1] ❌ No video in response:', response);
    }
  } catch (err: any) {
    console.error('[Test1] ❌ Error:', err.message);
    if (err.response) {
      console.error('[Test1] Response body:', JSON.stringify(err.response, null, 2));
    }
  }
}

async function test2Interpolation() {
  console.log('\n=== TEST 2: Image-to-Video with First+Last Frame ===');
  try {
    // Check for frame images in output/frames/
    const framesDir = 'output/frames';
    if (!existsSync(framesDir)) {
      console.log('[Test2] ⚠️  No frames directory found. Skipping interpolation test.');
      return;
    }

    const files = require('fs').readdirSync(framesDir).filter((f: string) => f.endsWith('.png'));
    if (files.length < 2) {
      console.log(`[Test2] ⚠️  Found only ${files.length} frame images. Need at least 2 for interpolation.`);
      return;
    }

    const startFramePath = join(framesDir, files[0]);
    const endFramePath = join(framesDir, files[1]);

    console.log(`[Test2] Using frames: ${files[0]} and ${files[1]}`);

    const startBase64 = readFileSync(startFramePath).toString('base64');
    const endBase64 = readFileSync(endFramePath).toString('base64');

    const prompt = 'Smooth transition between the two frames, maintaining visual continuity';

    console.log(`[Test2] Calling generateVideos with interpolation`);
    const operation = await client.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt,
      image: {
        imageBytes: startBase64,
        mimeType: 'image/png',
      },
      config: {
        lastFrame: {
          imageBytes: endBase64,
          mimeType: 'image/png',
        },
        durationSeconds: 8,
        aspectRatio: '16:9',
      },
    } as any);

    console.log(`[Test2] Operation name: ${(operation as any).name}`);
    const completedOp = await pollOperation((operation as any).name!);

    const response = (completedOp as any).response;
    if (response?.generatedVideos?.[0]?.video) {
      const videoFile = response.generatedVideos[0].video;
      const downloadPath = join(outputDir, 'test2_interpolation.mp4');
      await client.files.download({
        file: videoFile,
        downloadPath,
      });
      console.log(`[Test2] ✅ Downloaded to ${downloadPath}`);
    } else {
      console.error('[Test2] ❌ No video in response:', response);
    }
  } catch (err: any) {
    console.error('[Test2] ❌ Error:', err.message);
    if (err.response) {
      console.error('[Test2] Response body:', JSON.stringify(err.response, null, 2));
    }
  }
}

async function main() {
  const testArg = process.argv[2];

  if (!process.env.GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY not set');
    process.exit(1);
  }

  if (testArg === 'test1') {
    await test1TextToVideo();
  } else if (testArg === 'test2') {
    await test2Interpolation();
  } else {
    console.log('Usage: npx tsx test_veo_api.ts [test1|test2]');
    console.log('  test1 - Simple text-to-video');
    console.log('  test2 - Image-to-video with first+last frame interpolation');
    process.exit(1);
  }
}

main().catch(console.error);

