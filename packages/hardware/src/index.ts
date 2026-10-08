import type { ScaleReading, ScaleStatus } from '@shul-store/shared';

export type ScaleMode = 'none' | 'simulated' | 'serial';
export type ScaleUnit = 'lb' | 'oz' | 'kg';

export interface ScaleReaderOptions {
  mode: ScaleMode;
  /** Serial port path (e.g. 'COM3', '/dev/ttyUSB0'); serial mode only. */
  port: string | null;
  unit: ScaleUnit;
  onWeight(reading: ScaleReading): void;
  onStatus(status: ScaleStatus): void;
}

export interface ScaleReader {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Most recent reading, or null before the first weight arrives. */
  lastReading(): ScaleReading | null;
  status(): ScaleStatus;
}

/** Extract a weight from a scale output line. Handles the common
 * continuous-protocol shapes seen on Brecknell/CAS/NCI-style scales:
 *   "W,+000.500,lb"  "ST,GS,+  0.500 lb"  "   1.234 kg"  "US,NT,-0.010"
 * Returns weight normalized to the requested unit, or null for
 * non-weight lines (motion, under-range, error flags). */
export function parseWeightLine(
  raw: string,
  unit: ScaleUnit,
): { weight: number; stable: boolean } | null {
  const line = raw.trim();
  if (!line) return null;
  if (
    /^(?:US|UF|UN|OL|EL|ERR|M|W\b)/i.test(line) &&
    !/^[+-\d\s.,]/.test(line)
  ) {
    // US = unstable, OL/EL/ERR = out of range — still try to read a number
    // below since unstable lines often carry the live weight.
    if (/^(?:OL|EL|ERR)/i.test(line)) return null;
  }
  const match = /([+-]?\s*\d+(?:[.,]\d+)?)/.exec(line);
  if (!match) return null;
  const value = parseFloat(match[1]!.replace(/\s+/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const stable = !/^(?:US|UF|UN|M)\b/i.test(line) || /\bST\b/i.test(line);
  // Unit written on the line wins; otherwise the configured unit is assumed.
  const lineUnit = /\bkg\b/i.test(line)
    ? 'kg'
    : /\boz\b/i.test(line)
      ? 'oz'
      : /\blb\b/i.test(line)
        ? 'lb'
        : unit;
  return { weight: convertWeight(Math.abs(value), lineUnit, unit), stable };
}

export function convertWeight(
  weight: number,
  from: ScaleUnit,
  to: ScaleUnit,
): number {
  if (from === to) return round3(weight);
  const grams =
    from === 'kg'
      ? weight * 1000
      : from === 'lb'
        ? weight * 453.59237
        : weight * 28.349523125;
  return round3(
    to === 'kg'
      ? grams / 1000
      : to === 'lb'
        ? grams / 453.59237
        : grams / 28.349523125,
  );
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

class SimulatedScaleReader implements ScaleReader {
  private timer: NodeJS.Timeout | null = null;
  private last: ScaleReading | null = null;
  private currentStatus: ScaleStatus;

  constructor(private options: ScaleReaderOptions) {
    this.currentStatus = { mode: 'simulated', connected: false, error: null };
  }

  async start(): Promise<void> {
    this.currentStatus = { mode: 'simulated', connected: true, error: null };
    this.options.onStatus(this.currentStatus);
    // Simulated item weight drifts gently so the dialog feels live, then
    // settles — like a real scale zeroing in.
    let ticks = 0;
    this.timer = setInterval(() => {
      ticks += 1;
      const base = 1.0 + (ticks % 7) * 0.125;
      const jitter = ticks < 4 ? (Math.random() - 0.5) * 0.02 : 0;
      this.last = {
        weight: round3(base + jitter),
        unit: this.options.unit,
        stable: ticks >= 4,
      };
      this.options.onWeight(this.last);
    }, 350);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.last = null;
    this.currentStatus = { mode: 'simulated', connected: false, error: null };
    this.options.onStatus(this.currentStatus);
  }

  lastReading(): ScaleReading | null {
    return this.last;
  }

  status(): ScaleStatus {
    return this.currentStatus;
  }
}

class SerialScaleReader implements ScaleReader {
  private portInstance: {
    close(cb?: (err?: Error | null) => void): void;
  } | null = null;
  private last: ScaleReading | null = null;
  private currentStatus: ScaleStatus;

  constructor(private options: ScaleReaderOptions) {
    this.currentStatus = { mode: 'serial', connected: false, error: null };
  }

  private setStatus(status: ScaleStatus): void {
    this.currentStatus = status;
    this.options.onStatus(status);
  }

  async start(): Promise<void> {
    if (!this.options.port)
      throw new Error('No serial port selected for the scale.');
    // Loaded lazily: serialport is a native module that only exists inside
    // the packaged Electron app (each app declares it as a dependency).
    const serialport = (await import('serialport')) as unknown as {
      SerialPort: new (options: {
        path: string;
        baudRate: number;
        dataBits: number;
        stopBits: number;
        parity: string;
        autoOpen: boolean;
      }) => {
        on(
          event: 'open' | 'error' | 'close' | 'data',
          cb: (arg?: unknown) => void,
        ): void;
        open(cb?: (err?: Error | null) => void): void;
        close(cb?: (err?: Error | null) => void): void;
      };
    };
    const port = new serialport.SerialPort({
      path: this.options.port,
      // The de-facto checkout-scale default: 9600 7E1. Most USB-serial
      // scales accept 8N1 too; the parser ignores framing anyway.
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    });
    this.portInstance = port;
    let buffer = '';
    port.on('data', (chunk?: unknown) => {
      buffer += String(chunk ?? '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const parsed = parseWeightLine(line, this.options.unit);
        if (!parsed) continue;
        this.last = {
          weight: parsed.weight,
          unit: this.options.unit,
          stable: parsed.stable,
        };
        this.options.onWeight(this.last);
      }
    });
    port.on('error', (error?: unknown) => {
      this.setStatus({
        mode: 'serial',
        connected: false,
        error: error instanceof Error ? error.message : 'Scale error',
      });
    });
    port.on('close', () => {
      this.setStatus({ mode: 'serial', connected: false, error: null });
    });
    await new Promise<void>((resolve, reject) => {
      port.open((error?: Error | null) => {
        if (error)
          reject(new Error(`Could not open scale port: ${error.message}`));
        else resolve();
      });
    });
    this.setStatus({ mode: 'serial', connected: true, error: null });
  }

  async stop(): Promise<void> {
    const port = this.portInstance;
    this.portInstance = null;
    this.last = null;
    if (port) {
      await new Promise<void>((resolve) => {
        try {
          port.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    this.setStatus({ mode: 'serial', connected: false, error: null });
  }

  lastReading(): ScaleReading | null {
    return this.last;
  }

  status(): ScaleStatus {
    return this.currentStatus;
  }
}

class NullScaleReader implements ScaleReader {
  private currentStatus: ScaleStatus = {
    mode: 'none',
    connected: false,
    error: null,
  };
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  lastReading(): ScaleReading | null {
    return null;
  }
  status(): ScaleStatus {
    return this.currentStatus;
  }
}

export function createScaleReader(options: ScaleReaderOptions): ScaleReader {
  switch (options.mode) {
    case 'simulated':
      return new SimulatedScaleReader(options);
    case 'serial':
      return new SerialScaleReader(options);
    default:
      return new NullScaleReader();
  }
}
