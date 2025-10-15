import fs from 'node:fs';
import path from 'path';
import { PipelineStage, ProcessedEvent } from '../../shared/types';
import { spawnSync } from 'node:child_process';

export class VideoExtractor implements PipelineStage<string, ProcessedEvent[]> {
  constructor(
    private dataDir: string,
    private ffmpegPath: string = 'ffmpeg',
    private ffprobePath: string = 'ffprobe'
  ) {}

  private async extractFrame(videoPath: string, timestamp: number): Promise<string | null> {
    const outputPath = path.join(this.dataDir, 'temp', `frame_${timestamp}.jpg`);

    try {
      // Use spawnSync instead of Bun.spawn to avoid ENOTCONN issues on Windows compiled binaries
      const result = spawnSync(this.ffmpegPath, [
        '-ss', (timestamp / 1000).toString(),
        '-i', videoPath,
        '-vframes', '1',
        '-y', outputPath
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      if (result.status !== 0) {
        if (result.stderr) {
          console.error(`[VideoExtractor] Failed to extract frame at ${timestamp}ms:`, result.stderr.toString());
        }
        return null;
      }
      
      if (!fs.existsSync(outputPath)) {
        console.error(`[VideoExtractor] Output file not created: ${outputPath}`);
        return null;
      }

      const imageBuffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);

      return imageBuffer.toString('base64');
    } catch (error) {
      console.error(`[VideoExtractor] Error extracting frame at ${timestamp}ms:`, error);
      return null;
    }
  }

  async process(sessionId: string): Promise<ProcessedEvent[]> {
    const events: ProcessedEvent[] = [];

    // Try both video formats
    const mp4Path = path.join(this.dataDir, sessionId, `recording.mp4`);
    const m4vPath = path.join(this.dataDir, `${sessionId}.guac.m4v`);

    let videoPath: string;
    if (fs.existsSync(mp4Path)) {
      videoPath = mp4Path;
    } else if (fs.existsSync(m4vPath)) {
      videoPath = m4vPath;
    } else {
      console.error(`No video file found for session ${sessionId}`);
      return events;
    }

    // Ensure temp directory exists
    const tempDir = path.join(this.dataDir, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Get video duration - use spawnSync to avoid ENOTCONN issues on Windows compiled binaries
    console.log(`[VideoExtractor] Getting duration for video: ${videoPath}`);
    console.log(`[VideoExtractor] Using ffprobe: ${this.ffprobePath}`);
    
    const result = spawnSync(this.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      encoding: 'utf-8',
    });

    if (result.status !== 0 || !result.stdout) {
      console.error('[VideoExtractor] Failed to get video duration:', result.stderr);
      return events;
    }

    const stdout = result.stdout;
    console.log(`[VideoExtractor] Video duration raw output: ${stdout.trim()}`);

    const durationStr = stdout.trim();
    const durationSecs = Math.floor(parseFloat(durationStr));
    const durationMs = durationSecs * 1000;

    // Extract keyframes every second for the entire duration
    for (let time = 0; time <= durationMs; time += 1000) {
      const frame = await this.extractFrame(videoPath, time);
      if (frame) {
        events.push({
          type: 'frame',
          timestamp: time,
          data: { frame }
        });
      }
    }

    return events;
  }
}
