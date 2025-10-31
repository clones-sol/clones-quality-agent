import { ProcessedEvent, PipelineStage } from '../../shared/types';
import OpenAI from 'openai';

export class StateTransitionAugmenter implements PipelineStage<ProcessedEvent[], ProcessedEvent[]> {
    private openai: OpenAI;

    constructor(private maxSamples: number = 3) {
        this.openai = new OpenAI();
    }

    private formatEventForPrompt(event: ProcessedEvent): any {
        switch (event.type) {
            case 'mouseclick':
                return {
                    type: 'click',
                    x: event.data.x,
                    y: event.data.y,
                    timestamp: event.timestamp
                };
            case 'doubleclick':
                return {
                    type: 'double_click',
                    x: event.data.x,
                    y: event.data.y,
                    timestamp: event.timestamp
                };
            case 'type':
                return {
                    type: 'keyboard',
                    text: event.data.text,
                    timestamp: event.timestamp
                };
            case 'mousedrag':
                return {
                    type: 'drag',
                    coordinates: event.data.coordinates,
                    timestamp: event.timestamp
                };
            case 'hotkey':
                return {
                    type: 'hotkey',
                    text: event.data.text,
                    timestamp: event.timestamp
                };
            default:
                return null;
        }
    }

    private async generateTransitionDescription(
        beforeFrame: string,
        afterFrame: string,
        events: ProcessedEvent[]
    ): Promise<string> {
        const formattedEvents = events
            .map(e => this.formatEventForPrompt(e))
            .filter(e => e !== null);

        const prompt = `Given two consecutive GUI screenshots and a JSON array of user interactions that occurred between them, describe what has changed and what user interaction occurred, as if you were describing a scene transition in a movie.

The events array contains the actual user interactions that occurred, with timestamps and coordinates where applicable. Use this information to provide an accurate description of what the user did.

Events: ${JSON.stringify(formattedEvents, null, 2)}

Requirements:
1. Describe what was shown in the first screenshot
2. Describe what changed in the second screenshot
3. Use the provided events data to explain exactly what user actions occurred in between
4. If you see text that seems incorrect (like "Fie" instead of "File"), use your vision & language capabilities to infer the correct text while maintaining the provided coordinates`;

        const response = await this.openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${beforeFrame}`
                            }
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${afterFrame}`
                            }
                        }
                    ]
                }
            ],
            max_tokens: 500
        });

        return response.choices[0].message.content || '';
    }

    async process(events: ProcessedEvent[]): Promise<ProcessedEvent[]> {
        console.log('\n[StateTransitionAugmenter] Starting state transition analysis...');

        // Get frame events
        const frameEvents = events.filter(e => e.type === 'frame');
        console.log(`[StateTransitionAugmenter] Found ${frameEvents.length} total frames`);

        let transitionsGenerated = 0;
        let framesProcessed = 0;

        // Find all potential transitions (frames with events between them)
        const potentialTransitions: { current: ProcessedEvent, next: ProcessedEvent, events: ProcessedEvent[] }[] = [];

        for (let i = 0; i < frameEvents.length - 1; i++) {
            const currentFrame = frameEvents[i];
            const nextFrame = frameEvents[i + 1];

            if (!currentFrame.data.frame || !nextFrame.data.frame) continue;

            const eventsBetween = events.filter(e =>
                e.timestamp > currentFrame.timestamp &&
                e.timestamp < nextFrame.timestamp &&
                ['mouseclick', 'doubleclick', 'type', 'mousedrag', 'hotkey'].includes(e.type)
            );

            if (eventsBetween.length > 0) {
                potentialTransitions.push({
                    current: currentFrame,
                    next: nextFrame,
                    events: eventsBetween
                });
            }
        }

        console.log(`[StateTransitionAugmenter] Found ${potentialTransitions.length} potential transitions`);

        // Randomly sample transitions
        const indices = Array.from({ length: potentialTransitions.length }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }

        const samplesToProcess = indices
            .slice(0, Math.min(this.maxSamples, potentialTransitions.length))
            .map(i => potentialTransitions[i]);

        console.log(`[StateTransitionAugmenter] Selected ${samplesToProcess.length} transitions to process`);

        // Process selected transitions
        for (const { current, next, events: eventsBetween } of samplesToProcess) {
            framesProcessed++;

            try {
                console.log(`[StateTransitionAugmenter] Processing transition ${framesProcessed}/${samplesToProcess.length}`);
                const description = await this.generateTransitionDescription(
                    current.data.frame!,
                    next.data.frame!,
                    eventsBetween
                );
                console.log(`[StateTransitionAugmenter] Generated description (${description.length} chars)`);

                events.push({
                    type: 'state_transition',
                    timestamp: next.timestamp,
                    data: {
                        beforeFrame: current.data.frame,
                        afterFrame: next.data.frame,
                        text: description
                    }
                });
                transitionsGenerated++;
            } catch (error) {
                console.error(`[StateTransitionAugmenter] Error generating transition description for transition ${framesProcessed}:`, error);
            }
        }

        console.log(`[StateTransitionAugmenter] Completed state transition analysis. Generated ${transitionsGenerated} transitions from ${framesProcessed} frame pairs.\n`);
        return events;
    }
}
