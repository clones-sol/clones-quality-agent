import { ProcessedEvent, PipelineStage } from '../../shared/types';
import OpenAI from 'openai';
import sharp from 'sharp';
import os from 'os';

export class BrowserUrlExtractor implements PipelineStage<ProcessedEvent[], ProcessedEvent[]> {
  private openai?: OpenAI;
  private isLinux: boolean;
  private platform: string;

  constructor() {
    // Initialize OpenAI lazily to avoid errors if API key is not available
    this.platform = os.platform();
    this.isLinux = this.platform === 'linux';
    
    // Configure Sharp for Linux glibc memory issues
    if (this.isLinux) {
      try {
        sharp.concurrency(1); // Reduce concurrency on Linux to avoid memory fragmentation
        sharp.cache({ memory: 50 }); // Limit cache to 50MB on Linux
        console.log('[BrowserUrlExtractor] Linux detected: Sharp configured with limited concurrency and cache');
      } catch (error) {
        console.warn('[BrowserUrlExtractor] Failed to configure Sharp for Linux:', error);
      }
    }
    
    console.log(`[BrowserUrlExtractor] Platform: ${this.platform}, Linux optimizations: ${this.isLinux}`);
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
    // Adaptive zones based on platform and display characteristics
    const baseZones = [
      { name: 'top15', x: 0, y: 0, widthRatio: 1, heightRatio: 0.15 },
      { name: 'top25', x: 0, y: 0, widthRatio: 1, heightRatio: 0.25 },
      { name: 'center-top', x: 0.1, y: 0.05, widthRatio: 0.8, heightRatio: 0.15 }
    ];
    
    // Linux high-DPI adaptations - adjust zones for better address bar detection
    const zones = this.isLinux ? [
      { name: 'linux-top8', x: 0, y: 0, widthRatio: 1, heightRatio: 0.08 },
      { name: 'linux-top12', x: 0, y: 0, widthRatio: 1, heightRatio: 0.12 },
      { name: 'linux-center-wide', x: 0.05, y: 0.02, widthRatio: 0.9, heightRatio: 0.1 },
      { name: 'linux-address-bar', x: 0.2, y: 0.03, widthRatio: 0.6, heightRatio: 0.06 }
    ] : baseZones;

    const base64Data = frameBase64.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    let sharpInstance;
    let metadata;
    
    try {
      sharpInstance = sharp(imageBuffer);
      metadata = await sharpInstance.metadata();
      
      if (this.isLinux) {
        console.log(`[BrowserUrlExtractor] Linux metadata: ${metadata.width}x${metadata.height}, format: ${metadata.format}, channels: ${metadata.channels}`);
      }
    } catch (error) {
      console.error(`[BrowserUrlExtractor] Failed to process image metadata on ${this.platform}:`, error);
      return null;
    }
    
    const { width, height } = metadata;

    for (const zone of zones) {
      // Calculate and validate dimensions outside try-catch for fallback access
      const cropX = Math.floor((width || 1920) * zone.x);
      const cropY = Math.floor((height || 1080) * zone.y);
      const cropW = Math.floor((width || 1920) * zone.widthRatio);
      const cropH = Math.floor((height || 1080) * zone.heightRatio);

      let extractOptions = { 
        left: Math.max(0, cropX), 
        top: Math.max(0, cropY), 
        width: Math.max(100, cropW), 
        height: Math.max(30, cropH) 
      };
      
      // Linux-specific adjustments for high-DPI displays
      if (this.isLinux) {
        // Ensure minimum viable dimensions for address bar detection
        extractOptions.width = Math.max(200, extractOptions.width);
        extractOptions.height = Math.max(40, extractOptions.height);
        
        // Adjust for high-DPI: if image is very large, ensure we capture enough detail
        if (width && width > 2000) {
          extractOptions.width = Math.min(extractOptions.width, Math.floor(width * 0.8));
          extractOptions.height = Math.min(extractOptions.height, Math.floor(height * 0.08));
        }
        
        console.log(`[BrowserUrlExtractor] Linux ${zone.name} extract (adjusted): left=${extractOptions.left}, top=${extractOptions.top}, width=${extractOptions.width}, height=${extractOptions.height}`);
      }
      
      // Skip zone if dimensions are invalid
      if (extractOptions.width <= 0 || extractOptions.height <= 0) {
        console.warn(`[BrowserUrlExtractor] Skipping ${zone.name} - invalid dimensions: ${extractOptions.width}x${extractOptions.height}`);
        continue;
      }

      try {

        let croppedBuffer;
        if (this.isLinux) {
          // Create new Sharp instance for each operation on Linux to avoid memory issues
          croppedBuffer = await sharp(imageBuffer, { limitInputPixels: false })
            .extract(extractOptions)
            .png({ compressionLevel: 6, adaptiveFiltering: false })
            .toBuffer();
        } else {
          croppedBuffer = await sharp(imageBuffer)
            .extract(extractOptions)
            .png()
            .toBuffer();
        }

        const croppedImage = `data:image/png;base64,${croppedBuffer.toString('base64')}`;
        const url = await this.extractUrlFromCrop(croppedImage);

        if (url && url !== 'unknown') {
          console.log(`[BrowserUrlExtractor] Found URL in ${zone.name}: ${url}`);
          return url;
        }
      } catch (error) {
        console.warn(`[BrowserUrlExtractor] Zone ${zone.name} failed on ${this.platform}:`, error);
        
        // On Linux, try with reduced parameters if extraction fails
        if (this.isLinux && error instanceof Error && error.message.includes('extract')) {
          try {
            console.log(`[BrowserUrlExtractor] Attempting Linux fallback for zone ${zone.name}`);
            const fallbackOptions = {
              left: Math.max(0, Math.floor(extractOptions.left / 2)),
              top: Math.max(0, Math.floor(extractOptions.top / 2)),
              width: Math.max(100, Math.min(extractOptions.width, 800)),
              height: Math.max(50, Math.min(extractOptions.height, 200))
            };
            
            // Validate fallback dimensions
            if (fallbackOptions.width <= 0 || fallbackOptions.height <= 0) {
              console.warn(`[BrowserUrlExtractor] Fallback dimensions invalid for ${zone.name}: ${fallbackOptions.width}x${fallbackOptions.height}`);
              continue;
            }
            
            const fallbackBuffer = await sharp(imageBuffer, { limitInputPixels: false, sequentialRead: true })
              .extract(fallbackOptions)
              .png({ compressionLevel: 9, adaptiveFiltering: false, palette: true })
              .toBuffer();
              
            const fallbackImage = `data:image/png;base64,${fallbackBuffer.toString('base64')}`;
            const fallbackUrl = await this.extractUrlFromCrop(fallbackImage);
            
            if (fallbackUrl && fallbackUrl !== 'unknown') {
              console.log(`[BrowserUrlExtractor] Linux fallback success for ${zone.name}: ${fallbackUrl}`);
              return fallbackUrl;
            }
          } catch (fallbackError) {
            console.warn(`[BrowserUrlExtractor] Linux fallback also failed for ${zone.name}:`, fallbackError);
          }
        }
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
        
        const extractOptions = {
          left: Math.max(0, windowBounds.x),
          top: Math.max(0, windowBounds.y + 20),
          width: Math.max(100, windowBounds.width),
          height: Math.max(30, addressBarHeight)
        };
        
        if (this.isLinux) {
          console.log(`[BrowserUrlExtractor] Linux window bounds crop: left=${extractOptions.left}, top=${extractOptions.top}, width=${extractOptions.width}, height=${extractOptions.height}`);
        }

        let croppedBuffer;
        if (this.isLinux) {
          croppedBuffer = await sharp(imageBuffer, { limitInputPixels: false })
            .extract(extractOptions)
            .png({ compressionLevel: 6, adaptiveFiltering: false })
            .toBuffer();
        } else {
          croppedBuffer = await sharp(imageBuffer)
            .extract(extractOptions)
            .png()
            .toBuffer();
        }

        return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
      } catch (error) {
        console.warn(`[BrowserUrlExtractor] Window bounds crop failed on ${this.platform}:`, error);
      }
    }

    const region = await this.detectAddressBarRegion(frameBase64);
    if (region && region.width > 0 && region.height > 0) {
      try {
        const extractOptions = {
          left: Math.max(0, region.x),
          top: Math.max(0, region.y),
          width: Math.max(100, region.width),
          height: Math.max(30, region.height)
        };
        
        if (this.isLinux) {
          console.log(`[BrowserUrlExtractor] Linux smart crop: left=${extractOptions.left}, top=${extractOptions.top}, width=${extractOptions.width}, height=${extractOptions.height}`);
        }

        let croppedBuffer;
        if (this.isLinux) {
          croppedBuffer = await sharp(imageBuffer, { limitInputPixels: false })
            .extract(extractOptions)
            .png({ compressionLevel: 6, adaptiveFiltering: false })
            .toBuffer();
        } else {
          croppedBuffer = await sharp(imageBuffer)
            .extract(extractOptions)
            .png()
            .toBuffer();
        }

        return `data:image/png;base64,${croppedBuffer.toString('base64')}`;
      } catch (error) {
        console.warn(`[BrowserUrlExtractor] Smart crop failed on ${this.platform}:`, error);
      }
    }

    return null;
  }

  private async extractUrlFromFullImage(frameBase64: string): Promise<string | null> {
    const prompt = `Look at this browser screenshot. Find the address bar and extract ONLY the domain from the URL.

RULES:
- Return ONLY the domain (e.g. "github.com", "google.com", "anthropic.com")  
- NO explanations, NO "unknown", NO sentences
- Look for the address/URL bar at the top of the browser
- If you see any URL in the address bar, extract just the domain part
- If no clear URL is visible in the address bar, return null
- Examples: "google.com", "github.com", "stackoverflow.com"`;

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
        max_tokens: 20,
        temperature: 0.0
      });

      const result = response.choices[0].message.content?.trim().toLowerCase();
      
      if (this.isLinux) {
        console.log(`[BrowserUrlExtractor] Linux full image OCR result: "${result}"`);
      }
      
      // Filter out non-domain responses
      if (!result || 
          result === 'unknown' || 
          result === 'null' ||
          result.includes('unable') ||
          result.includes('cannot') ||
          result.includes('no') ||
          result.length > 50 ||
          !result.includes('.')) {
        return null;
      }
      
      // Extract just the domain if there's extra text
      const domainMatch = result.match(/([a-z0-9-]+\.)+[a-z]{2,}/);
      const domain = domainMatch ? domainMatch[0] : null;
      
      if (domain && this.isLinux) {
        console.log(`[BrowserUrlExtractor] Linux full image OCR extracted domain: "${domain}"`);
      }
      
      return domain;
    } catch (error) {
      console.error(`[BrowserUrlExtractor] Full image URL extraction failed on ${this.platform}:`, error);
      return null;
    }
  }

  private async extractUrlFromCrop(croppedImage: string): Promise<string | null> {
    const prompt = `Look at this browser address bar screenshot. Extract ONLY the domain from the URL.

RULES:
- Return ONLY the domain (e.g. "github.com", "google.com", "anthropic.com")
- NO explanations, NO "unknown", NO sentences
- If you see any URL, extract the domain part
- If no clear URL is visible, return null
- Examples of correct responses: "google.com", "github.com", "stackoverflow.com"`;

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
        max_tokens: 20,
        temperature: 0.0
      });

      const result = response.choices[0].message.content?.trim().toLowerCase();
      
      if (this.isLinux) {
        console.log(`[BrowserUrlExtractor] Linux crop OCR raw result: "${result}"`);
      }
      
      // Filter out non-domain responses - including the specific message you're seeing
      if (!result || 
          result === 'unknown' || 
          result === 'null' ||
          result.includes('unable') ||
          result.includes('cannot') ||
          result.includes('no') ||
          result.includes('therefore') ||
          result.includes('extract any url') ||
          result.length > 50 ||
          !result.includes('.')) {
        if (this.isLinux) {
          console.log(`[BrowserUrlExtractor] Linux crop OCR filtered out: "${result}"`);
        }
        return null;
      }
      
      // Extract just the domain if there's extra text
      const domainMatch = result.match(/([a-z0-9-]+\.)+[a-z]{2,}/);
      const domain = domainMatch ? domainMatch[0] : null;
      
      if (this.isLinux) {
        console.log(`[BrowserUrlExtractor] Linux crop OCR final domain: "${domain}"`);
      }
      
      return domain;
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

    console.log(`[BrowserUrlExtractor] Processing ${browserFocusEvents.length} browser focus events on ${this.platform}`);

    for (const focusEvent of browserFocusEvents) {
      const frameEvent = events.find(e =>
        e.type === 'frame' &&
        e.timestamp >= focusEvent.timestamp &&
        e.timestamp <= focusEvent.timestamp + 2000
      );

      if (frameEvent?.data.frame) {
        try {
          let domain: string | null = null;

          // Try full image OCR first (more reliable than cropping)
          domain = await this.extractUrlFromFullImage(frameEvent.data.frame);

          // Fallback to cropping methods if full image fails
          if (!domain) {
            const croppedImage = await this.cropAddressBar(frameEvent.data.frame, focusEvent);
            if (croppedImage) {
              domain = await this.extractUrlFromCrop(croppedImage);
            }
          }

          if (!domain) {
            domain = await this.extractUrlMultiZone(frameEvent.data.frame);
          }

          if (domain) {
            (focusEvent.data as any).browser_domain = domain;
            (focusEvent.data as any).focused_app_with_domain = `${focusEvent.data.focused_app} (${domain})`;
            console.log(`[BrowserUrlExtractor] ✅ ${focusEvent.data.focused_app} -> ${domain} [${this.platform}]`);
          } else {
            // Don't add parentheses if no domain found - keep original app name clean
            console.log(`[BrowserUrlExtractor] ❌ No domain found for ${focusEvent.data.focused_app} [${this.platform}]`);
          }
        } catch (error) {
          console.error(`[BrowserUrlExtractor] Processing error on ${this.platform}:`, error);
          
          // Additional error details for Linux debugging
          if (this.isLinux && error instanceof Error) {
            console.error(`[BrowserUrlExtractor] Linux-specific error details: ${error.name}, ${error.message}`);
            if (error.stack) {
              console.error(`[BrowserUrlExtractor] Linux stack trace:`, error.stack.split('\n').slice(0, 5).join('\n'));
            }
          }
        }
      }
    }

    return events;
  }
}