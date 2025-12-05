import { GoogleGenAI, FileState } from "@google/genai";
import fs from "fs";
import {
    GradeResult,
    GraderConfig,
    GraderLogger,
    MetaData
} from "./grader/types";
import { VIDEO_GRADING_SYSTEM_PROMPT, getVideoUserPrompt } from "./grader/video-prompts";
import { MIN_WORKFLOW_ENGAGEMENT_SCORE } from "./grader/constants";
import { DefaultLogger } from "./grader/logger";
import { clamp } from "./grader/utils";
import { PermanentError, TransientError, GraderError } from "./grader/errors";
import packageJson from "../../../package.json"; // Import package.json

// Schema for structured output (Zod-like structure for Gemini)
const gradingSchema = {
    type: "object",
    properties: {
        summary: { type: "string" },
        observations: { type: "string" },
        reasoning: { type: "string" },
        outcomeAchievement: { type: "number", description: "Score 0-100" },
        processQuality: { type: "number", description: "Score 0-100" },
        efficiency: { type: "number", description: "Score 0-100" },
        confidence: { type: "number", description: "Score 0-100" },
        outcomeAchievementReasoning: { type: "string" },
        processQualityReasoning: { type: "string" },
        efficiencyReasoning: { type: "string" },
        confidenceReasoning: { type: "string" },
        steps_analysis: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    timestamp_seconds: { type: "number" },
                    description: { type: "string" },
                    status: { type: "string", enum: ["success", "failed", "neutral"] }
                }
            }
        }
    },
    required: [
        "summary", "observations", "reasoning",
        "outcomeAchievement", "processQuality", "efficiency", "confidence",
        "outcomeAchievementReasoning", "processQualityReasoning", "efficiencyReasoning", "confidenceReasoning"
    ]
};

// Simple schema for the "Filter" step
const filterSchema = {
    type: "object",
    properties: {
        passed: { type: "boolean", description: "True if the user appears to have completed the main task visually." },
        reason: { type: "string", description: "Brief explanation if failed." }
    },
    required: ["passed", "reason"]
};

export class VideoGrader {
    private genAI: GoogleGenAI;
    private logger: GraderLogger;
    private expertModelName: string;
    private filterModelName: string = "gemini-2.0-flash";
    private maxRetries: number;

    private weights = {
        outcome: 50,
        process: 30,
        efficiency: 20
    };

    constructor(config: GraderConfig, logger?: GraderLogger) {
        if (!config.apiKey) {
            throw new Error("VideoGrader: apiKey is required (GEMINI_API_KEY)");
        }
        this.genAI = new GoogleGenAI({ apiKey: config.apiKey });
        this.logger = logger ?? new DefaultLogger();

        this.expertModelName = config.model || "gemini-2.0-flash";
        this.maxRetries = config.maxRetries ?? 3; // Default to 3 retries
    }

    async evaluateSession(videoPath: string, meta: MetaData): Promise<GradeResult> {
        this.logger.info(`Starting Video Grading for session: ${meta.sessionId}`);
        this.logger.info(`Strategy: Filter (${this.filterModelName}) -> Expert (${this.expertModelName})`);

        let uploadResult;
        try {
            if (!fs.existsSync(videoPath)) {
                throw new Error(`Video file not found: ${videoPath}`);
            }
            const stats = fs.statSync(videoPath);
            if (stats.size === 0) {
                throw new Error(`Video file is empty: ${videoPath}`);
            }
            this.logger.info(`Video size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

            // 1. Upload
            this.logger.debug(`Uploading video: ${videoPath}`);

            uploadResult = await this.genAI.files.upload({
                file: videoPath,
                config: { mimeType: "video/mp4" }
            });

            // 2. Wait for processing
            let file = await this.genAI.files.get({ name: uploadResult.name! });
            let attempts = 0;
            const maxAttempts = 60; // 2 minutes max

            while (file.state === FileState.PROCESSING && attempts < maxAttempts) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                file = await this.genAI.files.get({ name: uploadResult.name! });
                attempts++;
            }

            if (file.state === FileState.FAILED) {
                throw new Error("Video processing failed on Google servers.");
            }
            if (file.state === FileState.PROCESSING) {
                throw new Error("Video processing timed out.");
            }

            this.logger.info(`Video processed successfully. URI: ${file.uri}`);

            // ---------------------------------------------------------
            // STEP 1: THE FILTER - Gemini 1.5/2.0 Flash
            // ---------------------------------------------------------
            this.logger.info("Step 1: Running Filter Check...");

            // Build objectives list for strict filtering
            const objectivesList = meta.quest?.objectives && meta.quest.objectives.length > 0
                ? meta.quest.objectives.map((obj, i) => `${i + 1}. ${obj}`).join('\n')
                : `Complete the task: "${meta.taskDescription || 'Complete the task'}"`;

            const filterPrompt = `
                TASK: Strict Pass/Fail check - The user must complete AT LEAST 50% of the required objectives.

                Required objectives:
                ${objectivesList}

                Watch the video carefully. Evaluate if the user completed at LEAST half (50%) of these objectives.

                CRITICAL REQUIREMENTS:
                - NOT just started or opened an app
                - NOT just partial progress on the first step
                - Must show SUBSTANTIAL progress through the workflow
                - The user must have moved beyond initial setup to actual task execution

                Examples of FAIL:
                - Only opened one application without using it meaningfully
                - Just searched for data without collecting or organizing it
                - Started but didn't complete any significant milestone

                Examples of PASS:
                - Completed multiple objectives (at least 50%)
                - Clear progress visible through the workflow
                - Final deliverable exists or is nearly complete

                Return JSON: { "passed": boolean, "reason": string }
            `;

            const filterResult = await this.executeWithRetry(
                async () => {
                    return await this.genAI.models.generateContent({
                        model: this.filterModelName,
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    { fileData: { mimeType: file.mimeType!, fileUri: file.uri! } },
                                    { text: filterPrompt },
                                ]
                            }
                        ],
                        config: {
                            responseMimeType: "application/json",
                            responseSchema: filterSchema as any
                        }
                    });
                },
                "Filter Check",
                meta.sessionId
            );

            const filterResponse = JSON.parse(filterResult.text!);

            if (!filterResponse.passed) {
                this.logger.warn(`Session filtered out by Flash. Reason: ${filterResponse.reason}`);
                return {
                    version: `${packageJson.version}-video-filtered`,
                    score: 20,
                    outcomeAchievement: 0,
                    processQuality: 0,
                    efficiency: 0,
                    confidence: 100,
                    summary: `Filtered by ${this.filterModelName}. Reason: ${filterResponse.reason}`,
                    observations: "N/A (Filtered)",
                    reasoning: filterResponse.reason,
                    outcomeAchievementReasoning: "Objective not visible in video.",
                    processQualityReasoning: "N/A",
                    efficiencyReasoning: "N/A",
                    confidenceReasoning: "Fast check determined failure."
                };
            }

            this.logger.info("Step 1 Passed. Proceeding to Expert Analysis.");

            // ---------------------------------------------------------
            // STEP 2: THE EXPERT - Gemini 3 Pro (or configured model)
            // ---------------------------------------------------------

            const systemPrompt = VIDEO_GRADING_SYSTEM_PROMPT;
            const userPrompt = getVideoUserPrompt(meta);

            this.logger.debug(`Sending full context to Expert Model (${this.expertModelName})...`);
            const result = await this.executeWithRetry(
                async () => {
                    return await this.genAI.models.generateContent({
                        model: this.expertModelName,
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    { fileData: { mimeType: file.mimeType!, fileUri: file.uri! } },
                                    { text: systemPrompt + "\n\n" + userPrompt },
                                ]
                            }
                        ],
                        config: {
                            responseMimeType: "application/json",
                            responseSchema: gradingSchema as any
                        }
                    });
                },
                "Expert Analysis",
                meta.sessionId
            );

            const responseText = result.text!;
            const evaluation = JSON.parse(responseText);

            // ---------------------------------------------------------
            // STEP 3: SCORING & CALIBRATION (Ported from grader.ts)
            // ---------------------------------------------------------
            let outcome = clamp(evaluation.outcomeAchievement, 0, 100);
            let process = clamp(evaluation.processQuality, 0, 100);
            let efficiency = clamp(evaluation.efficiency, 0, 100);

            // Apply reality checks: cap process/efficiency when outcome is poor
            // Prevents inflated scores from generous AI assessments of trivial actions
            if (outcome < 30) {
                process = Math.min(process, 40);
                efficiency = Math.min(efficiency, 30);
                this.logger.debug(`Applied low-outcome caps: outcome=${outcome} < 30, capped process=${process}, efficiency=${efficiency}`);
            } else if (outcome < 50) {
                process = Math.min(process, 60);
                efficiency = Math.min(efficiency, 50);
                this.logger.debug(`Applied medium-outcome caps: outcome=${outcome} < 50, capped process=${process}, efficiency=${efficiency}`);
            }

            // Determine workflow engagement from metadata
            const isWorkflow = meta.quest?.apps_used && meta.quest.apps_used.length > 0;
            // In video mode, we assume if outcome is high, user engaged in workflow as requested.
            // For strictness, we could parse observations, but trusting the 'passed' filter + metadata is reasonable for V1.
            const workflowEngagement = isWorkflow && outcome > 50;

            const rawScore = this.computeDeterministicScore(outcome, process, efficiency);
            const guardedScore = this.applyBusinessGuards(rawScore, outcome, process, efficiency, workflowEngagement);
            let finalScore = this.calibratePiecewise(guardedScore, outcome);

            // Hard outcome floor for reward qualification (outcome must be ≥50 to qualify)
            if (outcome < 50) {
                finalScore = Math.min(finalScore, 45);
                this.logger.debug(`Applied hard outcome floor: outcome=${outcome} < 50, capped score at 45`);
            }

            this.logger.info(`Grading complete. Raw: ${rawScore} -> Final: ${finalScore}/100`);

            return {
                version: `${packageJson.version}-video`,
                summary: evaluation.summary,
                observations: evaluation.observations,
                reasoning: evaluation.reasoning,
                score: finalScore,
                confidence: evaluation.confidence,
                outcomeAchievement: outcome,
                processQuality: process,
                efficiency: efficiency,
                outcomeAchievementReasoning: evaluation.outcomeAchievementReasoning,
                processQualityReasoning: evaluation.processQualityReasoning,
                efficiencyReasoning: evaluation.efficiencyReasoning,
                confidenceReasoning: evaluation.confidenceReasoning,
                programmaticResults: {
                    videoAnalysis: evaluation.steps_analysis
                }
            };

        } catch (error) {
            this.logger.error("Video Grading failed", error as Error);
            throw error;
        } finally {
            if (uploadResult?.name) {
                try {
                    this.logger.debug(`Deleting remote file: ${uploadResult.name}`);
                    await this.genAI.files.delete({ name: uploadResult.name });
                } catch (cleanupError) {
                    this.logger.warn("Failed to cleanup remote file", cleanupError as Error);
                }
            }
        }
    }

    // --- Ported Logic from grader.ts for score consistency ---

    private computeDeterministicScore(
        outcomeAchievement: number,
        processQuality: number,
        efficiency: number
    ): number {
        const raw = (
            outcomeAchievement * this.weights.outcome +
            processQuality * this.weights.process +
            efficiency * this.weights.efficiency
        ) / 100;
        return Math.round(clamp(raw, 0, 100));
    }

    private applyBusinessGuards(
        _rawScore: number,
        outcome: number,
        process: number,
        eff: number,
        workflowEngagement?: boolean
    ): number {
        // Calculate blended score from all components
        let blended = (outcome * this.weights.outcome + process * this.weights.process + eff * this.weights.efficiency) / 100;

        // Workflow engagement floor - business requirement for payment qualification
        if (workflowEngagement) {
            blended = Math.max(blended, MIN_WORKFLOW_ENGAGEMENT_SCORE);
        }

        // Outcome achievement floors - reward successful completion
        if (outcome >= 70) {
            return Math.max(Math.round(blended), 55); // Strong success floor
        }
        if (outcome >= 50) {
            return Math.max(Math.round(blended), 45); // Partial success floor  
        }

        return Math.round(blended);
    }

    private calibratePiecewise(score: number, outcome: number): number {
        let s = score;

        // Boost mid-range scores where most "good but not perfect" runs fall
        if (score < 35) {
            s = score * 1.07; // Slightly more lift for poor performance
        } else if (score < 70) {
            s = score * 1.18 + 5; // Enhanced boost for mid-range (the key zone)
        } else {
            s = score * 1.04 + 2; // Better boost for high performers
        }

        // Bonus for strong outcome achievement
        if (outcome >= 80) s += 3;

        return clamp(Math.round(s), 0, 100);
    }

    /**
     * Classifies Gemini API errors into Permanent, Transient, or Unknown
     */
    private classifyGeminiError(error: any): GraderError {
        // Extract error details from Gemini API error structure
        let statusCode: number | undefined;
        let message = error?.message || String(error);

        // Gemini API errors come as: { error: { code: number, message: string, status: string } }
        if (error?.error) {
            statusCode = error.error.code;
            message = error.error.message || message;
        }

        // Check for status code in the error object directly
        if (!statusCode && typeof error?.status === 'number') {
            statusCode = error.status;
        }

        this.logger.debug(`Classifying Gemini error: status=${statusCode}, message=${message}`);

        // Permanent errors (4xx client errors except 429)
        if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
            return new PermanentError(
                `Permanent Gemini API error: ${message}`,
                statusCode,
                error
            );
        }

        // Transient errors (5xx server errors and 429 rate limits)
        if (statusCode && (statusCode === 429 || (statusCode >= 500 && statusCode < 600))) {
            return new TransientError(
                `Transient Gemini API error: ${message}`,
                statusCode,
                undefined, // Gemini doesn't provide Retry-After headers consistently
                error
            );
        }

        // Network-related errors
        if (message.toLowerCase().includes('network') ||
            message.toLowerCase().includes('connection') ||
            message.toLowerCase().includes('timeout') ||
            message.toLowerCase().includes('econnreset')) {
            return new TransientError(
                `Network error: ${message}`,
                undefined,
                undefined,
                error
            );
        }

        // Default to transient for unknown errors (conservative approach)
        return new TransientError(
            `Unknown Gemini error (treating as transient): ${message}`,
            statusCode,
            undefined,
            error
        );
    }

    /**
     * Executes a Gemini API call with retry logic and exponential backoff
     */
    private async executeWithRetry<T>(
        operation: () => Promise<T>,
        operationName: string,
        sessionId: string
    ): Promise<T> {
        let attempt = 0;
        let lastError: GraderError | undefined;
        const retryDelays: number[] = [];

        while (attempt < this.maxRetries) {
            try {
                this.logger.debug(`${operationName}: Attempt ${attempt + 1}/${this.maxRetries}`, undefined, { sessionId });
                const result = await operation();

                if (attempt > 0) {
                    this.logger.info(`${operationName}: Succeeded after ${attempt} retries`, undefined, {
                        sessionId,
                        attempt,
                        retryDelays
                    });
                }

                return result;
            } catch (error: any) {
                const classifiedError = this.classifyGeminiError(error);
                lastError = classifiedError;
                attempt++;

                // Handle permanent errors immediately (no retry)
                if (classifiedError instanceof PermanentError) {
                    this.logger.error(`${operationName}: Permanent error; no retry`, classifiedError, {
                        sessionId,
                        statusCode: classifiedError.statusCode,
                        attempt
                    });
                    throw classifiedError;
                }

                // Handle transient errors with exponential backoff
                if (classifiedError instanceof TransientError) {
                    if (attempt >= this.maxRetries) {
                        this.logger.error(`${operationName}: Max retries reached`, classifiedError, {
                            sessionId,
                            statusCode: classifiedError.statusCode,
                            totalAttempts: attempt,
                            retryDelays
                        });
                        break;
                    }

                    // Exponential backoff: 500ms * 2^(attempt-1) + jitter, capped at 8s
                    const delay = Math.min(8000, 500 * Math.pow(2, attempt - 1)) + Math.random() * 250;
                    retryDelays.push(delay);

                    this.logger.warn(`${operationName}: Transient error; retrying with backoff`, classifiedError, {
                        sessionId,
                        attempt,
                        delay: `${Math.round(delay)}ms`,
                        statusCode: classifiedError.statusCode,
                        maxRetries: this.maxRetries
                    });

                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                // Fallback for unknown error types
                if (attempt >= this.maxRetries) {
                    this.logger.error(`${operationName}: Max retries reached`, classifiedError, {
                        sessionId,
                        totalAttempts: attempt,
                        retryDelays
                    });
                    break;
                }

                const delay = Math.min(8000, 500 * Math.pow(2, attempt - 1)) + Math.random() * 250;
                retryDelays.push(delay);

                this.logger.warn(`${operationName}: Unknown error; retrying with backoff`, classifiedError, {
                    sessionId,
                    attempt,
                    delay: `${Math.round(delay)}ms`,
                    maxRetries: this.maxRetries
                });

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // All retries exhausted
        throw lastError || new TransientError(`${operationName} failed after ${this.maxRetries} retries`);
    }
}
