import { ProcessedEvent, PipelineStage } from '../../shared/types';
import OpenAI from 'openai';
import sharp from 'sharp';

export class BrowserUrlExtractor implements PipelineStage<ProcessedEvent[], ProcessedEvent[]> {
  private openai?: OpenAI;

  constructor() {
    // Initialize OpenAI lazily to avoid errors if API key is not available
  }

  private getOpenAI(): OpenAI {
    if (!this.openai) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY environment variable is required for browser URL extraction');
      }
      this.openai = new OpenAI();
    }
    return this.openai;
  }

  private isBrowserApp(appName: string): boolean {
    const browsers = [
      'safari', 'chrome', 'firefox', 'edge', 'brave', 'opera', 'arc', 'chromium'
    ];
    return browsers.some(browser =>
      appName.toLowerCase().includes(browser)
    );
  }

  private async getWindowBounds(appFocusEvent: ProcessedEvent): Promise<{x: number, y: number, width: number, height: number} | null> {
    const windowData = appFocusEvent.data.all_windows?.find((win: any) =>
      win.name && this.isBrowserApp(win.name)
    );

    if (windowData && (windowData as any).bbox) {
      const bbox = (windowData as any).bbox;
      return {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height
      };
    }

    return null;
  }

  private extractJsonFromResponse(response: string): string {
    // Remove markdown code blocks and clean whitespace
    return response
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
  }

  private async detectAddressBarRegion(frameBase64: string): Promise<{x: number, y: number, width: number, height: number} | null> {
    const prompt = `Analyze this screenshot and detect the browser address bar region. Return JSON with bounding box: {"x": X, "y": Y, "width": W, "height": H}. If no browser address bar visible, return null.`;

    try {
      const response = await this.getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: frameBase64.startsWith('data:') ? frameBase64 : `data:image/jpeg;base64,${frameBase64}` } }
          ]
        }],
        max_tokens: 100,
        temperature: 0.1
      });

      const result = response.choices[0].message.content?.trim();
      if (!result || result === 'null') return null;
      
      try {
        const cleanedResult = this.extractJsonFromResponse(result);
        return JSON.parse(cleanedResult);
      } catch (parseError) {
        console.warn(`[BrowserUrlExtractor] JSON parse failed for: "${result}"`);
        return null;
      }
    } catch (error) {
      console.error('[BrowserUrlExtractor] Address bar detection failed:', error);
      return null;
    }
  }

  private async extractUrlMultiZone(frameBase64: string): Promise<string | null> {
    const zones = [
      { name: 'top15', x: 0, y: 0, widthRatio: 1, heightRatio: 0.15 },
      { name: 'top25', x: 0, y: 0, widthRatio: 1, heightRatio: 0.25 },
      { name: 'center-top', x: 0.1, y: 0.05, widthRatio: 0.8, heightRatio: 0.15 }
    ];

    const base64Data = frameBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const { width, height } = await sharp(imageBuffer).metadata();

    for (const zone of zones) {
      try {
        const cropX = Math.floor((width || 1920) * zone.x);
        const cropY = Math.floor((height || 1080) * zone.y);
        const cropW = Math.floor((width || 1920) * zone.widthRatio);
        const cropH = Math.floor((height || 1080) * zone.heightRatio);

        const croppedBuffer = await sharp(imageBuffer)
          .extract({ 
            left: Math.max(0, cropX), 
            top: Math.max(0, cropY), 
            width: Math.max(100, cropW), 
            height: Math.max(30, cropH) 
          })
          .png()
          .toBuffer();

        const croppedImage = `data:image/png;base64,${croppedBuffer.toString('base64')}`;
        const url = await this.extractUrlFromCrop(croppedImage);

        if (url && url !== 'unknown') {
          console.log(`[BrowserUrlExtractor] Found URL in ${zone.name}: ${url}`);
          return url;
        }
      } catch (error) {
        console.warn(`[BrowserUrlExtractor] Zone ${zone.name} failed:`, error);
      }
    }

    return null;
  }

  private async cropAddressBar(frameBase64: string, appFocusEvent: ProcessedEvent): Promise<string | null> {
    const base64Data = frameBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    const windowBounds = await this.getWindowBounds(appFocusEvent);

    if (windowBounds && windowBounds.width > 0 && windowBounds.height > 0) {
      try {
        const addressBarHeight = Math.max(30, Math.min(80, windowBounds.height * 0.1));

        const croppedBuffer = await sharp(imageBuffer)
          .extract({
            left: Math.max(0, windowBounds.x),
            top: Math.max(0, windowBounds.y + 20),
            width: Math.max(100, windowBounds.width),
            height: Math.max(30, addressBarHeight)
          })
          .png()
          .toBuffer();

        return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
      } catch (error) {
        console.warn('[BrowserUrlExtractor] Window bounds crop failed:', error);
      }
    }

    const region = await this.detectAddressBarRegion(frameBase64);
    if (region && region.width > 0 && region.height > 0) {
      try {
        const croppedBuffer = await sharp(imageBuffer)
          .extract({
            left: Math.max(0, region.x),
            top: Math.max(0, region.y),
            width: Math.max(100, region.width),
            height: Math.max(30, region.height)
          })
          .png()
          .toBuffer();

        return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
      } catch (error) {
        console.warn('[BrowserUrlExtractor] Smart crop failed:', error);
      }
    }

    return null;
  }

  private async extractUrlFromCrop(croppedImage: string): Promise<string | null> {
    const prompt = `Extract the URL from this browser address bar. Return only the domain (e.g. "github.com", "google.com"). If no URL visible, return "unknown".`;

    try {
      const response = await this.getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: croppedImage.startsWith('data:') ? croppedImage : `data:image/jpeg;base64,${croppedImage}` } }
          ]
        }],
        max_tokens: 50,
        temperature: 0.1
      });

      const result = response.choices[0].message.content?.trim().toLowerCase();
      return result && result !== 'unknown' ? result : null;
    } catch (error) {
      console.error('[BrowserUrlExtractor] URL extraction failed:', error);
      return null;
    }
  }

  async process(events: ProcessedEvent[]): Promise<ProcessedEvent[]> {
    const browserFocusEvents = events.filter(e =>
      e.type === 'app_focus' &&
      e.data.focused_app &&
      this.isBrowserApp(e.data.focused_app)
    );

    console.log(`[BrowserUrlExtractor] Processing ${browserFocusEvents.length} browser focus events`);

    for (const focusEvent of browserFocusEvents) {
      const frameEvent = events.find(e =>
        e.type === 'frame' &&
        e.timestamp >= focusEvent.timestamp &&
        e.timestamp <= focusEvent.timestamp + 2000
      );

      if (frameEvent?.data.frame) {
        try {
          let domain: string | null = null;

          const croppedImage = await this.cropAddressBar(frameEvent.data.frame, focusEvent);
          if (croppedImage) {
            domain = await this.extractUrlFromCrop(croppedImage);
          }

          if (!domain) {
            domain = await this.extractUrlMultiZone(frameEvent.data.frame);
          }

          if (domain) {
            (focusEvent.data as any).browser_domain = domain;
            (focusEvent.data as any).focused_app_with_domain = `${focusEvent.data.focused_app} (${domain})`;
            console.log(`[BrowserUrlExtractor] ✅ ${focusEvent.data.focused_app} -> ${domain}`);
          }
        } catch (error) {
          console.error('[BrowserUrlExtractor] Processing error:', error);
        }
      }
    }

    return events;
  }
}