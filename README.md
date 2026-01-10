# Clones Quality Agent (CQA)

Process recordings from the Clones factory demos and (optionally) grade task completion with a modern, reliable LLM-based evaluator.

## Why use this

* **End-to-end pipeline**: From raw desktop/web captures to structured messages and graded output.
* **Production-grade evaluator**: Strict JSON Schema outputs, deterministic scoring, and error handling.
* **Multimodal support**: Vision models with cost controls (image limits, text truncation).
* **Developer-friendly**: TypeScript, Bun runtime, focused logging.
* **Extensible scoring**: Adjust evaluation weights at runtime.
* **Tests included**: Unit tests with mocked clients and integration tests.

## How it works (in 30 seconds)

1. **Extract**: Parse web/desktop sessions (events, guac, video).
2. **Augment**: Enrich with captions/state transitions/structured hints (web).
3. **Format**: Convert to SFT-style messages.
4. **Grade** (optional): Chunk the messages, run the LLM evaluator, and produce `scores.json`.
5. **Report**: Persist `results.json/html`, `sft.json/html`, and `scores.json`.

---

## Prerequisites

* [Bun](https://bun.sh) 1.2+
* `ffmpeg` and `ffprobe` on your PATH (for video extraction)
* For grading mode:
  * `GEMINI_API_KEY` - Video Grading mode (recommended, uses Gemini 2.0)
  * `OPENAI_API_KEY` - Text Grading mode (fallback, uses OpenAI GPT models)

## Input Data Formats

The pipeline accepts one of the following session layouts.

1. **Demonstration Desktop recordings**

* `session_id.mp4` – session video
* `session_id.events.jsonl` – event stream in JSONL
* `session_id.meta.json` – optional metadata

2. **Demonstration Web recordings**

* `session_id.events.json` – event data
* `session_id.guac` – Guacamole recording
* `session_id.guac.m4v` – session video

---

## Usage

You can run the pipeline in two ways.

### A) Original format (separate data/sessions/output)

```bash
bun run src/index.ts -o output_dir -f web -s session_id1,session_id2 -d data_directory
bun run src/index.ts -o output_dir -f desktop -s 20250211_215443 -d data
```

### B) Simplified format (from the session directory)

```bash
cd path/to/session_directory
bun run src/index.ts -f desktop -i .
```

### Arguments

* `-o, --out`           Output directory
* `-f, --format`        `web` or `desktop`
* `-s, --sessions`      Comma-separated list of session IDs
* `-d, --data`          Directory containing the input data
* `-i, --input`         Session directory (parent used as data & output)
* `--ffmpeg`            Path to `ffmpeg` (default: `ffmpeg`)
* `--ffprobe`           Path to `ffprobe` (default: `ffprobe`)
* `--grade`             Enable grading mode
* `--video-mode`        Force video grading mode (auto-enabled if `GEMINI_API_KEY` is set)
* `--chunk-size`        Messages per chunk when text grading (default: 4)
* `--model`             Model for evaluation (e.g., `gemini-2.0-flash` or `gpt-4o-mini`)
* `--evaluation-model`  Model for final evaluation in text mode (falls back to `--model`)

---

## Grading mode

The grader evaluates a session using structured JSON outputs and a deterministic scoring model. Two modes are available:

### Video Grading Mode (Recommended)

When `GEMINI_API_KEY` is set, the system uses **Video Grading** which analyzes the screen recording directly using Gemini's vision capabilities.

**Key features:**
* **Two-step evaluation**: Fast filter (Gemini 2.5 Flash) → Expert analysis (Gemini 2.0 Flash, configurable)
* **Direct video analysis**: No intermediate text conversion needed
* **Visual verification**: Identifies apps, UI elements, and task completion
* **Automatic file cleanup**: Uploaded videos are deleted after processing

**Setup:**
```bash
export GEMINI_API_KEY=your_gemini_api_key_here
```

**Requirements:**
* Session must contain `recording.mp4` file
* Uses `meta.json` for task context and objectives

**How it works:**
1. **Filter step** (Gemini 2.5 Flash): Quick pass/fail check on task completion
2. **Expert step** (Gemini 2.0 Flash, configurable): Detailed analysis with timestamps and scoring
3. **Scoring**: Weighted scoring (50% outcome, 30% process, 20% efficiency)

### Text Grading Mode (Fallback)

When only `OPENAI_API_KEY` is set, the system uses **Text Grading** which analyzes the SFT messages.

**Default model**: `gpt-4o-2024-08-06`
**Scoring weights**: 60% outcome, 30% process, 10% efficiency

### Key properties

* **Structured outputs**: JSON Schema validation with Zod.
* **Deterministic scoring**: Component scores combined with normalized weights.
* **Reproducible results**: Fixed seed (42), temperature=0 for consistency.
* **Error handling**: Typed errors (Timeout, Permanent, Transient) with retry logic.
* **Rate limiting**: Built-in rate limiter (10 tokens, 2/sec refill).
* **Concurrent sessions**: Sessions processed in parallel, chunks sequentially per session.
* **Timeouts**: 60s default per request, exponential backoff with jitter.
* **Metrics**: Token usage, timing, and retry tracking via configurable hooks.
* **Cost controls**: Image limits per chunk, text truncation.

### Setup

```bash
# For Video Grading (recommended)
export GEMINI_API_KEY=your_gemini_api_key_here

# For Text Grading (fallback)
export OPENAI_API_KEY=your_openai_api_key_here
```

### Run

```bash
# Grade using video (if GEMINI_API_KEY is set and recording.mp4 exists)
bun run src/index.ts -i . --grade

# Force video mode explicitly
bun run src/index.ts -i . --grade --video-mode

# Grade multiple sessions
bun run src/index.ts -d data -s session1,session2 -o output --grade

# Specify model for video grading
bun run src/index.ts -i . --grade --model gemini-2.5-pro-preview-06-05
```

### What grading produces

For each session, `scores.json`:

```json
{
  "version": "X.Y.Z-video",
  "summary": "One-paragraph outcome summary.",
  "observations": "• High-level bullets (2–6 points)\n• No chain-of-thought",
  "reasoning": "Short final rationale.",
  "score": 73,
  "confidence": 90,
  "outcomeAchievement": 80,
  "processQuality": 70,
  "efficiency": 60,
  "confidenceReasoning": "Justification for the confidence score.",
  "outcomeAchievementReasoning": "Justification for the outcome achievement score.",
  "processQualityReasoning": "Justification for the process quality score.",
  "efficiencyReasoning": "Justification for the efficiency score.",
  "programmaticResults": {
    "videoAnalysis": [
      {
        "timestamp_seconds": 5,
        "description": "User clicked login button",
        "status": "success"
      }
    ]
  }
}
```

**Version suffixes:**
* `X.Y.Z-video` - Video grading mode
* `X.Y.Z-video-filtered` - Session failed the filter step
* `X.Y.Z` - Text grading mode

### Advanced: Dual-Model Evaluation

For higher-quality, unbiased evaluations, you can use separate models for chunk summarization and final scoring. OpenAI's research suggests this improves results by preventing the model from grading its own work.

-   `model`: Used for intermediate chunk processing. A faster, cheaper model is often suitable (e.g., `gpt-4o-mini`).
-   `evaluationModel`: Used for the final, holistic evaluation. A more powerful model is recommended (e.g., `gpt-4o-2024-08-06`).

If `evaluationModel` is not provided, the primary `model` will be used for both steps.

```ts
const grader = new Grader({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-4o-mini",
  evaluationModel: "gpt-4o-2024-08-06",
});
```

### Advanced: Programmatic Graders

Add deterministic checks alongside LLM evaluation for objective verification.

**Interface:**
```ts
interface ProgrammaticGrader {
  evaluateCompletionTime?(chunks: Chunk[]): number;
  checkRequiredActions?(chunks: Chunk[], requirements: string[]): boolean;
  calculateEfficiencyMetrics?(chunks: Chunk[]): { score: number; reasoning: string };
}
```

**Usage:**
```ts
const myGrader: ProgrammaticGrader = {
  checkRequiredActions: (chunks, reqs) => {
    const allText = chunks.flat().map(item => (item as any).text ?? "").join(' ');
    return reqs.every(req => allText.includes(req));
  }
};

const grader = new Grader({
  apiKey: process.env.OPENAI_API_KEY!,
  programmaticGrader: myGrader
});

const meta = { sessionId: "123", requirements: ["save_settings"] };
```

**Output:** Results appear in `scores.json` under `programmaticResults` field.

### Evaluation Criteria Explained

* **Outcome Achievement**: How successfully did the user complete the task objectives? This focuses purely on the end result. A high score means the user met all requirements, regardless of the path taken.
* **Process Quality**: How well did the user execute the task? This evaluates the method, penalizing errors, confusion, unnecessary steps, or deviations from the optimal path.
* **Efficiency**: How quickly and directly did the user complete the task? This measures the economy of actions, time, and resources used. Fewer steps and less hesitation lead to a higher score.

For each session, `metrics.json`:

```json
{
  "sessionId": "session_123",
  "status": "success",
  "totalRequests": 3,
  "successfulRequests": 3,
  "failedRequests": 0,
  "totalTokens": 1250,
  "totalDuration": 4200,
  "averageRetries": 0.33,
  "details": [
    {
      "responseId": "chatcmpl-xyz",
      "type": "chunk",
      "chunkIndex": 0,
      "outcome": "success",
      "tokens": 400,
      "duration": 1200,
      "retries": 1
    }
  ]
}
```

Plus a global `metrics.json` with aggregate statistics across all sessions.

### Standalone Grading Script

Debug script for testing grading locally with real-time output.

**Prerequisites:** `OPENAI_API_KEY` set, session directory with `sft.json` or raw files.

**Usage:**
```bash
# Basic
bun run scripts/run-grading.ts /path/to/session

# With dual-model evaluation
bun run scripts/run-grading.ts /path/to/session --model gpt-4o-mini --evaluation-model gpt-4o-2024-08-06
```

### CLI flow in grading mode

* If `sft.json` exists, it is read, chunked, and graded.
* If `sft.json` does not exist, the pipeline runs first to produce it, then grading proceeds.

---

### Observability and metrics

Monitor grading with request-level metrics:

```ts
import { type RequestMetrics } from "./src/stages/grading/grader";

const grader = new Grader({
  apiKey: process.env.OPENAI_API_KEY!,
  onMetrics: (metrics: RequestMetrics) => {
    console.log(`Response ID: ${metrics.responseId}`);
    console.log(`Tokens: ${metrics.usage?.totalTokens}`);
    console.log(`Duration: ${metrics.timing.durationMs}ms, Retries: ${metrics.timing.retryCount}`);
    console.log(`Outcome: ${metrics.outcome}`);

    // Send to monitoring system
    // sendToDatadog(metrics);
  }
});
```

**Available metrics:** response ID, system fingerprint, token usage (prompt/completion/total), timing (duration, retries, delays), context (session ID, chunk info, model), outcome (success/error), error details (type, message, status code).

### Adjusting evaluation weights

```ts
grader.updateEvaluationCriteria({
  outcomeAchievement: { weight: 0.6 },
  efficiency: { weight: 0.1 }
});

const criteria = grader.getEvaluationCriteria();
```

---

## Outputs from the pipeline

### Non-grading mode

* `results.html` – session visualization
* `results.json` – processed session data
* `sft.html` – formatted messages preview
* `sft.json` – formatted messages used for grading

### Grading mode

All of the above, plus:

* `scores.json` – evaluation results per session
* `metrics.json` – performance metrics per session
* `metrics.json` (global) – aggregate metrics across all sessions

---

## Tests

### Unit tests (mocked)

```bash
bun test
# or
bun run test:grading
```

### Integration tests (real API)

Requires `OPENAI_API_KEY`. These validate structured outputs and end-to-end flow.

```bash
bun run test:grading:integration
```

---

## Security and reliability

* **Input sanitization**: Control characters and injection patterns removed from user text.
* **Logging redaction**: API keys, tokens, credentials, emails, IP addresses automatically redacted.
* **Input guards**: Text truncation, image caps per chunk, numeric validation.
* **Error handling**: Typed errors with retry logic and exponential backoff.

---

## Troubleshooting

* **Missing API key**: Set `GEMINI_API_KEY` for video grading or `OPENAI_API_KEY` for text grading.
* **`ffmpeg` / `ffprobe` not found**: Install and ensure both are on PATH.
* **Video not found**: Ensure `recording.mp4` exists in the session directory for video grading.
* **Video processing timeout**: Dynamic timeout based on video size (3-10 minutes).
* **Filtered sessions**: Score of 0 with `-video-filtered` version means session failed filter step.
* **Timeouts**: Increase `timeout` or reduce chunk size (text mode only).
* **Invalid model output**: Check prompts and input size, then rerun.

---

