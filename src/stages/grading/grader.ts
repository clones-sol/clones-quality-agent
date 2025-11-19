import OpenAI from "openai";
import { z } from "zod";
import {
    DEFAULT_CRITERIA,
    DEFAULT_MAX_IMAGES,
    DEFAULT_MAX_RETRIES,
    DEFAULT_MAX_TEXT_LEN,
    DEFAULT_MODEL,
    DEFAULT_SEED,
    DEFAULT_TIMEOUT_MS,
} from "./grader/constants";
import { PermanentError, GraderError, TimeoutError, TransientError } from "./grader/errors";
import { DefaultLogger } from "./grader/logger";
import { RateLimiter } from "./grader/rate-limiter";
import {
    CHUNK_EVALUATION_SCHEMA,
    ChunkEvaluationSchema,
    FINAL_EVALUATION_SCHEMA,
    FinalEvaluationSchema,
} from "./grader/schemas";
import { getChaosHeader, getChaosRubric, getGuidelines, getFinalUserPrompt } from "./grader/prompts";
import {
    Chunk,
    EvaluationCriteria,
    GradeResult,
    GraderConfig,
    GraderLogger,
    MetaData,
    MetricsHook,
    ProgrammaticGrader,
    RequestMetrics,
    WorkflowApp,
} from "./grader/types";
import { clamp, classifyError, sanitizeUserInput, sleep, safeExtractJson } from "./grader/utils";
import packageJson from "../../../package.json";


/* =========================
 * Grader
 * ========================= */

export class Grader {
    private client: OpenAI;
    private logger: GraderLogger;
    private rateLimiter: RateLimiter;
    private metricsHook?: MetricsHook;

    private readonly model: string;
    private readonly timeout: number;
    private readonly maxRetries: number;
    private readonly chunkSize: number;
    private readonly maxImagesPerChunk: number;
    private readonly maxTextPerMessage: number;
    private readonly seed: number;
    private readonly version: string;
    private readonly evaluationModel: string;

    private criteria: EvaluationCriteria;
    private programmaticGrader?: ProgrammaticGrader;

    constructor(config: GraderConfig, logger?: GraderLogger) {
        if (!config || !config.apiKey || typeof config.apiKey !== "string" || !config.apiKey.trim()) {
            throw new Error("Grader: OPENAI_API_KEY is missing or empty.");
        }

        this.version = packageJson.version;

        // Numeric normalization
        const rawChunk = config.chunkSize;
        const normalizedChunk =
            typeof rawChunk === "number" && Number.isFinite(rawChunk) && rawChunk > 0 ? rawChunk : 4;

        const rawRetries = config.maxRetries;
        const normalizedRetries =
            typeof rawRetries === "number" && Number.isFinite(rawRetries) && rawRetries > 0
                ? rawRetries
                : DEFAULT_MAX_RETRIES;

        const rawTimeout = config.timeout;
        const normalizedTimeout =
            typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
                ? rawTimeout
                : DEFAULT_TIMEOUT_MS;

        const rawMaxImages = config.maxImagesPerChunk;
        const normalizedImages =
            typeof rawMaxImages === "number" && Number.isFinite(rawMaxImages) && rawMaxImages > 0
                ? rawMaxImages
                : DEFAULT_MAX_IMAGES;

        const rawMaxText = config.maxTextPerMessage;
        const normalizedText =
            typeof rawMaxText === "number" && Number.isFinite(rawMaxText) && rawMaxText > 0
                ? rawMaxText
                : DEFAULT_MAX_TEXT_LEN;

        const rawSeed = config.seed;
        const normalizedSeed =
            typeof rawSeed === "number" && Number.isFinite(rawSeed)
                ? Math.floor(rawSeed)
                : DEFAULT_SEED;

        this.client = new OpenAI({ apiKey: config.apiKey });
        this.logger = logger ?? new DefaultLogger();
        this.programmaticGrader = config.programmaticGrader;

        // Initialize rate limiter
        const rateLimiterConfig = config.rateLimiter || {};
        const maxTokens = rateLimiterConfig.maxTokens && rateLimiterConfig.maxTokens > 0
            ? rateLimiterConfig.maxTokens : 10;
        const refillRate = rateLimiterConfig.refillRate && rateLimiterConfig.refillRate > 0
            ? rateLimiterConfig.refillRate : 2;
        this.rateLimiter = new RateLimiter(maxTokens, refillRate);

        // Initialize metrics hook
        this.metricsHook = config.onMetrics;

        this.model = (config.model && config.model.trim()) || DEFAULT_MODEL;
        this.evaluationModel = (config.evaluationModel && config.evaluationModel.trim()) || this.model;
        this.timeout = normalizedTimeout;
        this.maxRetries = normalizedRetries;
        this.chunkSize = normalizedChunk;
        this.maxImagesPerChunk = normalizedImages;
        this.maxTextPerMessage = normalizedText;
        this.seed = normalizedSeed;

        this.criteria = {
            outcomeAchievement: { weight: DEFAULT_CRITERIA.outcomeAchievement.weight },
            processQuality: { weight: DEFAULT_CRITERIA.processQuality.weight },
            efficiency: { weight: DEFAULT_CRITERIA.efficiency.weight },
        };
    }

    /* ----- Public API ----- */

    getChunkSize() {
        return this.chunkSize;
    }

    updateEvaluationCriteria(partial: Partial<EvaluationCriteria>) {
        const next: EvaluationCriteria = {
            outcomeAchievement: { ...this.criteria.outcomeAchievement },
            processQuality: { ...this.criteria.processQuality },
            efficiency: { ...this.criteria.efficiency },
        };

        // Validate individual weights before assignment
        if (partial.outcomeAchievement?.weight != null) {
            const w = Number(partial.outcomeAchievement.weight);
            if (!Number.isFinite(w) || w <= 0) {
                throw new Error(`Evaluation criteria weights must be positive and finite (got outcomeAchievement: ${w}).`);
            }
            next.outcomeAchievement.weight = w;
        }
        if (partial.processQuality?.weight != null) {
            const w = Number(partial.processQuality.weight);
            if (!Number.isFinite(w) || w <= 0) {
                throw new Error(`Evaluation criteria weights must be positive and finite (got processQuality: ${w}).`);
            }
            next.processQuality.weight = w;
        }
        if (partial.efficiency?.weight != null) {
            const w = Number(partial.efficiency.weight);
            if (!Number.isFinite(w) || w <= 0) {
                throw new Error(`Evaluation criteria weights must be positive and finite (got efficiency: ${w}).`);
            }
            next.efficiency.weight = w;
        }

        // Normalize weights to ensure they sum to exactly 100 (our scale)
        const rawSum =
            next.outcomeAchievement.weight + next.processQuality.weight + next.efficiency.weight;

        // Normalize to sum to 100 (use precise floats, round only in score calculation)
        next.outcomeAchievement.weight = (next.outcomeAchievement.weight / rawSum) * 100;
        next.processQuality.weight = (next.processQuality.weight / rawSum) * 100;
        next.efficiency.weight = (next.efficiency.weight / rawSum) * 100;

        this.criteria = next;
    }

    getEvaluationCriteria(): EvaluationCriteria {
        return { ...this.criteria };
    }

    getRateLimiterStats(): { tokens: number; queueLength: number } {
        return this.rateLimiter.getStats();
    }

    private async emitMetrics(metrics: RequestMetrics): Promise<void> {
        if (!this.metricsHook) return;

        try {
            await this.metricsHook(metrics);
        } catch (error) {
            this.logger.warn("Metrics hook failed", error as Error, {
                sessionId: metrics.context.sessionId,
                responseId: metrics.responseId
            });
        }
    }

    /**
     * Evaluate a full session.
     */
    async evaluateSession(chunks: Chunk[], meta: MetaData): Promise<GradeResult> {
        const isWorkflow = !!(meta.quest?.apps_used && meta.quest.apps_used.length > 0);
        const expectedApps = isWorkflow ? meta.quest!.apps_used! : [];

        this.logger.debug(`Evaluating ${isWorkflow ? 'WORKFLOW' : 'single-app'} session with ${chunks.length} chunks`, undefined, {
            sessionId: meta.sessionId,
            isWorkflow,
            chunkCount: chunks.length
        });
        if (isWorkflow) {
            this.logger.debug(`Expected workflow apps: ${expectedApps.map(a => `${a.name} (${a.domain})`).join(', ')}`, undefined, {
                sessionId: meta.sessionId,
                expectedApps: expectedApps.map(a => a.name)
            });
        }

        // Count app_focus events across all chunks - workflow-aware
        let appFocusCount = 0;
        let detectedApps = new Set<string>();
        let detectedDomains = new Set<string>();
        const workflowAppCoverage = new Map<string, number>();

        chunks.forEach((chunk) => {
            chunk.forEach((item) => {
                if (item.type === 'app_focus') {
                    appFocusCount++;
                    const focusedApp = item.data?.focused_app;
                    const browserDomain = (item.data as any)?.browser_domain;
                    const focusedAppWithDomain = (item.data as any)?.focused_app_with_domain;

                    if (focusedApp && focusedApp !== 'Unknown') {
                        const appKey = focusedAppWithDomain || focusedApp;
                        detectedApps.add(appKey);

                        // Track workflow app coverage
                        if (isWorkflow) {
                            expectedApps.forEach(expectedApp => {
                                if (this.isAppMatch(focusedApp, expectedApp, browserDomain)) {
                                    workflowAppCoverage.set(expectedApp.name, (workflowAppCoverage.get(expectedApp.name) || 0) + 1);
                                }
                            });
                        }

                        if (browserDomain) {
                            detectedDomains.add(browserDomain);
                        }
                    }
                }
            });
        });

        if (isWorkflow) {
            const coveredApps = Array.from(workflowAppCoverage.keys());
            const missedApps = expectedApps.filter(app => !workflowAppCoverage.has(app.name));
            this.logger.debug(`Workflow coverage: ${coveredApps.length}/${expectedApps.length} apps used`, undefined, {
                sessionId: meta.sessionId,
                coveredCount: coveredApps.length,
                totalExpected: expectedApps.length
            });
            this.logger.debug(`Covered apps: [${coveredApps.join(', ')}]`, undefined, {
                sessionId: meta.sessionId,
                coveredApps
            });
            if (missedApps.length > 0) {
                this.logger.debug(`Missed workflow apps: [${missedApps.map(a => a.name).join(', ')}]`, undefined, {
                    sessionId: meta.sessionId,
                    missedApps: missedApps.map(a => a.name)
                });
            }
        } else {
            const domainsInfo = detectedDomains.size > 0 ? `, detected domains: [${Array.from(detectedDomains).join(', ')}]` : '';
            this.logger.debug(`Found ${appFocusCount} app_focus events, detected apps: [${Array.from(detectedApps).join(', ')}]${domainsInfo}`, undefined, {
                sessionId: meta.sessionId,
                appFocusCount,
                detectedApps: Array.from(detectedApps)
            });
        }
        const summaries: string[] = [];
        let prevSummary: string | null = null;

        for (let i = 0; i < chunks.length; i++) {
            const summary = await this.evaluateChunk(chunks[i], meta, prevSummary, i, chunks.length);
            summaries.push(summary);
            prevSummary = summary;
        }

        return await this.finalizeEvaluation(summaries, chunks, meta, isWorkflow, expectedApps);
    }

    /* ----- Core Steps ----- */

    private countActionsInChunk(chunk: Chunk): number {
        let actionCount = 0;
        for (const item of chunk) {
            if (item.type === "text" && item.text) {
                // Look for action patterns like click(), type(), scroll(), key(), etc.
                const actionPatterns = [
                    /\bclick\s*\(/gi,
                    /\btype\s*\(/gi,
                    /\bscroll\s*\(/gi,
                    /\bkey\s*\(/gi,
                    /\bdrag\s*\(/gi,
                    /\bmove\s*\(/gi,
                    /\bpress\s*\(/gi,
                    /\brelease\s*\(/gi
                ];

                for (const pattern of actionPatterns) {
                    const matches = item.text.match(pattern);
                    if (matches) {
                        actionCount += matches.length;
                    }
                }
            }
        }
        return actionCount;
    }

    private async evaluateChunk(
        chunk: Chunk,
        meta: MetaData,
        prevSummary: string | null,
        chunkIndex: number,
        totalChunks: number
    ): Promise<string> {
        const actionCount = this.countActionsInChunk(chunk);

        // Count app_focus events in this chunk
        let chunkAppFocusCount = 0;
        const chunkAppFocusApps = new Set<string>();
        chunk.forEach((item) => {
            if (item.type === 'app_focus') {
                chunkAppFocusCount++;
                const focusedApp = item.data?.focused_app;
                const focusedAppWithDomain = (item.data as any)?.focused_app_with_domain;
                if (focusedApp && focusedApp !== 'Unknown') {
                    // Use app with domain if available for better tracking
                    chunkAppFocusApps.add(focusedAppWithDomain || focusedApp);
                }
            }
        });

        const systemPrompt = this.buildSystemPrompt(meta, prevSummary, false, chunkIndex, totalChunks, actionCount);

        // Add app_focus statistics to chunk evaluation
        const appFocusInfo = chunkAppFocusCount > 0
            ? `[Application Context] This chunk contains ${chunkAppFocusCount} app_focus event(s) showing focus on: ${Array.from(chunkAppFocusApps).join(', ')}. ` +
            `Use this to confirm which app was active. Now analyze the screenshots and actions below.\n`
            : '';

        const userContent = this.formatMessageContent(chunk);

        // Add app focus info as first text item if present
        if (appFocusInfo) {
            userContent.unshift({ type: "text", text: appFocusInfo });
        }

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
        ];

        const response = await this.callModelWithRetries(
            messages,
            ChunkEvaluationSchema,
            { sessionId: meta.sessionId, chunkIndex, totalChunks, isFinal: false },
            this.model
        );

        // With structured outputs, response is already validated.
        return response.summary.trim();
    }

    private async finalizeEvaluation(summaries: string[], chunks: Chunk[], meta: MetaData, isWorkflow: boolean, expectedApps: WorkflowApp[]): Promise<GradeResult> {
        // Count app_focus events across all chunks for final evaluation
        const appFocusCounts = new Map<string, number>();
        let totalAppFocusEvents = 0;

        chunks.forEach((chunk) => {
            chunk.forEach((item) => {
                if (item.type === 'app_focus') {
                    totalAppFocusEvents++;
                    const focusedApp = item.data?.focused_app;
                    const focusedAppWithDomain = (item.data as any)?.focused_app_with_domain;
                    if (focusedApp && focusedApp !== 'Unknown') {
                        // Use app with domain for statistics to track webapp usage
                        const appKey = focusedAppWithDomain || focusedApp;
                        appFocusCounts.set(appKey, (appFocusCounts.get(appKey) || 0) + 1);
                    }
                }
            });
        });

        // Format app_focus statistics for prompt
        const appFocusStats = Array.from(appFocusCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([app, count]) => {
                const percentage = totalAppFocusEvents > 0 ? ((count / totalAppFocusEvents) * 100).toFixed(1) : '0';
                return `  • ${app}: ${count} events (${percentage}%)`;
            })
            .join('\n');

        const systemPrompt = this.buildSystemPrompt(
            meta,
            null,
            true,
            summaries.length - 1,
            summaries.length,
            undefined // No action count for final evaluation
        );

        const finalUserText = getFinalUserPrompt(
            !!isWorkflow,
            expectedApps,
            totalAppFocusEvents,
            appFocusStats,
            summaries
        );

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: [{ type: "text", text: this.truncate(finalUserText, this.maxTextPerMessage) }] },
        ];

        const validated = await this.callModelWithRetries(
            messages,
            FinalEvaluationSchema,
            { sessionId: meta.sessionId, isFinal: true },
            this.evaluationModel
        );

        // Use validated data but still apply deterministic scoring
        let outcome = clamp(validated.outcomeAchievement, 0, 100);
        let process = clamp(validated.processQuality, 0, 100);
        let eff = clamp(validated.efficiency, 0, 100);
        let confidence = clamp(validated.confidence, 0, 100);

        // Run programmatic graders and apply bonus if core objectives are met
        let requiredActionsMet = false;
        if (this.programmaticGrader) {
            try {
                if (typeof this.programmaticGrader.checkRequiredActions === "function") {
                    requiredActionsMet = this.programmaticGrader.checkRequiredActions(chunks, meta.requirements ?? []);
                    if (requiredActionsMet && outcome < 70) {
                        // Boost outcome for meeting core requirements
                        outcome = Math.max(outcome, 70);
                        this.logger.debug(`Applied programmatic grader bonus: core requirements met, outcome boosted to ${outcome}`);
                    }
                }
            } catch (error) {
                this.logger.error("Programmatic grader 'checkRequiredActions' failed during evaluation", error as Error, { sessionId: meta.sessionId });
            }
        }

        // Apply confidence realism based on evidence quality
        const evidenceCount = this.estimateEvidenceCount(validated.summary, validated.observations, validated.reasoning);
        const hasStrongProgrammaticEvidence = requiredActionsMet;

        // Lower confidence when evidence is sparse
        if (evidenceCount < 3) {
            confidence = Math.min(confidence, 70);
            this.logger.debug(`Confidence capped at 70 due to sparse evidence (count: ${evidenceCount})`);
        }

        // Lower confidence when outcome is very low despite strong programmatic evidence (contradiction)
        if (outcome <= 10 && hasStrongProgrammaticEvidence) {
            confidence = Math.min(confidence, 60);
            this.logger.debug(`Confidence capped at 60 due to contradiction: low outcome but strong programmatic evidence`);
        }

        // Detect workflow engagement for business rules
        const workflowEngagement = this.detectWorkflowEngagement(chunks, meta);

        // Deterministic final score with business guards and calibration
        const rawScore = this.computeDeterministicScore(outcome, process, eff);
        const guardedScore = this.applyBusinessGuards(rawScore, outcome, process, eff, workflowEngagement);
        const finalScore = this.calibratePiecewise(guardedScore, outcome);

        // Log score transformation for audit purposes
        this.logger.debug(`Score transformation: raw=${rawScore} → guarded=${guardedScore} → final=${finalScore}`);

        // Emit evaluation metrics with score breakdown for audit
        if (this.metricsHook) {
            try {
                await this.metricsHook({
                    responseId: `eval-${meta.sessionId}`,
                    outcome: 'success' as const,
                    timing: {
                        startTime: Date.now(),
                        endTime: Date.now(),
                        durationMs: 0,
                        retryCount: 0,
                        retryDelays: []
                    },
                    context: {
                        sessionId: meta.sessionId,
                        isFinal: true,
                        chunkIndex: 0,
                        totalChunks: 1,
                        // Add custom score breakdown for audit
                        scoreBreakdown: { rawScore, guardedScore, finalScore, outcome, process, eff }
                    } as any
                });
            } catch (error) {
                this.logger.warn("Evaluation metrics hook failed", error as Error, { sessionId: meta.sessionId });
            }
        }

        // Run remaining programmatic graders
        let programmaticResults: any = undefined;
        if (this.programmaticGrader) {
            programmaticResults = { requiredActionsMet };

            // evaluateCompletionTime
            try {
                if (typeof this.programmaticGrader.evaluateCompletionTime === "function") {
                    programmaticResults.completionTime = this.programmaticGrader.evaluateCompletionTime(chunks);
                }
            } catch (error) {
                this.logger.error("Programmatic grader 'evaluateCompletionTime' failed", error as Error, { sessionId: meta.sessionId });
            }

            // calculateEfficiencyMetrics
            try {
                if (typeof this.programmaticGrader.calculateEfficiencyMetrics === "function") {
                    programmaticResults.efficiencyMetrics = this.programmaticGrader.calculateEfficiencyMetrics(chunks);
                }
            } catch (error) {
                this.logger.error("Programmatic grader 'calculateEfficiencyMetrics' failed", error as Error, { sessionId: meta.sessionId });
            }
        }

        return {
            version: this.version,
            summary: validated.summary.trim(),
            observations: validated.observations.trim(),
            reasoning: validated.reasoning.trim(),
            score: finalScore,
            confidence,
            outcomeAchievement: outcome,
            processQuality: process,
            efficiency: eff,
            outcomeAchievementReasoning: validated.outcomeAchievementReasoning.trim(),
            processQualityReasoning: validated.processQualityReasoning.trim(),
            efficiencyReasoning: validated.efficiencyReasoning.trim(),
            confidenceReasoning: validated.confidenceReasoning.trim(),
            programmaticResults,
        };
    }

    /* ----- OpenAI Call w/ Retries, Backoff, Timeout ----- */

    private async callModelWithRetries<T>(
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        schema: z.ZodSchema<T>,
        meta: Record<string, unknown> & { isFinal: boolean },
        model: string
    ): Promise<T> {
        let attempt = 0;
        let lastError: GraderError | undefined;
        const startTime = Date.now();
        const retryDelays: number[] = [];

        while (attempt < this.maxRetries) {
            try {
                const result = await this.createChatCompletionWithTimeout(messages, schema, model, meta.isFinal);

                // Emit success metrics
                const endTime = Date.now();
                await this.emitMetrics({
                    responseId: result.id,
                    systemFingerprint: result.system_fingerprint || undefined,
                    usage: result.usage ? {
                        promptTokens: result.usage?.prompt_tokens || 0,
                        completionTokens: result.usage?.completion_tokens || 0,
                        totalTokens: result.usage?.total_tokens || 0
                    } : undefined,
                    timing: {
                        startTime,
                        endTime,
                        durationMs: endTime - startTime,
                        retryCount: attempt,
                        retryDelays
                    },
                    context: {
                        sessionId: String(meta.sessionId || 'unknown'),
                        chunkIndex: typeof meta.chunkIndex === 'number' ? meta.chunkIndex : undefined,
                        totalChunks: typeof meta.totalChunks === 'number' ? meta.totalChunks : undefined,
                        isFinal: !!meta.isFinal,
                        model
                    },
                    outcome: 'success'
                });

                return result.data;
            } catch (err) {
                const classifiedError = classifyError(err);
                lastError = classifiedError;
                attempt++;

                // Handle permanent errors immediately (no retry)
                if (classifiedError instanceof PermanentError) {
                    this.logger.error("Permanent error encountered; no retry.", classifiedError, {
                        ...meta,
                        statusCode: classifiedError.statusCode,
                        attempt
                    });

                    // Emit permanent error metrics
                    const endTime = Date.now();
                    await this.emitMetrics({
                        timing: {
                            startTime,
                            endTime,
                            durationMs: endTime - startTime,
                            retryCount: attempt - 1,
                            retryDelays
                        },
                        context: {
                            sessionId: String(meta.sessionId || 'unknown'),
                            chunkIndex: typeof meta.chunkIndex === 'number' ? meta.chunkIndex : undefined,
                            totalChunks: typeof meta.totalChunks === 'number' ? meta.totalChunks : undefined,
                            isFinal: !!meta.isFinal,
                            model
                        },
                        outcome: 'permanent_error',
                        error: {
                            type: classifiedError.constructor.name,
                            message: classifiedError.message,
                            statusCode: classifiedError.statusCode
                        }
                    });

                    throw classifiedError;
                }

                // Handle timeout errors
                if (classifiedError instanceof TimeoutError) {
                    this.logger.warn("Request timed out; retrying.", classifiedError, {
                        ...meta,
                        attempt,
                        maxRetries: this.maxRetries
                    });
                }

                // Handle transient errors
                if (classifiedError instanceof TransientError) {
                    let delay: number;

                    // Use Retry-After header if provided, otherwise use exponential backoff
                    if (classifiedError.retryAfter !== undefined) {
                        delay = Math.min(30000, classifiedError.retryAfter); // Cap at 30 seconds
                        this.logger.warn("Transient error with Retry-After; using server-specified delay.", classifiedError, {
                            ...meta,
                            attempt,
                            retryAfterMs: delay,
                            statusCode: classifiedError.statusCode
                        });
                    } else {
                        delay = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
                        this.logger.warn("Transient error; retrying with exponential backoff.", classifiedError, {
                            ...meta,
                            attempt,
                            delay,
                            statusCode: classifiedError.statusCode
                        });
                    }

                    if (attempt >= this.maxRetries) break;
                    retryDelays.push(delay);
                    await sleep(delay);
                    continue;
                }

                // Fallback for unknown error types
                const delay = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 250;
                this.logger.warn("Unknown error type; retrying with backoff.", classifiedError, {
                    ...meta,
                    attempt,
                    delay,
                });
                if (attempt >= this.maxRetries) break;
                retryDelays.push(delay);
                await sleep(delay);
            }
        }

        this.logger.error("Model call failed after max retries.", lastError, {
            ...meta,
            finalAttempt: attempt
        });

        // Emit final error metrics
        const endTime = Date.now();
        const outcome = lastError instanceof TimeoutError ? 'timeout' : 'transient_error';
        await this.emitMetrics({
            timing: {
                startTime,
                endTime,
                durationMs: endTime - startTime,
                retryCount: attempt,
                retryDelays
            },
            context: {
                sessionId: String(meta.sessionId || 'unknown'),
                chunkIndex: typeof meta.chunkIndex === 'number' ? meta.chunkIndex : undefined,
                totalChunks: typeof meta.totalChunks === 'number' ? meta.totalChunks : undefined,
                isFinal: !!meta.isFinal,
                model
            },
            outcome,
            error: {
                type: lastError?.constructor.name || 'UnknownError',
                message: lastError?.message || 'Model call failed after retries',
                statusCode: lastError instanceof TransientError ? lastError.statusCode : undefined
            }
        });

        throw lastError || new TransientError("Model call failed after retries");
    }

    private async createChatCompletionWithTimeout<T>(
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        schema: z.ZodSchema<T>,
        model: string,
        isFinal: boolean
    ) {
        // Acquire rate limiter token before making request
        await this.rateLimiter.acquire();

        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await this.client.chat.completions.create({
                model: model,
                temperature: 0,
                top_p: 1,
                presence_penalty: 0,
                frequency_penalty: 0,
                seed: this.seed,
                messages,
                // Constrain output tokens to control cost.
                max_tokens: isFinal ? 1200 : 300,
                tool_choice: { type: "function", function: { name: "submit_evaluation" } },
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "submit_evaluation",
                            description: "Submit the evaluation results.",
                            parameters: isFinal ? FINAL_EVALUATION_SCHEMA : CHUNK_EVALUATION_SCHEMA,
                        },
                    },
                ],
            }, {
                signal: controller.signal,
            });

            const argumentsJson = this.extractFunctionCallArguments(response);
            const parsedArguments = this.parseFunctionCallArguments(argumentsJson);
            const data = schema.parse(parsedArguments);

            return {
                data,
                id: response.id,
                system_fingerprint: response.system_fingerprint,
                usage: response.usage,
            };

        } finally {
            clearTimeout(to);
        }
    }

    private extractFunctionCallArguments(
        resp: OpenAI.Chat.Completions.ChatCompletion
    ): string {
        const choice = resp.choices?.[0];
        const msg = choice?.message;

        // Try tool calls first (structured outputs)
        if (msg?.tool_calls?.[0]) {
            const toolCall = msg.tool_calls[0];
            if (toolCall.type !== "function" || !toolCall.function?.arguments) {
                throw new Error("Invalid tool call structure.");
            }
            return toolCall.function.arguments;
        }

        // Fallback to raw content parsing for backward compatibility
        if (msg?.content) {
            return msg.content;
        }

        throw new Error("No tool calls found in response.");
    }

    /* ----- Parsing / Scoring / Prompt / Content ----- */

    private parseFunctionCallArguments(jsonString: string): any {
        try {
            return JSON.parse(jsonString);
        } catch (e) {
            // Try fallback JSON extraction for raw content (fenced blocks, balanced braces)
            const extracted = safeExtractJson(jsonString);
            if (extracted) {
                try {
                    return JSON.parse(extracted);
                } catch (extractedError) {
                    this.logger.error("Failed to parse extracted JSON.", extractedError as Error, {
                        originalLength: jsonString.length,
                        extractedLength: extracted.length
                    });
                }
            }

            this.logger.error("Failed to parse function call arguments.", e as Error, {
                argumentsLength: jsonString.length
            });
            throw new Error("Invalid JSON in function call arguments.");
        }
    }

    private computeDeterministicScore(
        outcomeAchievement: number,
        processQuality: number,
        efficiency: number
    ): number {
        const { outcomeAchievement: o, processQuality: p, efficiency: e } = this.criteria;
        const raw = (outcomeAchievement * o.weight + processQuality * p.weight + efficiency * e.weight) / 100;

        // Single rounding at the end for maximum precision
        return Math.round(clamp(raw, 0, 100));
    }

    private applyBusinessGuards(_rawScore: number, outcome: number, process: number, eff: number, workflowEngagement?: boolean): number {
        // Cap efficiency penalty impact to max 15 points
        const effPenaltyCap = 15;
        const baseFromOutcomeProcess =
            (outcome * this.criteria.outcomeAchievement.weight + process * this.criteria.processQuality.weight) / 100;
        const effComponent = (eff * this.criteria.efficiency.weight) / 100;

        // Efficiency doesn't add above 0, and cannot penalize beyond the cap
        let blended = baseFromOutcomeProcess + Math.min(0, effComponent);
        blended = Math.max(blended, baseFromOutcomeProcess - effPenaltyCap);

        // Workflow engagement floor - business requirement for payment qualification
        if (workflowEngagement) {
            blended = Math.max(blended, 50);
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

    private isAppMatch(focusedApp: string, expectedApp: any, browserDomain?: string): boolean {
        const lowerFocused = focusedApp.toLowerCase();
        const lowerExpected = expectedApp.name.toLowerCase();

        // Exact match is preferred
        if (lowerFocused === lowerExpected) {
            return true;
        }

        // Word boundary match for partial matches (e.g., "Microsoft Word" contains "Word")
        const escapedExpected = lowerExpected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const isNameMatch = new RegExp(`\\b${escapedExpected}\\b`, 'i').test(lowerFocused);

        // Domain match for web apps
        const isDomainMatch = !!(browserDomain && (
            browserDomain === expectedApp.domain ||
            browserDomain.endsWith('.' + expectedApp.domain)
        ));

        return isNameMatch || isDomainMatch;
    }

    private detectWorkflowEngagement(chunks: Chunk[], meta: MetaData): boolean {
        const isWorkflow = meta.quest?.apps_used && meta.quest.apps_used.length > 0;
        if (!isWorkflow) return false;

        const expectedApps = meta.quest!.apps_used!;
        const workflowAppCoverage = new Map<string, number>();

        chunks.forEach((chunk) => {
            chunk.forEach((item) => {
                if (item.type === 'app_focus') {
                    const focusedApp = item.data?.focused_app;
                    const browserDomain = (item.data as any)?.browser_domain;

                    if (focusedApp && focusedApp !== 'Unknown') {
                        expectedApps.forEach(expectedApp => {
                            if (this.isAppMatch(focusedApp, expectedApp, browserDomain)) {
                                workflowAppCoverage.set(expectedApp.name, (workflowAppCoverage.get(expectedApp.name) || 0) + 1);
                            }
                        });
                    }
                }
            });
        });

        // Consider workflow engaged if user touched at least 2 expected apps or significant usage of 1 app
        const appsUsed = workflowAppCoverage.size;
        const totalEvents = Array.from(workflowAppCoverage.values()).reduce((sum, count) => sum + count, 0);

        return appsUsed >= 2 || (appsUsed >= 1 && totalEvents >= 3);
    }

    private estimateEvidenceCount(summary: string, observations: string, reasoning: string): number {
        // Combine all evaluation text
        const combinedText = `${summary} ${observations} ${reasoning}`.toLowerCase();

        // Look for evidence markers and specific citations
        const evidenceMarkers = [
            /the user \w+/g,  // "the user clicked", "the user typed"
            /screenshot shows/g,
            /visible in/g,
            /text contains/g,
            /button appears/g,
            /form field/g,
            /navigation to/g,
            /error message/g,
            /success message/g,
            /page loads/g,
            /element selected/g,
            /action completed/g,
            /step \d+/g,  // numbered steps
            /•\s*\w+/g,   // bullet points with content
            /\d+\.\s*\w+/g // numbered lists
        ];

        let evidenceCount = 0;
        evidenceMarkers.forEach(pattern => {
            const matches = combinedText.match(pattern);
            evidenceCount += matches ? matches.length : 0;
        });

        // Bonus for detailed observations (structured content)
        const structuredLines = observations.split('\n').filter(line =>
            line.trim().match(/^([-•+*]|\d+\.)/)).length;
        evidenceCount += structuredLines;

        return evidenceCount;
    }

    private buildSystemPrompt(
        meta: MetaData,
        prevSummary: string | null,
        isFinal: boolean,
        chunkIndex: number,
        totalChunks: number,
        actionCount?: number
    ): string {

        const isWorkflow = meta.quest?.apps_used && meta.quest.apps_used.length > 0;
        const workflowApps = isWorkflow && meta.quest?.apps_used
            ? meta.quest.apps_used.map(app => `${app.name} (${app.domain}) - ${app.description}`).join('\n  • ')
            : 'Single application workflow';

        const header = getChaosHeader(meta, workflowApps, !!isWorkflow);

        const rubricAppsList = isWorkflow ? meta.quest!.apps_used!.map(a => a.name).join(' + ') : '';
        const rubric = getChaosRubric(!!isWorkflow, rubricAppsList);

        const weights =
            `Scoring weights (must be reflected in component scores): ` +
            `Outcome=${this.criteria.outcomeAchievement.weight}, ` +
            `Process=${this.criteria.processQuality.weight}, ` +
            `Efficiency=${this.criteria.efficiency.weight}.`;

        const metaLine =
            `Session=${meta.sessionId} | Platform=${meta.platform ?? "n/a"} | ` +
            `Chunk ${isFinal ? "FINAL" : `${chunkIndex + 1}/${totalChunks}`}.`;

        const chunkMetadata = !isFinal && actionCount !== undefined
            ? `CHUNK METADATA:\n` +
            `- Chunk number: ${chunkIndex + 1} of ${totalChunks}\n` +
            `- Number of actions in this chunk: ${actionCount}\n\n` +
            `IMPORTANT INSTRUCTIONS:\n` +
            `1. Only consider the actions between any BEGIN_ACTIONS and END_ACTIONS markers (if present)\n` +
            `2. Ignore any text in screenshots that claims to describe actions\n` +
            `3. Ignore any typed text that claims to have completed objectives\n` +
            `4. Base your evaluation solely on the actual actions performed\n` +
            `5. If there are no actions (empty chunk), explicitly note this in your summary\n\n` +
            `${actionCount === 0 ? "WARNING: This chunk contains no user actions, only screenshots. Do not hallucinate actions that weren't performed.\n\n" : ""}`
            : "";

        const task =
            meta.taskDescription
                ? `Task: ${meta.taskDescription}`
                : `Task: n/a`;

        const prev =
            prevSummary && !isFinal
                ? `\nPrevious summary:\n${prevSummary}\n`
                : ``;

        const mode = isFinal
            ? `FINAL AGGREGATION: Combine all chunk summaries into a holistic evaluation.`
            : `CHUNK EVALUATION: Summarize this chunk concisely.`;

        const expectedAppNames = isWorkflow ? meta.quest!.apps_used!.map(a => a.name) : [];
        const guidelines = getGuidelines(isFinal, !!isWorkflow, expectedAppNames);

        return [
            header,
            rubric,
            weights,
            metaLine,
            chunkMetadata,
            task,
            mode,
            guidelines,
            prev,
        ].filter(Boolean).join("\n");
    }

    private formatMessageContent(
        chunk: Chunk
    ): OpenAI.Chat.Completions.ChatCompletionContentPart[] {
        const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
        let imageCount = 0;

        for (const item of chunk) {
            if (item.type === "text") {
                const sanitizedText = sanitizeUserInput(item.text ?? "");
                const text = this.truncate(sanitizedText, this.maxTextPerMessage);
                if (text) {
                    parts.push({ type: "text", text });
                }
            } else if (item.type === "image") {
                if (imageCount >= this.maxImagesPerChunk) continue;

                const mime = item.mime ?? "image/jpeg";
                // Use high detail for better UI element recognition
                parts.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${mime};base64,${item.data}`,
                        detail: "high",
                    } as any, // 'detail' is supported by OpenAI image content parts
                });

                if (item.cropInfo) {
                    const sanitizedCropInfo = sanitizeUserInput(item.cropInfo);
                    if (sanitizedCropInfo) {
                        const note = this.truncate(
                            `Screenshot context: ${sanitizedCropInfo}`,
                            Math.max(128, Math.floor(this.maxTextPerMessage / 8))
                        );
                        if (note) parts.push({ type: "text", text: note });
                    }
                }
                imageCount++;
            } else if (item.type === "app_focus") {
                // Convert app_focus events to text for LLM consumption
                const focusedApp = item.data?.focused_app || 'Unknown';
                const availableApps = item.data?.available_apps || [];
                const browserDomain = (item.data as any)?.browser_domain;
                const focusedAppWithDomain = (item.data as any)?.focused_app_with_domain;

                // Include browser domain info for better webapp validation
                let appFocusText = `app_focus(focused: "${focusedApp}", available: [${availableApps.join(', ')}])`;
                if (browserDomain) {
                    appFocusText = `app_focus(focused: "${focusedAppWithDomain || focusedApp}", domain: "${browserDomain}", available: [${availableApps.join(', ')}])`;
                }

                const sanitizedText = sanitizeUserInput(appFocusText);
                const text = this.truncate(sanitizedText, this.maxTextPerMessage);
                if (text) {
                    parts.push({ type: "text", text });
                }
            }
        }

        // Ensure there is always at least some textual context
        if (!parts.some((p: any) => p?.type === "text")) {
            parts.push({
                type: "text",
                text:
                    "No explicit textual events were provided for this chunk; summarize the visible evidence only.",
            });
        }

        return parts;
    }

    private truncate(s: string, maxLen: number): string {
        if (!s) return "";
        if (s.length <= maxLen) return s;
        return s.slice(0, Math.max(0, maxLen - 3)) + "...";
    }
}
