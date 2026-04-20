import { Notice, Plugin, addIcon } from 'obsidian';
import { asError } from './desktop';
import { LLMService } from './LLMService';
import { NoteWriter } from './NoteWriter';
import { ServerManager } from './ServerManager';
import { LocalMeetingTranscriberSettingTab } from './settings';
import { TranscriptionModal } from './TranscriptionModal';
import { WhisperService } from './WhisperService';
import { DEFAULT_SETTINGS } from './types';
import type { MeetingTranscriberSettings } from './types';

const MIC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
  <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
  <line x1="12" y1="19" x2="12" y2="22"/>
  <line x1="8" y1="22" x2="16" y2="22"/>
</svg>`;

type StatusBarState = 'checking' | 'starting' | 'ready' | 'offline';

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

    this.whisperManager = new ServerManager(
      'Whisper',
      () => this.settings.whisperStartCommand,
      () => this.whisperService.ping(),
      30_000,
    );
    this.llmManager = new ServerManager(
      'LLM',
      () => this.settings.llmStartCommand,
      () => this.llmService.ping(),
      5 * 60_000,
    );

    addIcon('lmt-mic', MIC_ICON);
    this.addRibbonIcon('lmt-mic', 'Transcribe meeting recording', () => {
      this.openModal();
    });

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('mt-status-bar');
    this.statusBarItem.title = 'Click to check server status';
    this.statusBarItem.addEventListener('click', () => {
      void this.checkAndReportStatus();
    });
    this.setStatusBarState('checking', 'Meeting transcriber: checking…');

    this.addCommand({
      id: 'transcribe-meeting',
      name: 'Transcribe meeting audio',
      callback: () => {
        this.openModal();
      },
    });

    this.addCommand({
      id: 'start-whisper-server',
      name: 'Start whisper server',
      callback: () => {
        void this.whisperManager.startIfNeeded();
      },
    });

    this.addCommand({
      id: 'start-llm-server',
      name: 'Start LLM server',
      callback: () => {
        void this.llmManager.startIfNeeded();
      },
    });

    this.addCommand({
      id: 'start-all-servers',
      name: 'Start all servers',
      callback: () => {
        void this.startAllServers();
      },
    });

    this.addCommand({
      id: 'check-server-status',
      name: 'Check server status',
      callback: () => {
        void this.checkAndReportStatus();
      },
    });

    this.addSettingTab(new LocalMeetingTranscriberSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void this.startAllServers();
    });

    this.registerInterval(window.setInterval(() => {
      void this.updateStatusBar();
    }, 30_000));
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

  async startAllServers(): Promise<void> {
    this.setStatusBarState('starting', 'Meeting transcriber: starting…');

    await Promise.all([
      this.settings.whisperAutoStart
        ? this.whisperManager.startIfNeeded().catch((error) =>
            new Notice(`Local Meeting Transcriber: Whisper failed — ${asError(error).message}`),
          )
        : Promise.resolve(),
      this.settings.llmAutoStart
        ? this.llmManager.startIfNeeded().catch((error) =>
            new Notice(`Local Meeting Transcriber: LLM failed — ${asError(error).message}`),
          )
        : Promise.resolve(),
    ]);

    await this.updateStatusBar();
  }

  async updateStatusBar(): Promise<void> {
    const [whisperOk, llmOk] = await Promise.all([
      this.whisperManager.ping(),
      this.llmManager.ping(),
    ]);

    if (whisperOk && llmOk) {
      this.setStatusBarState('ready', 'Meeting transcriber: ready');
      return;
    }

    const offline = [!whisperOk ? 'Whisper' : null, !llmOk ? 'LLM' : null]
      .filter((value): value is string => value !== null)
      .join(', ');
    this.setStatusBarState('offline', `Meeting transcriber: ${offline} offline`);
  }

  private setStatusBarState(state: StatusBarState, text: string): void {
    this.statusBarItem.setText(text);
    this.statusBarItem.removeClass(
      'mt-status-bar--checking',
      'mt-status-bar--starting',
      'mt-status-bar--ready',
      'mt-status-bar--offline',
    );
    this.statusBarItem.addClass(`mt-status-bar--${state}`);
  }

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
      `Whisper server: ${whisperOk ? 'ready' : 'offline'}\n` +
      `LLM server: ${llmOk ? 'ready' : 'offline'}`,
      5000,
    );

    await this.updateStatusBar();
  }
}
