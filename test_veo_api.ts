import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
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



async function test1TextToVideo() {
  console.log('\n=== TEST 1: Simple Text-to-Video ===');
  try {
    const prompt = 'A slow cinematic pan across a beautiful mountain landscape at sunset, golden light, peaceful atmosphere';

    console.log(`[Test1] Calling generateVideos with prompt: "${prompt}"`);
    let operation = await client.models.generateVideos({
      model: 'veo-3.1-generate-preview',
      prompt,
      config: {
        numberOfVideos: 1,
        durationSeconds: 8,
        aspectRatio: '16:9',
      },
    });

    console.log(`[Test1] Operation name: ${operation.name}`);
    console.log(`[Test1] Initial done status: ${operation.done}`);

    // Poll using the correct SDK method
    while (!operation.done) {
      console.log('[Test1] Waiting 10s...');
      await sleep(10000);
      operation = await client.operations.getVideosOperation({ operation });
      console.log(`[Test1] Poll status: done=${operation.done}`);
    }

    // Access the response
    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (generatedVideo?.video) {
      console.log(`[Test1] Video URI: ${generatedVideo.video.uri}`);
      const downloadPath = join(outputDir, 'test1_text_to_video.mp4');
      await client.files.download({
        file: generatedVideo.video,
        downloadPath,
      });
      console.log(`[Test1] ✅ Downloaded to ${downloadPath}`);
    } else {
      console.error('[Test1] ❌ No video in response:', JSON.stringify(operation.response, null, 2));
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

    const files = readdirSync(framesDir).filter((f: string) => f.endsWith('.png'));
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
    let operation = await client.models.generateVideos({
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
    });

    console.log(`[Test2] Operation name: ${operation.name}`);

    while (!operation.done) {
      console.log('[Test2] Waiting 10s...');
      await sleep(10000);
      operation = await client.operations.getVideosOperation({ operation });
      console.log(`[Test2] Poll status: done=${operation.done}`);
    }

    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (generatedVideo?.video) {
      const downloadPath = join(outputDir, 'test2_interpolation.mp4');
      await client.files.download({
        file: generatedVideo.video,
        downloadPath,
      });
      console.log(`[Test2] ✅ Downloaded to ${downloadPath}`);
    } else {
      console.error('[Test2] ❌ No video in response:', JSON.stringify(operation.response, null, 2));
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

