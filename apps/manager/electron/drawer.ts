import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeviceSettings } from '@shul-store/shared';

export interface DrawerResult {
  success: boolean;
  error: string | null;
}

/** ESC/POS drawer-kick pulse (ESC p 0 50ms 250ms) — the universal command
 * receipt printers forward to a drawer on their RJ11 port; serial-attached
 * drawers accept the same bytes directly. */
const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

/** Winspool RAW print: the only reliable way to reach a Windows-installed
 * receipt printer outside the driver pipeline — webContents.print renders
 * documents and cannot carry control bytes. */
const WINDOWS_RAW_PRINT_PS = `
$printer = $args[0]
$file = $args[1]
$cs = @'
using System;
using System.Runtime.InteropServices;
public class DrawerKick {
  [StructLayout(LayoutKind.Sequential)]
  public class DOCINFOA {
    public string pDocName;
    public string pOutputFile;
    public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static bool Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return false;
    var di = new DOCINFOA { pDocName = "Cash drawer", pDataType = "RAW" };
    IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
    Marshal.Copy(bytes, 0, p, bytes.Length);
    int written;
    bool ok =
      StartDocPrinter(h, 1, di) &&
      StartPagePrinter(h) &&
      WritePrinter(h, p, bytes.Length, out written) &&
      written == bytes.Length;
    EndPagePrinter(h);
    EndDocPrinter(h);
    ClosePrinter(h);
    Marshal.FreeCoTaskMem(p);
    return ok;
  }
}
'@
Add-Type -TypeDefinition $cs
$bytes = [System.IO.File]::ReadAllBytes($file)
if (-not [DrawerKick]::Send($printer, $bytes)) {
  throw "Could not send the drawer pulse to '$printer' (check the printer is installed and online)."
}
`;

function execFileAsync(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function rawPrintToPrinter(
  bytes: Buffer,
  printerName: string,
): Promise<void> {
  const file = path.join(tmpdir(), `drawer-kick-${Date.now()}.bin`);
  await writeFile(file, bytes);
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_RAW_PRINT_PS,
      printerName,
      file,
    ]);
    return;
  }
  await execFileAsync('lp', ['-d', printerName, '-o', 'raw', file]);
}

async function serialKick(portPath: string): Promise<void> {
  // Loaded lazily: serialport is native and only exists in the packaged app.
  const serialport = (await import('serialport')) as unknown as {
    SerialPort: new (options: { path: string; baudRate: number }) => {
      open(cb: (error?: Error | null) => void): void;
      write(
        data: Buffer,
        cb: (error?: Error | null, bytesWritten?: number) => void,
      ): void;
      drain(cb: (error?: Error | null) => void): void;
      close(cb?: (error?: Error | null) => void): void;
    };
  };
  const port = new serialport.SerialPort({
    path: portPath,
    baudRate: 9600,
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error?: Error | null) => {
      port.close(() => {});
      reject(error ?? new Error('Cash drawer serial write failed'));
    };
    port.open((openError) => {
      if (openError) return fail(openError);
      port.write(DRAWER_KICK, (writeError) => {
        if (writeError) return fail(writeError);
        port.drain((drainError) => {
          if (drainError) return fail(drainError);
          port.close((closeError) => {
            if (closeError) return fail(closeError);
            resolve();
          });
        });
      });
    });
  });
}

/** Kicks the cash drawer according to the device settings. 'none' is a
 * silent no-op so checkout can call unconditionally on cash tenders. */
export async function openDrawer(
  settings: DeviceSettings,
  receiptPrinterName: string | null,
): Promise<DrawerResult> {
  try {
    if (settings.cashDrawerMode === 'receipt_printer') {
      if (!receiptPrinterName) {
        return {
          success: false,
          error:
            'Cash drawer is set to "receipt printer" but no receipt printer is configured.',
        };
      }
      await rawPrintToPrinter(DRAWER_KICK, receiptPrinterName);
      return { success: true, error: null };
    }
    if (settings.cashDrawerMode === 'serial') {
      if (!settings.cashDrawerPort) {
        return {
          success: false,
          error:
            'Cash drawer is set to "serial" but no serial port is configured.',
        };
      }
      await serialKick(settings.cashDrawerPort);
      return { success: true, error: null };
    }
    return { success: true, error: null };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Cash drawer kick failed',
    };
  }
}
