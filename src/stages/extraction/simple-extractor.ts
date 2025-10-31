import { readFileSync } from "fs";
import { PipelineStage, ProcessedEvent } from "../../shared/types";
import { join } from "path";

type KeyId =
  // Windows Format
  | 'Escape' | 'Return' | 'Backspace' | 'Left' | 'Right' | 'Up' | 'Down' | 'Space'
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z'
  | 'Zero' | 'One' | 'Two' | 'Three' | 'Four' | 'Five' | 'Six' | 'Seven' | 'Eight' | 'Nine'
  | 'Shift' | 'LeftCtrl' | 'RightCtrl' | 'LeftAlt' | 'RightAlt'
  | 'CapsLock' | 'Pause' | 'PageUp' | 'PageDown' | 'PrintScreen' | 'Insert' | 'End' | 'Home' | 'Delete'
  | 'Add' | 'Subtract' | 'Multiply' | 'Separator' | 'Decimal' | 'Divide'
  | 'BackTick' | 'BackSlash' | 'ForwardSlash' | 'Plus' | 'Minus' | 'FullStop' | 'Comma'
  | 'Tab' | 'Numlock' | 'LeftSquareBracket' | 'RightSquareBracket' | 'SemiColon' | 'Apostrophe' | 'Hash'
  // Mac Format
  | 'Alt' | 'AltGr' | 'ShiftLeft' | 'ShiftRight' | 'ControlLeft' | 'ControlRight'
  | 'MetaLeft' | 'MetaRight' | 'Function'
  | 'LeftArrow' | 'RightArrow' | 'UpArrow' | 'DownArrow'
  | 'KeyA' | 'KeyB' | 'KeyC' | 'KeyD' | 'KeyE' | 'KeyF' | 'KeyG' | 'KeyH' | 'KeyI' | 'KeyJ' | 'KeyK' | 'KeyL' | 'KeyM'
  | 'KeyN' | 'KeyO' | 'KeyP' | 'KeyQ' | 'KeyR' | 'KeyS' | 'KeyT' | 'KeyU' | 'KeyV' | 'KeyW' | 'KeyX' | 'KeyY' | 'KeyZ'
  | 'Num0' | 'Num1' | 'Num2' | 'Num3' | 'Num4' | 'Num5' | 'Num6' | 'Num7' | 'Num8' | 'Num9'
  | 'BackQuote' | 'Equal' | 'Minus' | 'LeftBracket' | 'RightBracket'
  | 'Slash' | 'Dot' | 'Quote' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12';

interface InputEvent {
  event: string;
  data: {
    x?: number;  // Normalized coordinates (relative to primary monitor, logical pixels)
    y?: number;
    raw_x?: number;  // Raw coordinates (may be negative for multi-monitor, physical pixels)
    raw_y?: number;
    key?: KeyId;
    actual_char?: string;  // Real character typed (layout-aware)
    button?: string;
    delta?: number;
    id?: number;
    axis?: string;
    value?: number;
    output?: string;
    // AXTree data structure (directly in data for axtree_interaction events)
    focused_app?: {
      name?: string;
    };
    tree?: Array<{
      name: string;
    }>;
    app_status?: 'launching' | 'ready' | 'unknown';
    // Nested data structure for other events
    data?: {
      focused_app?: {
        name?: string;
      };
      tree?: Array<{
        name: string;
      }>;
    };
  };
  time: number;
}

export class DemoDesktopExtractor implements PipelineStage<string, ProcessedEvent[]> {
  private symbolMap: { [key in KeyId]?: string } = {
    // Regular symbols
    'Space': ' ',
    // Windows format symbols
    'BackTick': '`',
    'BackSlash': '\\',
    'ForwardSlash': '/',
    'Plus': '+',
    'LeftSquareBracket': '[',
    'RightSquareBracket': ']',
    'Apostrophe': "'",
    'Hash': '#',
    'Add': '+',
    'Subtract': '-',
    'Multiply': '*',
    'Divide': '/',
    'Decimal': '.',
    'FullStop': '.',
    // Mac format symbols
    'BackQuote': '`',
    'Slash': '/',
    'Equal': '=',
    'Dot': '.',
    'LeftBracket': '[',
    'RightBracket': ']',
    'Quote': "'",
    // Windows format numbers
    'Zero': '0',
    'One': '1',
    'Two': '2',
    'Three': '3',
    'Four': '4',
    'Five': '5',
    'Six': '6',
    'Seven': '7',
    'Eight': '8',
    'Nine': '9',
    // Mac format numbers
    'Num0': '0',
    'Num1': '1',
    'Num2': '2',
    'Num3': '3',
    'Num4': '4',
    'Num5': '5',
    'Num6': '6',
    'Num7': '7',
    'Num8': '8',
    'Num9': '9',
    // Shared symbols
    'Minus': '-',
    'Comma': ',',
    'SemiColon': ';'
  };

  private shiftSymbolMap: { [key in KeyId]?: string } = {
    // Windows format numbers
    'Zero': ')',
    'One': '!',
    'Two': '@',
    'Three': '#',
    'Four': '$',
    'Five': '%',
    'Six': '^',
    'Seven': '&',
    'Eight': '*',
    'Nine': '(',
    // Mac format numbers
    'Num0': ')',
    'Num1': '!',
    'Num2': '@',
    'Num3': '#',
    'Num4': '$',
    'Num5': '%',
    'Num6': '^',
    'Num7': '&',
    'Num8': '*',
    'Num9': '(',
    // Windows format symbols
    'BackTick': '~',
    'Plus': '+',
    'LeftSquareBracket': '{',
    'RightSquareBracket': '}',
    'BackSlash': '|',
    'Apostrophe': '"',
    'ForwardSlash': '?',
    'FullStop': '>',
    // Mac format symbols
    'BackQuote': '~',
    'Equal': '+',
    'LeftBracket': '{',
    'RightBracket': '}',
    'Slash': '?',
    'Dot': '>',
    'Quote': '"',
    // Shared symbols
    'Minus': '_',
    'Comma': '<',
    'SemiColon': ':'
  };

  constructor(private dataDir: string) { }

  /**
   * Parse actual_char field to extract the real character typed.
   * Format: 'UnicodeInfo { name: Some("H"), unicode: [72], is_dead: false }'
   * Returns the character or null if not available.
   */
  private parseActualChar(actualChar?: string): string | null {
    if (!actualChar) return null;

    // Parse the UnicodeInfo format: name: Some("X")
    const match = actualChar.match(/name:\s*Some\("([^"]*)"\)/);
    if (match && match[1]) {
      return match[1];
    }

    return null;
  }

  private isSpecialKey(key: KeyId): boolean {
    const specialKeys = new Set<KeyId>([
      // Windows format
      'Shift', 'LeftCtrl', 'RightCtrl', 'LeftAlt', 'RightAlt',
      'Return', 'Backspace', 'Tab', 'Escape',
      'Left', 'Right', 'Up', 'Down',
      'Home', 'End', 'PageUp', 'PageDown',
      'Insert', 'Delete',
      'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
      'CapsLock', 'Pause', 'PrintScreen', 'Numlock',
      // Mac format
      'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
      'Alt', 'AltGr', 'MetaLeft', 'MetaRight',
      'LeftArrow', 'RightArrow', 'UpArrow', 'DownArrow',
      'Function', 'CapsLock'
    ]);
    return specialKeys.has(key);
  }

  private isComboKey(key: KeyId): boolean {
    const specialKeys = new Set<KeyId>([
      // Windows format
      'Shift', 'LeftCtrl', 'RightCtrl', 'LeftAlt', 'RightAlt',
      // Mac format
      'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
      'Alt', 'AltGr', 'MetaLeft', 'MetaRight'
    ]);
    return specialKeys.has(key);
  }

  private resamplePoints(
    points: Array<{ time: number; x: number; y: number }>,
    numPoints: number = 8
  ): Array<{ time: number; x: number; y: number }> {
    if (points.length <= 1) return points;

    // Calculate total path length for parameterization
    let totalLength = 0;
    const segments: number[] = [0];

    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      totalLength += Math.sqrt(dx * dx + dy * dy);
      segments.push(totalLength);
    }

    // Generate evenly spaced points along the path
    const resampled: Array<{ time: number; x: number; y: number }> = [];

    for (let i = 0; i < numPoints; i++) {
      const targetLength = (i / (numPoints - 1)) * totalLength;

      // Find segment containing target length
      let segIdx = 1;
      while (segIdx < segments.length && segments[segIdx] < targetLength) {
        segIdx++;
      }

      // Interpolate within segment
      const prevIdx = segIdx - 1;
      const segmentStart = segments[prevIdx];
      const segmentEnd = segments[segIdx];
      const t = (targetLength - segmentStart) / (segmentEnd - segmentStart);

      const p0 = points[prevIdx];
      const p1 = points[segIdx];

      resampled.push({
        x: Math.floor(p0.x + (p1.x - p0.x) * t),
        y: Math.floor(p0.y + (p1.y - p0.y) * t),
        time: Math.floor(p0.time + (p1.time - p0.time) * t)
      });
    }

    return resampled;
  }

  private processEvents(events: InputEvent[]): ProcessedEvent[] {
    const processedEvents: ProcessedEvent[] = [];
    let mouseDown = false;
    let mouseDownTime: number | null = null;
    let mouseDownPos: { x: number; y: number } | null = null;
    let accumulatedPoints: Array<{ time: number; x: number; y: number }> = [];
    let activeModifiers = new Set<KeyId>();
    let sequenceModifiers = new Set<KeyId>();
    let currentText = '';
    let textStartTime: number | null = null;
    let lastKeyTime: number | null = null;
    let lastKnownPos: { x: number; y: number } | null = null;
    let pendingClick: { x: number; y: number; timestamp: number } | null = null;

    const CLICK_THRESHOLD_PX = 5;
    const CLICK_THRESHOLD_MS = 500;
    const DOUBLE_CLICK_INTERVAL_MS = Number.isFinite(Number(process.env.DOUBLE_CLICK_INTERVAL_MS))
      ? Number(process.env.DOUBLE_CLICK_INTERVAL_MS)
      : 400; // typical defaults ~400-500ms
    const DOUBLE_CLICK_DISTANCE_PX = Number.isFinite(Number(process.env.DOUBLE_CLICK_DISTANCE_PX))
      ? Number(process.env.DOUBLE_CLICK_DISTANCE_PX)
      : 6; // small spatial tolerance for double-click

    const flushPendingClick = () => {
      if (pendingClick) {
        processedEvents.push({
          type: 'mouseclick',
          timestamp: pendingClick.timestamp,
          data: { x: pendingClick.x, y: pendingClick.y }
        });
        pendingClick = null;
      }
    };

    const flushText = () => {
      if (currentText && textStartTime !== null) {
        processedEvents.push({
          type: 'type',
          timestamp: textStartTime,
          data: { text: currentText }
        });
        currentText = '';
        textStartTime = null;
        sequenceModifiers.clear();
      }
    };

    if (events.length === 0) return [];
    const epoch = events[0].time;

    for (const event of events) {
      const time = event.time - epoch;

      // Debug: Log all event types to see what we're processing
      console.log(`[EXTRACTOR-DEBUG] Processing event: ${event.event}`);

      // Flush pending single click if the double-click window has elapsed
      if (pendingClick && time - pendingClick.timestamp > DOUBLE_CLICK_INTERVAL_MS) {
        flushPendingClick();
      }

      // Check if we need to flush text based on time since last key
      if (currentText && lastKeyTime !== null && time - lastKeyTime > 1000) {
        flushText();
      }

      switch (event.event) {
        case 'mousemove': {
          // Use normalized coordinates (x, y) which are:
          // - Relative to primary monitor (0,0 = top-left of primary monitor)
          // - In logical pixels (DPI-independent)
          // - Clamped to monitor bounds (no negative values even with multi-monitor)
          // raw_x/raw_y are also available but may be negative or exceed bounds
          if (event.data.x !== undefined && event.data.y !== undefined) {
            lastKnownPos = { x: event.data.x, y: event.data.y };
            if (mouseDown) {
              accumulatedPoints.push({
                time: time - (mouseDownTime || time),
                x: event.data.x,
                y: event.data.y
              });
            }
          }
          break;
        }

        case 'mousedown': {
          flushText();
          if (event.data.button === 'Left' && lastKnownPos) {
            mouseDown = true;
            mouseDownTime = time;
            mouseDownPos = { ...lastKnownPos };
            accumulatedPoints = [{
              time: 0,
              x: lastKnownPos.x,
              y: lastKnownPos.y
            }];
          }
          break;
        }

        case 'mouseup': {
          if (event.data.button === 'Left' && mouseDownPos && mouseDownTime && lastKnownPos) {
            const duration = time - mouseDownTime;
            const distance = Math.sqrt(
              Math.pow(lastKnownPos.x - mouseDownPos.x, 2) +
              Math.pow(lastKnownPos.y - mouseDownPos.y, 2)
            );

            if (distance <= CLICK_THRESHOLD_PX && duration <= CLICK_THRESHOLD_MS) {
              // Candidate click — check for double-click by using a pending buffer
              const currentClick = { x: mouseDownPos.x, y: mouseDownPos.y, timestamp: mouseDownTime };

              if (pendingClick) {
                const dt = currentClick.timestamp - pendingClick.timestamp;
                const dd = Math.sqrt(
                  Math.pow(currentClick.x - pendingClick.x, 2) +
                  Math.pow(currentClick.y - pendingClick.y, 2)
                );

                if (dt <= DOUBLE_CLICK_INTERVAL_MS && dd <= DOUBLE_CLICK_DISTANCE_PX) {
                  // Emit a double-click and clear pending
                  processedEvents.push({
                    type: 'doubleclick',
                    timestamp: currentClick.timestamp,
                    data: { x: pendingClick.x, y: pendingClick.y }
                  });
                  pendingClick = null;
                } else {
                  // Flush previous single click, start a new pending click
                  processedEvents.push({
                    type: 'mouseclick',
                    timestamp: pendingClick.timestamp,
                    data: { x: pendingClick.x, y: pendingClick.y }
                  });
                  pendingClick = currentClick;
                }
              } else {
                // Start pending single click to wait for possible double-click
                pendingClick = currentClick;
              }
            } else if (accumulatedPoints.length > 1) {
              // Resample the path to fixed number of control points
              const splinePoints = this.resamplePoints(accumulatedPoints);
              processedEvents.push({
                type: 'mousedrag',
                timestamp: mouseDownTime,
                data: {
                  coordinates: splinePoints
                }
              });
            }

            mouseDown = false;
            mouseDownTime = null;
            mouseDownPos = null;
            accumulatedPoints = [];
          }
          break;
        }

        case 'keydown': {
          if (event.data.key) {
            if (this.isComboKey(event.data.key)) {
              activeModifiers.add(event.data.key);
              sequenceModifiers.add(event.data.key);
            } else if (activeModifiers.size > 0 &&
              !activeModifiers.has('Shift') &&
              !activeModifiers.has('ShiftLeft') &&
              !activeModifiers.has('ShiftRight')) {
              // Only treat as hotkey if we have non-Shift modifiers
              let modifiers = Array.from(activeModifiers);
              const finalKey = event.data.key.toString().toLowerCase();
              const hotkeyStr = [...modifiers, finalKey].join('-');

              processedEvents.push({
                type: 'hotkey',
                timestamp: time,
                data: { text: hotkeyStr }
              });

              // Clear modifiers after using them
              activeModifiers.clear();
              sequenceModifiers.clear();
            } else if (this.isSpecialKey(event.data.key)) {
              flushText();
              processedEvents.push({
                type: 'hotkey',
                timestamp: time,
                data: { text: event.data.key }
              });
            } else {
              // PRIORITY 1: Use actual_char if available (keyboard layout-aware)
              const actualChar = this.parseActualChar(event.data.actual_char);

              if (actualChar) {
                // We have the real character typed, use it directly
                if (!textStartTime) {
                  textStartTime = time;
                }
                lastKeyTime = time;
                currentText = !currentText ? actualChar : currentText + actualChar;
                console.log(`[EXTRACTOR-DEBUG] Using actual_char: key=${event.data.key} -> char="${actualChar}"`);
              } else {
                // FALLBACK: Use key mapping (legacy behavior for when actual_char is not available)
                const hasShift = activeModifiers.has('Shift') ||
                  activeModifiers.has('ShiftLeft') ||
                  activeModifiers.has('ShiftRight');
                const mappedKey = hasShift
                  ? this.shiftSymbolMap[event.data.key] || this.symbolMap[event.data.key]
                  : this.symbolMap[event.data.key];

                if (mappedKey) {
                  // Symbol or shifted symbol - output the mapped character
                  const charToAdd = mappedKey;
                  if (!textStartTime) {
                    textStartTime = time;
                  }
                  lastKeyTime = time;
                  currentText = !currentText ? charToAdd : currentText + charToAdd;
                } else {
                  // Letter key - handle case based on Shift
                  const key = event.data.key.toString();
                  const isWindowsLetter = /^[A-Z]$/.test(key);
                  const isMacLetter = /^Key[A-Z]$/.test(key);
                  const hasShift = activeModifiers.has('Shift') ||
                    activeModifiers.has('ShiftLeft') ||
                    activeModifiers.has('ShiftRight');

                  let charToAdd: string;
                  if (isWindowsLetter) {
                    // Windows format: 'A' -> 'a' or 'A'
                    charToAdd = hasShift ? key : key.toLowerCase();
                  } else if (isMacLetter) {
                    // Mac format: 'KeyA' -> 'a' or 'A'
                    const letter = key.slice(3); // Remove 'Key' prefix
                    charToAdd = hasShift ? letter : letter.toLowerCase();
                  } else {
                    charToAdd = key.toLowerCase();
                  }

                  if (!textStartTime) {
                    textStartTime = time;
                  }
                  lastKeyTime = time;
                  currentText = !currentText ? charToAdd : currentText + charToAdd;
                }
              }
            }
          }
          break;
        }

        case 'keyup': {
          if (event.data.key && this.isSpecialKey(event.data.key)) {
            activeModifiers.delete(event.data.key);

            // If all modifiers are released and we have a sequence to emit
            if (activeModifiers.size === 0) {
              if (sequenceModifiers.size > 0 && currentText === '') {
                const modifierStr = Array.from(sequenceModifiers).join('-');
                processedEvents.push({
                  type: 'hotkey',
                  timestamp: time,
                  data: { text: modifierStr }
                });
              }
              sequenceModifiers.clear();
            }
          }
          break;
        }

        case 'mousewheel': {
          flushText();
          if (event.data.delta !== undefined) {
            processedEvents.push({
              type: 'mousewheel',
              timestamp: time,
              data: { delta: event.data.delta }
            });
          }
          break;
        }

        case 'axtree_interaction': {
          flushText();

          // Extract focused app and complete window hierarchy from AXTree data
          const axData = event.data;
          if (axData) {
            const focusedApp = axData.focused_app?.name;
            const availableApps = axData.tree?.map((app: any) => app.name) || [];
            const allWindows = axData.tree || [];
            const appStatus = axData.app_status || 'unknown'; // Use app_status from Rust

            console.log(`[EXTRACTOR-DEBUG] app_focus event - focused: ${focusedApp} (${appStatus}), available: [${availableApps.join(', ')}]`);

            // Only capture app focus events when we have a valid focused app
            if (focusedApp) {
              processedEvents.push({
                type: 'app_focus',
                timestamp: time,
                data: {
                  focused_app: focusedApp,
                  available_apps: availableApps,
                  app_status: appStatus,
                  all_windows: allWindows
                }
              });
              console.log(`[EXTRACTOR-DEBUG] ✅ Generated app_focus event for: ${focusedApp} (${appStatus})`);
            } else {
              console.log(`[EXTRACTOR-DEBUG] ❌ Skipped app_focus event - no focused app`);
            }
          }
          break;
        }
      }
    }

    // Flush any remaining text
    flushText();

    // Flush any pending single click at end
    if (pendingClick) {
      processedEvents.push({
        type: 'mouseclick',
        timestamp: pendingClick.timestamp,
        data: { x: pendingClick.x, y: pendingClick.y }
      });
      pendingClick = null;
    }

    // Debug: Count event types
    const eventTypeCounts = processedEvents.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log(`[EXTRACTOR-DEBUG] Generated ${processedEvents.length} total events: ${JSON.stringify(eventTypeCounts)}`);

    return processedEvents;
  }

  async process(sessionId: string): Promise<ProcessedEvent[]> {
    const jsonlPath = join(this.dataDir, sessionId, 'input_log.jsonl');

    // Read and parse the JSONL file
    const jsonlContent = readFileSync(jsonlPath, 'utf-8');
    const events: InputEvent[] = jsonlContent
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    // Validate timestamp consistency 
    this.validateTimestamps(events, sessionId);

    return this.processEvents(events);
  }

  private validateTimestamps(events: InputEvent[], sessionId: string): void {
    if (events.length === 0) return;

    const timestamps = events.map(e => e.time);
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    const duration = maxTime - minTime;

    // Check if timestamps are relative (starting near 0) or absolute
    const isRelative = minTime < 60000; // Less than 1 minute suggests relative timestamps

    console.log(`[TIMESTAMP-VALIDATION] Session ${sessionId}:`);
    console.log(`  Events: ${events.length}`);
    console.log(`  Duration: ${(duration / 1000).toFixed(2)}s`);
    console.log(`  Timestamp type: ${isRelative ? 'relative' : 'absolute'}`);
    console.log(`  Range: ${minTime}ms - ${maxTime}ms`);

    // Warn if timestamps seem problematic
    if (!isRelative && duration > 24 * 60 * 60 * 1000) {
      console.warn(`[TIMESTAMP-WARNING] Very long session duration (${(duration / 3600000).toFixed(1)}h) - may indicate absolute timestamps`);
    }

    if (duration <= 0) {
      console.error(`[TIMESTAMP-ERROR] Invalid duration: ${duration}ms`);
    }
  }
}
