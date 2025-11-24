import { VideoGrader } from '../src/stages/grading/video-grader';
import { MetaData } from '../src/stages/grading/grader/types';
import path from 'path';
import fs from 'fs';

// Configuration
const SESSION_ID = "20251123_204932";
const BASE_DIR = path.resolve(__dirname, "../test-data/grading-video");
const SESSION_DIR = path.join(BASE_DIR, SESSION_ID);
const VIDEO_PATH = '/Users/SSe/Library/Application Support/ai.clones.agent-devnet/recordings/20251123_223830/recording.mp4';
const META_PATH = path.join(SESSION_DIR, "meta.json");

async function runTest() {
    console.log("🚀 Starting Video Grading Integration Test");
    console.log(`📂 Session Directory: ${SESSION_DIR}`);

    // 1. Verify files exist
    if (!fs.existsSync(VIDEO_PATH)) {
        console.error(`❌ Error: Video file not found at ${VIDEO_PATH}`);
        process.exit(1);
    }
    if (!fs.existsSync(META_PATH)) {
        console.error(`❌ Error: Meta file not found at ${META_PATH}`);
        process.exit(1);
    }

    // 2. Check API Key
    if (!process.env.GEMINI_API_KEY) {
        console.error("❌ Error: GEMINI_API_KEY is missing from environment variables.");
        process.exit(1);
    }

    // 3. Load Metadata
    console.log("📖 Loading metadata...");
    const metaJson = JSON.parse(fs.readFileSync(META_PATH, 'utf-8'));

    const meta: MetaData = {
        sessionId: SESSION_ID,
        platform: "desktop", // Assuming desktop for this test
        taskDescription: metaJson.quest?.title || metaJson.title,
        quest: metaJson.quest,
        id: metaJson.id
    };

    console.log(`   Task: ${meta.taskDescription}`);
    console.log(`   Objectives: ${meta.quest?.objectives?.length || 0} found`);

    // 4. Initialize Grader
    console.log("🤖 Initializing VideoGrader...");
    const grader = new VideoGrader({
        apiKey: process.env.GEMINI_API_KEY,
        model: "gemini-2.0-flash" // Use Flash for tests to avoid 429 Quota errors
    });

    // 5. Run Evaluation
    console.log("🎬 Running Evaluation (this may take a minute)...");
    const startTime = Date.now();

    try {
        const result = await grader.evaluateSession(VIDEO_PATH, meta);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`\n✅ Grading Complete in ${duration}s`);
        console.log("---------------------------------------------------");
        console.log(`🏆 Final Score: ${result.score}/100`);
        console.log(`🎯 Outcome: ${result.outcomeAchievement}/100`);
        console.log(`⚙️  Process: ${result.processQuality}/100`);
        console.log(`⚡ Efficiency: ${result.efficiency}/100`);
        console.log(`🧠 Confidence: ${result.confidence}%`);
        console.log("---------------------------------------------------");
        console.log(`📝 Summary: ${result.summary}`);
        console.log(`🤔 Reasoning: ${result.reasoning}`);
        console.log("---------------------------------------------------");

        // Write output for inspection
        const outputPath = path.join(SESSION_DIR, "scores_test.json");
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        console.log(`💾 Result saved to: ${outputPath}`);

    } catch (error) {
        console.error("\n❌ Grading Failed:", error);
    }
}

runTest();

