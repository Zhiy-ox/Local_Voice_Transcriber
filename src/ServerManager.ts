import { Notice } from 'obsidian';

const { spawn } = (window as any).require('child_process') as typeof import('child_process');
const os = (window as any).require('os') as typeof import('os');

export class ServerManager {
  private process: ReturnType<typeof spawn> | null = null;

  constructor(
    private readonly name: string,         // display name, e.g. "Whisper" or "LLM"
    private readonly getCommand: () => string,
    private readonly pingFn: () => Promise<boolean>,
    private readonly timeoutMs: number = 5 * 60_000,
  ) {}

  // ── Health check ───────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    return this.pingFn();
  }

  // ── Server lifecycle ───────────────────────────────────────────────────────

  /** Idempotent: no-op if server is already reachable. Returns true when ready. */
  async startIfNeeded(): Promise<boolean> {
    if (await this.ping()) return true;

    const command = this.getCommand().trim();
    if (!command) {
      new Notice(
        `Local Meeting Transcriber: ${this.name} server is not reachable.\n` +
        `Set a start command in Settings to auto-start it, or start it manually.`,
        8000,
      );
      return false;
    }

    new Notice(`Local Meeting Transcriber: starting ${this.name} server…`);

    // Build a full env — Electron's renderer process.env can be sparse
    const fullEnv = {
      HOME: os.homedir(),
      USER: os.userInfo().username,
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      ...process.env,
    };

    let earlyError: string | null = null;
    let stderrBuf = '';

    // sh -c handles any command string (multi-word, paths with spaces, shell features)
    this.process = spawn('sh', ['-c', command], {
      detached: false,
      env: fullEnv,
    });

    this.process.stderr?.on('data', (d: Buffer) => {
      const txt = d.toString();
      stderrBuf += txt;
      console.log(`[${this.name}]`, txt.trim());
    });

    this.process.on('error', (err: Error) => {
      earlyError = err.message;
      new Notice(`Local Meeting Transcriber: ${this.name} failed to start — ${err.message}`, 8000);
    });

    this.process.on('close', (code: number | null) => {
      if (code !== null && code !== 0) {
        earlyError = `exited with code ${code}`;
        const tail = stderrBuf.slice(-400).trim();
        new Notice(
          `Local Meeting Transcriber: ${this.name} server crashed (code ${code})\n${tail}`,
          10000,
        );
        console.error(`[${this.name} crash]`, stderrBuf);
      }
      this.process = null;
    });

    // Poll until ready or timeout
    const INTERVAL_MS = 500;
    const steps = Math.ceil(this.timeoutMs / INTERVAL_MS);
    const NOTICE_EVERY = Math.ceil(30_000 / INTERVAL_MS); // progress notice every 30 s

    for (let i = 0; i < steps; i++) {
      await sleep(INTERVAL_MS);
      if (earlyError) return false;
      if (await this.ping()) {
        new Notice(`Local Meeting Transcriber: ${this.name} server ready ✓`);
        return true;
      }
      if (i > 0 && i % NOTICE_EVERY === 0) {
        const elapsed = Math.round((i * INTERVAL_MS) / 1000);
        new Notice(`Local Meeting Transcriber: waiting for ${this.name} server… (${elapsed}s)`);
      }
    }

    new Notice(
      `Local Meeting Transcriber: ${this.name} server did not become ready in time.\n` +
      `Check the start command in Settings.`,
      10000,
    );
    return false;
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
