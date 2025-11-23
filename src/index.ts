import { Pipeline } from './pipeline/pipeline';
import { visualizeEvents, visualizeMessages } from './shared/utils/visualization';
import { DenseCaptionAugmenter } from './stages/augmentation/dense-caption-augmenter';
import { StateTransitionAugmenter } from './stages/augmentation/state-transition-augmenter';
import { StructuredDataAugmenter } from './stages/augmentation/structured-data-augmenter';
import { EventExtractor } from './stages/extraction/event-extractor';
import { GuacExtractor } from './stages/extraction/guac-extractor';
import { VideoExtractor } from './stages/extraction/video-extractor';
import { DemoDesktopExtractor } from './stages/extraction/simple-extractor';
import { MessageFormatter } from './stages/formatting/message-formatter';
import { TaskMetadata } from './shared/types';
import path from 'path';

import { Grader } from './stages/grading/grader';
import { VideoGrader } from './stages/grading/video-grader'; // New import
import { GraderLogger, Chunk, MetaData, GradeResult } from './stages/grading/grader/types';

import packageJson from '../package.json';

console.log(`Clones Quality Agent version: ${packageJson.version}`);

// Optional: Create a custom logger for production use
class ProductionLogger implements GraderLogger {
  info(message: string, err?: Error, meta?: Record<string, unknown>): void {
    console.log(`[GRADER-INFO] ${message}`, meta ? JSON.stringify(meta) : '');
    if (err) console.log(`[GRADER-INFO-ERR] ${err.message}`);
  }
  warn(message: string, err?: Error, meta?: Record<string, unknown>): void {
    console.warn(`[GRADER-WARN] ${message}`, meta ? JSON.stringify(meta) : '');
    if (err) console.warn(`[GRADER-WARN-ERR] ${err.message}`);
  }
  error(message: string, err?: Error, meta?: Record<string, unknown>): void {
    console.error(`[GRADER-ERROR] ${message}`, err?.message || '', meta ? JSON.stringify(meta) : '');
  }
  debug(message: string, err?: Error, meta?: Record<string, unknown>): void {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[GRADER-DEBUG] ${message}`, meta ? JSON.stringify(meta) : '');
      if (err) console.debug(`[GRADER-DEBUG-ERR] ${err.message}`);
    }
  }
}
import { parseArgs } from 'util';

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    data: { short: 'd', type: 'string' },
    out: { short: 'o', type: 'string' },
    sessions: { short: 's', type: 'string' },
    input: { short: 'i', type: 'string' },
    format: { short: 'f', type: 'string' },
    grade: { type: 'boolean', default: false },
    'chunk-size': { type: 'string', default: '4' },
    ffmpeg: { type: 'string', default: 'ffmpeg' },
    ffprobe: { type: 'string', default: 'ffprobe' },
    'model': { type: 'string' },
    'evaluation-model': { type: 'string' },
    'video-mode': { type: 'boolean', default: false } // Force video mode
  },
  strict: true,
  allowPositionals: true
});

// Convert an array of SFT messages into Grader chunks of size N
function sftToChunks(messages: any[], chunkSize: number): Chunk[] {
  console.log(`[SFT-DEBUG] Processing ${messages.length} SFT messages`);

  const items = (messages ?? []).map((m: any) => {
    // Check for app_focus events in SFT data
    if (m && m.type === 'app_focus') {
      console.log(`[SFT-DEBUG] Found app_focus event: ${JSON.stringify(m)}`);
      return { type: 'app_focus', timestamp: m.timestamp, data: m.data };
    }
    // Common cases: { role, content }, or strings
    if (typeof m === 'string') return { type: 'text', text: String(m) };
    if (m && typeof m.content === 'string') return { type: 'text', text: m.content };
    // Optional image support if present in SFT (base64 fields)
    if (m && m.type === 'image' && typeof m.data === 'string') {
      return { type: 'image', data: m.data, mime: m.mime ?? 'image/jpeg', cropInfo: m.cropInfo };
    }
    // Fallback: stringify unknown message shape (trim to avoid huge prompts)
    return { type: 'text', text: JSON.stringify(m).slice(0, 1000) };
  });
  const chunks: Chunk[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize) as Chunk);
  }
  return chunks;
}


// Check for API keys
if (values.grade) {
  // If video mode is forced OR Gemini key is present, we prioritize Video Grading
  const useVideoGrading = values['video-mode'] || !!process.env.GEMINI_API_KEY;

  if (useVideoGrading && !process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is required for Video Grading mode');
    process.exit(1);
  }

  if (!useVideoGrading && !process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required for Text Grading mode');
    process.exit(1);
  }
}

// Handle both input formats
let dataDir: string;
let sessions: string[];
let outDir: string;
const format: string = values.format || 'web';

if (values.input) {
  // New format: -i directory
  const inputPath = path.resolve(values.input);
  dataDir = path.dirname(inputPath);
  sessions = [path.basename(inputPath)];
  outDir = dataDir;
} else {
  // Original format: -d data -s sessions -o output
  dataDir = values.data || '.';
  sessions = values.sessions?.split(',') || [];
  outDir = values.out || '.';
}

// Initialize pipeline for both modes
const pipeline = new Pipeline({
  dataDir: dataDir,
  outputDir: outDir,
  sessionIds: sessions,
  extractors: [
    new VideoExtractor(dataDir, values.ffmpeg, values.ffprobe),
    ...(format === 'desktop'
      ? [new DemoDesktopExtractor(dataDir)]
      : [new GuacExtractor(dataDir), new EventExtractor(dataDir)])
  ],
  augmenters:
    format === 'desktop'
      ? []
      : [
        new DenseCaptionAugmenter(1),
        new StateTransitionAugmenter(1),
        new StructuredDataAugmenter(1)
      ]
});

console.log(`Starting processing of ${sessions.length} sessions...`);

// --- VIDEO GRADING LOGIC ---
async function gradeVideoSession(
  grader: VideoGrader,
  session: string,
  videoPath: string,
  metaPath: string,
  outDir: string
): Promise<void> {
  console.log(`🎥 Video Grading session: ${session}`);

  let metaJson: any = {};
  try {
    metaJson = await Bun.file(metaPath).json();
  } catch (e) {
    console.warn(`Warning: Could not read meta.json: ${e}`);
  }

  const meta: MetaData = {
    sessionId: session,
    platform: format === 'desktop' ? 'desktop' : 'web',
    taskDescription: metaJson?.quest?.title ?? metaJson?.title ?? metaJson?.description ?? undefined,
    quest: metaJson?.quest ?? undefined,
    id: metaJson?.id ?? undefined,
  };

  const result = await grader.evaluateSession(videoPath, meta);

  if (result) {
    console.log('\nVideo Grading complete!');
    console.log(`\nCQA version: ${result.version}`);
    console.log(`Score: ${result.score}/100 (Confidence: ${(result.confidence).toFixed(1)}%)`);
    console.log('\nSummary:');
    console.log(result.summary);

    await Bun.write(path.join(outDir, session, 'scores.json'), JSON.stringify(result, null, 2));
  } else {
    console.error('Failed to grade video session');
  }
}


// --- TEXT GRADING LOGIC ---
async function gradeSftFile(
  grader: Grader,
  session: string,
  sftPath: string,
  metaPath: string,
  outDir: string,
  chunkSize: number,
  format: string
): Promise<void> {
  console.log(`Grading sft.json for session: ${session}`);
  const sftMessages = await Bun.file(sftPath).json();
  let metaJson: any = {};
  try {
    metaJson = await Bun.file(metaPath).json();
  } catch { }
  const meta: MetaData = {
    sessionId: session,
    platform: format === 'desktop' ? 'desktop' : 'web',
    taskDescription:
      metaJson?.quest?.title ?? metaJson?.title ?? metaJson?.description ?? undefined,
    quest: metaJson?.quest ?? undefined,
    id: metaJson?.id ?? undefined,
  };
  const chunks = sftToChunks(sftMessages, chunkSize);
  const result = await grader.evaluateSession(chunks, meta);
  if (result) {
    console.log('\nGrading complete!');
    console.log(`Score: ${result.score}/100`);
    await Bun.write(path.join(outDir, session, 'scores.json'), JSON.stringify(result, null, 2));
  } else {
    console.error('Failed to grade session');
  }
}

async function runPipelineAndFormat(
  pipeline: Pipeline,
  session: string,
  dataDir: string,
  outDir: string
): Promise<void> {
  const results = await pipeline.process(session);
  const html = visualizeEvents(results);
  await Bun.write(path.join(outDir, session, `results.html`), html);
  await Bun.write(path.join(outDir, session, `results.json`), JSON.stringify(results, null, 2));

  // Load task metadata from meta.json or manifest.json
  let taskMetadata: TaskMetadata | undefined = undefined;
  const metaPath = path.join(dataDir, session, 'meta.json');
  const manifestPath = path.join(dataDir, session, 'manifest.json');

  try {
    if (await Bun.file(metaPath).exists()) {
      const meta = await Bun.file(metaPath).json();
      taskMetadata = {
        title: meta?.quest?.title || meta?.title,
        description: meta?.quest?.content || meta?.description,
        content: meta?.quest?.content || meta?.description,
        objectives: meta?.quest?.objectives
      };
    } else if (await Bun.file(manifestPath).exists()) {
      const manifest = await Bun.file(manifestPath).json();
      taskMetadata = {
        title: manifest?.task?.title,
        description: manifest?.task?.description,
        content: manifest?.task?.description
      };
    }
  } catch (error) {
    console.log(`[FORMATTER-DEBUG] Could not load task metadata: ${error}`);
  }

  // Format messages with task metadata
  const formatter = new MessageFormatter(taskMetadata);
  const messages = await formatter.process(results);

  // Write formatted messages
  const msg_html = visualizeMessages(messages);
  await Bun.write(path.join(outDir, session, `sft.html`), msg_html);
  await Bun.write(path.join(outDir, session, `sft.json`), JSON.stringify(messages, null, 2));
}

async function processSession(
  session: string,
  pipeline: Pipeline,
  dataDir: string,
  outDir: string,
  format: string,
  chunkSize: number,
  grader?: Grader | VideoGrader
): Promise<void> {
  console.log(`\nProcessing session: ${session}`);
  const sftPath = path.join(dataDir, session, 'sft.json');
  const videoPath = path.join(dataDir, session, 'recording.mp4');
  const metaPath = path.join(dataDir, session, 'meta.json');

  // Check if we should use Video Grading
  // Condition: Grader is VideoGrader AND video file exists
  if (grader instanceof VideoGrader) {
    if (await Bun.file(videoPath).exists()) {
      await gradeVideoSession(grader, session, videoPath, metaPath, outDir);
      return; // Skip text pipeline if video grading is successful
    } else {
      console.warn(`[WARNING] Video grading enabled but recording.mp4 not found for session ${session}. Falling back to text pipeline...`);
      // Fallback or error? For now, we fall back to pipeline generation but we can't grade if the grader is VideoGrader type.
    }
  }

  // Legacy Text Pipeline
  const sftExists = await Bun.file(sftPath).exists();

  if (!sftExists) {
    console.log('No sft.json found, running pipeline...');
    await runPipelineAndFormat(pipeline, session, dataDir, outDir);
  } else {
    console.log('Found existing sft.json.');
  }

  if (grader && !(grader instanceof VideoGrader)) {
    await gradeSftFile(grader, session, sftPath, metaPath, outDir, chunkSize, format);
  }
}

async function processAllSessions() {
  const chunkSize = Number.isFinite(Number(values['chunk-size']))
    ? Number(values['chunk-size'])
    : 4;

  let grader: Grader | VideoGrader | undefined;

  if (values.grade) {
    const productionLogger = new ProductionLogger();

    // DECISION LOGIC: VIDEO VS TEXT
    // If GEMINI_API_KEY is present, we default to Video Grading (Gemini 2.0 Flash)
    // Unless overridden? No, let's keep it simple.

    if (process.env.GEMINI_API_KEY) {
      console.log("🌟 Video Grading Mode Enabled (Gemini API Key detected)");
      grader = new VideoGrader({
        apiKey: process.env.GEMINI_API_KEY,
        model: values.model || 'gemini-2.0-flash', // Default to the fast one
      }, productionLogger);
    } else if (process.env.OPENAI_API_KEY) {
      console.log("📝 Text Grading Mode Enabled (OpenAI API Key detected)");
      grader = new Grader(
        {
          apiKey: process.env.OPENAI_API_KEY!,
          chunkSize,
          model: values.model,
          evaluationModel: values['evaluation-model'],
          timeout: 60_000,
          maxRetries: 3,
          seed: 42,
          rateLimiter: { maxTokens: 10, refillRate: 2 }
        },
        productionLogger
      );
    }
  }

  console.log(`Starting processing of ${sessions.length} sessions...`);

  // Sequential processing for simplicity and clarity in logs
  for (const session of sessions) {
    await processSession(session, pipeline, dataDir, outDir, format, chunkSize, grader);
  }
}

processAllSessions().then(() => {
  console.log(`Wrote sessions to ${outDir}`);
});
