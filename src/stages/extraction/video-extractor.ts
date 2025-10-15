import fs from 'node:fs';
import path from 'path';
import { PipelineStage, ProcessedEvent } from '../../shared/types';

export class VideoExtractor implements PipelineStage<string, ProcessedEvent[]> {
  constructor(
    private dataDir: string,
    private ffmpegPath: string = 'ffmpeg',
    private ffprobePath: string = 'ffprobe'
  ) {}

  private async extractFrame(videoPath: string, timestamp: number): Promise<string | null> {
    const outputPath = path.join(this.dataDir, 'temp', `frame_${timestamp}.jpg`);

    try {
      const proc = Bun.spawn([
        this.ffmpegPath,
        '-ss', (timestamp / 1000).toString(),
        '-i', videoPath,
        '-vframes', '1',
        '-y', outputPath
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });

      await proc.exited;
      if (proc.exitCode !== 0) return null;
      if (!fs.existsSync(outputPath)) return null;

      const imageBuffer = fs.readFileSync(outputPath);
      fs.unlinkSync(outputPath);

      return imageBuffer.toString('base64');
    } catch {
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

    // Get video duration
    const proc = Bun.spawn([
      this.ffprobePath,
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0 || !stdout) {
      const stderr = await new Response(proc.stderr).text();
      console.error('Failed to get video duration:', stderr);
      return events;
    }

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
