import { Plugin, Notice, addIcon } from 'obsidian';
import { LocalMeetingTranscriberSettingTab } from './settings';
import { WhisperService } from './WhisperService';
import { LLMService } from './LLMService';
import { ServerManager } from './ServerManager';
import { NoteWriter } from './NoteWriter';
import { TranscriptionModal } from './TranscriptionModal';
import { DEFAULT_SETTINGS } from './types';
import type { MeetingTranscriberSettings } from './types';

const MIC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
  <line x1="12" y1="19" x2="12" y2="22"/>
  <line x1="8" y1="22" x2="16" y2="22"/>
</svg>`;

export default class LocalMeetingTranscriberPlugin extends Plugin {
  settings!: MeetingTranscriberSettings;

  whisperService!: WhisperService;
  llmService!: LLMService;
  whisperManager!: ServerManager;
  llmManager!: ServerManager;
  noteWriter!: NoteWriter;

  private statusBarItem!: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.whisperService = new WhisperService(this.settings);
    this.llmService = new LLMService(this.settings);
    this.noteWriter = new NoteWriter(this.app, this.settings);

    // ServerManagers own the server lifecycle; each delegates ping to the respective service
    this.whisperManager = new ServerManager(
      'Whisper',
      () => this.settings.whisperStartCommand,
      () => this.whisperService.ping(),
      30_000,          // whisper-server starts fast
    );
    this.llmManager = new ServerManager(
      'LLM',
      () => this.settings.llmStartCommand,
      () => this.llmService.ping(),
      5 * 60_000,      // LLM may take minutes to load
    );

    addIcon('lmt-mic', MIC_ICON);
    this.addRibbonIcon('lmt-mic', 'Transcribe meeting recording', () => this.openModal());

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText('MT: checking…');
    this.statusBarItem.title = 'Local Meeting Transcriber — click to check server status';
    this.statusBarItem.style.cursor = 'pointer';
    this.statusBarItem.addEventListener('click', () => this.checkAndReportStatus());

    this.addCommand({
      id: 'transcribe-meeting',
      name: 'Transcribe meeting audio',
      callback: () => this.openModal(),
    });

    this.addCommand({
      id: 'start-whisper-server',
      name: 'Start Whisper server',
      callback: () => this.whisperManager.startIfNeeded(),
    });

    this.addCommand({
      id: 'start-llm-server',
      name: 'Start LLM server',
      callback: () => this.llmManager.startIfNeeded(),
    });

    this.addCommand({
      id: 'start-all-servers',
      name: 'Start all servers',
      callback: () => this.startAllServers(),
    });

    this.addCommand({
      id: 'check-server-status',
      name: 'Check server status',
      callback: () => this.checkAndReportStatus(),
    });

    this.addSettingTab(new LocalMeetingTranscriberSettingTab(this.app, this));

    // Auto-start on load (non-blocking)
    this.startAllServers();

    // Re-check status bar every 30 s
    this.registerInterval(window.setInterval(() => this.updateStatusBar(), 30_000));
  }

  onunload(): void {
    this.whisperManager.stop();
    this.llmManager.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.whisperService?.updateSettings(this.settings);
    this.llmService?.updateSettings(this.settings);
    this.noteWriter?.updateSettings(this.settings);
  }

  // ── Server management ──────────────────────────────────────────────────────

  async startAllServers(): Promise<void> {
    this.statusBarItem.setText('MT: starting…');
    this.statusBarItem.style.color = 'var(--text-muted)';

    await Promise.all([
      this.settings.whisperAutoStart
        ? this.whisperManager.startIfNeeded().catch(e =>
            new Notice(`Local Meeting Transcriber: Whisper failed — ${(e as Error).message}`)
          )
        : Promise.resolve(),
      this.settings.llmAutoStart
        ? this.llmManager.startIfNeeded().catch(e =>
            new Notice(`Local Meeting Transcriber: LLM failed — ${(e as Error).message}`)
          )
        : Promise.resolve(),
    ]);

    await this.updateStatusBar();
  }

  // ── Status bar ─────────────────────────────────────────────────────────────

  async updateStatusBar(): Promise<void> {
    const [whisperOk, llmOk] = await Promise.all([
      this.whisperManager.ping(),
      this.llmManager.ping(),
    ]);

    if (whisperOk && llmOk) {
      this.statusBarItem.setText('MT: ready ✓');
      this.statusBarItem.style.color = 'var(--color-green)';
    } else {
      const offline = [!whisperOk && 'Whisper', !llmOk && 'LLM']
        .filter(Boolean).join(', ');
      this.statusBarItem.setText(`MT: ${offline} offline`);
      this.statusBarItem.style.color = 'var(--color-orange)';
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private openModal(): void {
    new TranscriptionModal(
      this.app,
      this.whisperService,
      this.llmService,
      this.whisperManager,
      this.llmManager,
      this.noteWriter,
    ).open();
  }

  private async checkAndReportStatus(): Promise<void> {
    const [whisperOk, llmOk] = await Promise.all([
      this.whisperManager.ping(),
      this.llmManager.ping(),
    ]);
    new Notice(
      `Whisper server: ${whisperOk ? '✓ ready' : '✗ offline'}\n` +
      `LLM server: ${llmOk ? '✓ ready' : '✗ offline'}`,
      5000,
    );
    await this.updateStatusBar();
  }
}
