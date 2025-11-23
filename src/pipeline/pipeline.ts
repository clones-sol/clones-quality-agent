import { PipelineConfig, ProcessedEvent, SchemaVersion } from '../shared/types';
import { visualizeEvents } from '../shared/utils/visualization';
import { BrowserUrlExtractor } from '../stages/extraction/browser-url-extractor';

import fs from 'node:fs';
import path from 'path';

export class Pipeline {
  private readonly CURRENT_SCHEMA_VERSION: SchemaVersion = { major: 1, minor: 0, patch: 0 };

  constructor(private config: PipelineConfig) { }

  private validateSchemaVersion(filePath: string, fileSchema: SchemaVersion): void {
    const current = this.CURRENT_SCHEMA_VERSION;

    // Compatible if same major version and file minor <= current minor
    const isCompatible = fileSchema.major === current.major && fileSchema.minor <= current.minor;

    if (!isCompatible) {
      throw new Error(
        `Schema version incompatible in ${filePath}: ` +
        `found ${fileSchema.major}.${fileSchema.minor}.${fileSchema.patch}, ` +
        `expected ${current.major}.x.x with minor <= ${current.minor}`
      );
    }

    console.log(`[SCHEMA] ${filePath}: v${fileSchema.major}.${fileSchema.minor}.${fileSchema.patch} ✓`);
  }

  private async validateSessionSchemas(sessionId: string): Promise<void> {
    const sessionDir = path.join(this.config.dataDir, sessionId);

    // Check meta.json schema version
    try {
      const metaPath = path.join(sessionDir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        const metaData = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        this.validateSchemaVersion('meta.json', metaData.schema_version);
      }
    } catch (error) {
      console.warn(`[SCHEMA] Could not validate meta.json: ${error}`);
    }

    // Check manifest.json schema version
    try {
      const manifestPath = path.join(sessionDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        this.validateSchemaVersion('manifest.json', manifestData.schema_version);
      }
    } catch (error) {
      console.warn(`[SCHEMA] Could not validate manifest.json: ${error}`);
    }

    // Check sft.json schema version  
    try {
      const sftPath = path.join(sessionDir, 'sft.json');
      if (fs.existsSync(sftPath)) {
        const sftData = JSON.parse(fs.readFileSync(sftPath, 'utf-8'));
        this.validateSchemaVersion('sft.json', sftData.schema_version);
      }
    } catch (error) {
      console.warn(`[SCHEMA] Could not validate sft.json: ${error}`);
    }

    // Check input_log_meta.json schema version
    try {
      const inputLogMetaPath = path.join(sessionDir, 'input_log_meta.json');
      if (fs.existsSync(inputLogMetaPath)) {
        const inputLogMetaData = JSON.parse(fs.readFileSync(inputLogMetaPath, 'utf-8'));
        this.validateSchemaVersion('input_log_meta.json', inputLogMetaData.schema_version);
      }
    } catch (error) {
      console.warn(`[SCHEMA] Could not validate input_log_meta.json: ${error}`);
    }

    // Check checksums.json schema version
    try {
      const checksumsPath = path.join(sessionDir, 'checksums.json');
      if (fs.existsSync(checksumsPath)) {
        const checksumsData = JSON.parse(fs.readFileSync(checksumsPath, 'utf-8'));
        this.validateSchemaVersion('checksums.json', checksumsData.schema_version);
      }
    } catch (error) {
      console.warn(`[SCHEMA] Could not validate checksums.json: ${error}`);
    }
  }

  async process(sessionId: string): Promise<ProcessedEvent[]> {
    // Validate schema versions first
    await this.validateSessionSchemas(sessionId);

    let allEvents: ProcessedEvent[] = [];

    // Run extractors first
    for (const extractor of this.config.extractors) {
      try {
        const extractedEvents = await extractor.process(sessionId);
        allEvents = [...allEvents, ...extractedEvents];
      } catch (error) {
        console.error(`Extractor stage failed:`, error);
        throw error;
      }
    }

    // Run browser URL extraction (only if OpenAI API key is available)
    /* 
    // DISABLED for Video Grading Optimization (Nov 2025)
    // URL extraction via OCR is redundant with Gemini Video analysis and costly.
    if (process.env.OPENAI_API_KEY) {
      try {
        const browserUrlExtractor = new BrowserUrlExtractor();
        allEvents = await browserUrlExtractor.process(allEvents);
      } catch (error) {
        console.error(`Browser URL extraction failed:`, error);
        // Don't throw error, just log it and continue without browser URL extraction
        console.warn('Continuing without browser URL extraction...');
      }
    } else {
      console.log('[Pipeline] Skipping browser URL extraction (OPENAI_API_KEY not set)');
    }
    */

    // Then run augmenters on the combined events
    for (const augmenter of this.config.augmenters) {
      try {
        allEvents = await augmenter.process(allEvents);
        // allEvents = [...allEvents, ...augmentedEvents];
      } catch (error) {
        console.error(`Augmenter stage failed:`, error);
        throw error;
      }
    }

    // Sort events by timestamp
    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    // Filter consecutive frame events, keeping only the last one
    const result: ProcessedEvent[] = [];
    let consecutiveFrames: ProcessedEvent[] = [];

    for (const event of allEvents) {
      if (event.type === 'frame') {
        consecutiveFrames.push(event);
      } else {
        if (consecutiveFrames.length > 0) {
          // Only keep the last frame from consecutive frames
          result.push(consecutiveFrames[consecutiveFrames.length - 1]);
          consecutiveFrames = [];
        }
        result.push(event);
      }
    }

    // Handle any remaining consecutive frames at the end
    if (consecutiveFrames.length > 0) {
      result.push(consecutiveFrames[consecutiveFrames.length - 1]);
    }

    return result;
  }

  async run(): Promise<void> {
    const results = await Promise.all(this.config.sessionIds.map((id) => this.process(id)));

    // Generate debug visualizations
    results.forEach((events, i) => {
      const html = visualizeEvents(events);
      fs.writeFileSync(
        path.join(this.config.outputDir, `session_${this.config.sessionIds[i]}_debug.html`),
        html
      );
    });
  }
}
