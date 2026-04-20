import type { MeetingTranscriberSettings, TranscriptionResult } from './types';

const fs = (window as any).require('fs') as typeof import('fs');
const os = (window as any).require('os') as typeof import('os');
const path = (window as any).require('path') as typeof import('path');
const { spawn, execSync } = (window as any).require('child_process') as typeof import('child_process');

export class WhisperService {
  constructor(private settings: MeetingTranscriberSettings) {}

  updateSettings(settings: MeetingTranscriberSettings): void {
    this.settings = settings;
  }

  // ── Health check (for whisper-server mode) ─────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.settings.whisperServerUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Transcription via whisper-cli ──────────────────────────────────────────

  async transcribe(
    filePath: string,
    signal: AbortSignal,
    onElapsed?: (seconds: number) => void,
  ): Promise<TranscriptionResult> {
    const resolvedPath = resolveTilde(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Audio file not found: ${resolvedPath}`);
    }

    // Resolve whisper-cli
    const cliPath = this.resolveWhisperCli();
    if (!cliPath) {
      throw new Error(
        'whisper-cli not found. Set the path in Settings or install with:\n  brew install whisper-cpp',
      );
    }

    const modelPath = resolveTilde(this.settings.whisperModelPath);
    if (!modelPath) {
      throw new Error('Whisper model path is not configured. Set it in Settings > Local Meeting Transcriber.');
    }
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Whisper model not found at: ${modelPath}`);
    }

    // Convert unsupported formats (m4a, mp4, webm, aac) to 16kHz mono WAV using ffmpeg
    const ext = path.extname(resolvedPath).slice(1).toLowerCase();
    const NEEDS_CONVERSION = ['m4a', 'mp4', 'webm', 'aac'];
    let audioPath = resolvedPath;
    let tmpWav: string | null = null;

    if (NEEDS_CONVERSION.includes(ext)) {
      const ffmpeg = this.resolveFfmpeg();
      if (!ffmpeg) {
        throw new Error(
          'ffmpeg is required to convert this audio format but was not found.\n' +
          'Install with: brew install ffmpeg\nOr set the path in Settings.',
        );
      }
      tmpWav = path.join(os.tmpdir(), `lmt-whisper-${Date.now()}.wav`);
      await spawnProcess(ffmpeg, [
        '-i', resolvedPath,
        '-ar', '16000',
        '-ac', '1',
        '-y',
        '-loglevel', 'error',
        tmpWav,
      ], signal);
      audioPath = tmpWav;
    }

    // Output JSON to a temp file
    const tmpBase = path.join(os.tmpdir(), `lmt-whisper-out-${Date.now()}`);
    const tmpJson = `${tmpBase}.json`;

    const lang = this.settings.defaultLanguage || 'en';
    const args = [
      '--model', modelPath,
      '--language', lang,
      '--output-json-full',
      '--output-file', tmpBase,
      '-np',   // suppress progress output to stderr
      audioPath,
    ];

    // Elapsed timer
    const startTime = Date.now();
    let timerHandle: ReturnType<typeof setInterval> | null = null;
    if (onElapsed) {
      timerHandle = setInterval(() => {
        onElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    }

    try {
      await spawnProcess(cliPath, args, signal);
    } finally {
      if (timerHandle !== null) clearInterval(timerHandle);
      if (tmpWav) try { fs.unlinkSync(tmpWav); } catch { /* best effort */ }
    }

    if (!fs.existsSync(tmpJson)) {
      throw new Error('whisper-cli did not produce output. Check audio file format and model path.');
    }

    const raw = fs.readFileSync(tmpJson, 'utf8');
    try { fs.unlinkSync(tmpJson); } catch { /* best effort */ }

    return parseCliJson(JSON.parse(raw));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private resolveWhisperCli(): string | null {
    // 1. Explicit setting
    const settingPath = this.settings.whisperCliPath.trim();
    if (settingPath) {
      const resolved = resolveTilde(settingPath);
      if (fs.existsSync(resolved)) return resolved;
    }

    // 2. Common Homebrew paths
    const CANDIDATES = [
      '/opt/homebrew/bin/whisper-cli',   // Apple Silicon
      '/usr/local/bin/whisper-cli',      // Intel Mac / manual install
    ];
    for (const c of CANDIDATES) {
      if (fs.existsSync(c)) return c;
    }

    return null;
  }

  private resolveFfmpeg(): string | null {
    // 1. Explicit setting
    const settingPath = this.settings.ffmpegPath.trim();
    if (settingPath) {
      const resolved = resolveTilde(settingPath);
      if (fs.existsSync(resolved)) return resolved;
      // User set a path explicitly but it doesn't exist — throw rather than silently falling through
      throw new Error(
        `ffmpeg not found at configured path: ${resolved}\n` +
        'Clear the path in Settings to use auto-detection.',
      );
    }

    // 2. Common Homebrew paths
    const CANDIDATES = [
      '/opt/homebrew/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
    ];
    for (const c of CANDIDATES) {
      if (fs.existsSync(c)) return c;
    }

    // 3. PATH lookup
    try {
      const result = execSync('which ffmpeg 2>/dev/null', { timeout: 2000 }).toString().trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* ffmpeg not in PATH */ }

    return null;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function resolveTilde(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function spawnProcess(
  bin: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { detached: false });
    const procName = bin.split('/').pop() ?? bin;
    let stderr = '';

    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`${procName} exited with code ${code}:\n${stderr.slice(-500)}`));
    });

    signal.addEventListener('abort', () => {
      proc.kill();
      reject(new Error('Transcription cancelled'));
    }, { once: true });
  });
}

function parseCliJson(json: unknown): TranscriptionResult {
  const j = json as Record<string, unknown>;
  const items: unknown[] = Array.isArray(j.transcription) ? j.transcription : [];

  const segments = (items as Record<string, unknown>[]).map(s => ({
    start: parseTimestamp(String((s.timestamps as Record<string, unknown>)?.from ?? '00:00:00,000')),
    end: parseTimestamp(String((s.timestamps as Record<string, unknown>)?.to ?? '00:00:00,000')),
    text: String(s.text ?? '').trim(),
  }));

  const text = segments.map(s => s.text).join(' ').trim();
  const duration = segments.length > 0 ? segments[segments.length - 1].end : 0;

  return { text, segments, duration };
}

// Parse "HH:MM:SS,mmm" → seconds
function parseTimestamp(ts: string): number {
  const [time, ms] = ts.split(',');
  const [h, m, s] = (time ?? '0:0:0').split(':').map(Number);
  return h * 3600 + m * 60 + s + (Number(ms ?? 0) / 1000);
}
