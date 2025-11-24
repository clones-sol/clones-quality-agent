import { GoogleGenAI, File } from "@google/genai";

const API_KEY = process.env.GEMINI_API_KEY;
const MAX_AGE_HOURS = 1; // Delete files older than 1 hour

async function runCleanup() {
    if (!API_KEY) {
        console.error("Error: GEMINI_API_KEY is missing.");
        process.exit(1);
    }

    console.log("Starting Gemini Garbage Collector...");
    const genAI = new GoogleGenAI({ apiKey: API_KEY });

    try {
        const pager = await genAI.files.list();
        const files: File[] = [];
        for await (const file of pager) {
            files.push(file);
        }

        if (files.length === 0) {
            console.log("No files found. Nothing to clean.");
            return;
        }

        console.log(`Found ${files.length} files total.`);

        const now = new Date();
        let deletedCount = 0;

        for (const file of files) {
            const createdTime = new Date(file.createTime!);
            const ageInHours = (now.getTime() - createdTime.getTime()) / (1000 * 60 * 60);

            if (ageInHours > MAX_AGE_HOURS) {
                console.log(`Deleting orphaned file: ${file.displayName} (Age: ${ageInHours.toFixed(1)}h)`);
                try {
                    await genAI.files.delete({ name: file.name! });
                    deletedCount++;
                } catch (err) {
                    console.error(`Failed to delete ${file.name}:`, err);
                }
            } else {
                console.log(`Keeping recent file: ${file.displayName} (Age: ${ageInHours.toFixed(1)}h)`);
            }
        }

        console.log(`\nCleanup complete. Deleted ${deletedCount} orphaned files.`);

    } catch (error) {
        console.error("Cleanup failed:", error);
        process.exit(1);
    }
}

runCleanup();

