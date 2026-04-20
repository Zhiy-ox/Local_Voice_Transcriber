import { App, Modal, Setting, Notice } from 'obsidian';
import type { WhisperService } from './WhisperService';
import type { LLMService } from './LLMService';
import type { ServerManager } from './ServerManager';
import type { NoteWriter } from './NoteWriter';
import type { NoteType, PipelineStatus } from './types';

const path = (window as any).require('path') as typeof import('path');

export class TranscriptionModal extends Modal {
  private selectedFilePath: string | null = null;
  private contextText = '';
  private noteType: NoteType = 'general';
  private abortController: AbortController | null = null;

  private fileZoneEl!: HTMLElement;
  private fileNameEl!: HTMLElement;
  private optionsEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly whisperService: WhisperService,
    private readonly llmService: LLMService,
    private readonly whisperManager: ServerManager,
    private readonly llmManager: ServerManager,
    private readonly noteWriter: NoteWriter,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('mt-modal');
    contentEl.createEl('h2', { text: 'Transcribe Meeting Recording' });

    this.renderFileZone(contentEl);
    this.renderOptions(contentEl);
    this.renderProgress(contentEl);
    this.renderActions(contentEl);

    this.setStatus({ stage: 'idle' });
  }

  onClose(): void {
    this.abortController?.abort();
    this.contentEl.empty();
  }

  // ── File selection zone ───────────────────────────────────────────────────

  private renderFileZone(parent: HTMLElement): void {
    this.fileZoneEl = parent.createDiv('mt-drop-zone');
    this.fileZoneEl.setText('Drop audio file here, or click to browse');

    this.fileZoneEl.addEventListener('click', async () => {
      const filePath = await this.openFilePicker();
      if (filePath) this.selectFile(filePath);
    });

    this.fileZoneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.fileZoneEl.addClass('mt-drop-zone--active');
    });
    this.fileZoneEl.addEventListener('dragleave', () => {
      this.fileZoneEl.removeClass('mt-drop-zone--active');
    });
    this.fileZoneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.fileZoneEl.removeClass('mt-drop-zone--active');
      const file = e.dataTransfer?.files[0];
      if (file) {
        const nativePath: string = (file as any).path ?? '';
        if (nativePath) this.selectFile(nativePath);
      }
    });

    this.fileNameEl = parent.createDiv('mt-filename');
    this.fileNameEl.style.display = 'none';
  }

  private selectFile(filePath: string): void {
    this.selectedFilePath = filePath;
    this.fileNameEl.style.display = '';
    this.fileNameEl.setText(`Selected: ${path.basename(filePath)}`);
    this.fileZoneEl.addClass('mt-drop-zone--selected');
    this.updateStartButton();
  }

  private async openFilePicker(): Promise<string | null> {
    const filters = [
      { name: 'Audio Files', extensions: ['m4a', 'mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'aac'] },
      { name: 'All Files', extensions: ['*'] },
    ];
    try {
      const electron = (window as any).require('electron');
      const remote = electron.remote ?? (window as any).require('@electron/remote');
      const result = await remote.dialog.showOpenDialog({
        properties: ['openFile'],
        filters,
      });
      if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
      }
    } catch {
      return await this.htmlFilePicker();
    }
    return null;
  }

  private htmlFilePicker(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.m4a,.mp3,.wav,.ogg,.flac,.mp4,.webm,.aac';
      input.onchange = () => {
        const file = input.files?.[0];
        resolve(file ? ((file as any).path ?? null) : null);
        input.remove();
      };
      input.click();
    });
  }

  // ── Options form ──────────────────────────────────────────────────────────

  private renderOptions(parent: HTMLElement): void {
    this.optionsEl = parent.createDiv('mt-options');

    new Setting(this.optionsEl)
      .setName('Context / participants')
      .setDesc('Names, roles, or topics — helps the LLM identify speakers and tag correctly.')
      .addText(text =>
        text
          .setPlaceholder('e.g. Alice, Bob (client), Carol — Q2 planning')
          .onChange(v => { this.contextText = v; })
      );

    new Setting(this.optionsEl)
      .setName('Meeting type')
      .addDropdown(dd =>
        dd
          .addOptions({
            general: 'General Meeting',
            'research-meeting': 'Research Meeting',
            supervision: 'Supervision / 1-on-1',
            'conference-call': 'Conference Call',
          })
          .setValue(this.noteType)
          .onChange(v => { this.noteType = v as NoteType; })
      );
  }

  // ── Progress display ──────────────────────────────────────────────────────

  private renderProgress(parent: HTMLElement): void {
    this.progressEl = parent.createDiv('mt-progress');
    this.progressEl.style.display = 'none';
  }

  private setStatus(status: PipelineStatus): void {
    this.progressEl.empty();

    if (status.stage === 'idle') {
      this.progressEl.style.display = 'none';
      return;
    }

    this.progressEl.style.display = '';

    if (status.stage === 'done') {
      const noteName = status.notePath.split('/').pop() ?? status.notePath;
      this.progressEl.createEl('p', {
        cls: 'mt-status mt-status--done',
        text: `✓ Note saved: ${noteName}`,
      });
      const link = this.progressEl.createEl('a', { text: 'Open note', cls: 'mt-link' });
      link.addEventListener('click', () => {
        const file = this.app.vault.getAbstractFileByPath(status.notePath);
        if (file) this.app.workspace.getLeaf().openFile(file as any);
        this.close();
      });
      this.cancelBtn.style.display = 'none';
      this.startBtn.disabled = false;
      this.startBtn.textContent = 'Transcribe another';
      return;
    }

    if (status.stage === 'error') {
      this.progressEl.createEl('p', {
        cls: 'mt-status mt-status--error',
        text: `✗ ${status.message}`,
      });
      this.cancelBtn.style.display = 'none';
      this.startBtn.disabled = false;
      this.startBtn.textContent = 'Retry';
      return;
    }

    let msg: string;
    switch (status.stage) {
      case 'starting-servers': msg = 'Starting servers…'; break;
      case 'transcribing':     msg = `Transcribing audio (${status.elapsed}s)…`; break;
      case 'summarising':      msg = 'Generating meeting notes…'; break;
      case 'saving':           msg = 'Saving note to vault…'; break;
      default:                 msg = status.stage;
    }
    this.progressEl.createEl('p', { cls: 'mt-status', text: msg });

    const stages: Array<PipelineStatus['stage']> = [
      'starting-servers', 'transcribing', 'summarising', 'saving',
    ];
    const stageLabels: Record<string, string> = {
      'starting-servers': 'Servers',
      transcribing: 'Transcribing',
      summarising: 'Summarising',
      saving: 'Saving',
    };
    const dotsEl = this.progressEl.createDiv('mt-stages');
    stages.forEach(s => {
      const dot = dotsEl.createSpan({ cls: 'mt-stage-dot' });
      dot.setText(stageLabels[s] ?? s);
      if (s === status.stage) dot.addClass('mt-stage-dot--active');
      else if (stages.indexOf(s) < stages.indexOf(status.stage)) dot.addClass('mt-stage-dot--done');
    });
  }

  // ── Actions row ───────────────────────────────────────────────────────────

  private renderActions(parent: HTMLElement): void {
    const row = parent.createDiv('mt-actions');

    this.cancelBtn = row.createEl('button', { text: 'Cancel', cls: 'mt-btn' });
    this.cancelBtn.style.display = 'none';
    this.cancelBtn.addEventListener('click', () => {
      this.abortController?.abort();
      this.cancelBtn.style.display = 'none';
      this.startBtn.disabled = false;
      this.startBtn.textContent = 'Start pipeline';
      this.setStatus({ stage: 'idle' });
      new Notice('Local Meeting Transcriber: cancelled.');
    });

    this.startBtn = row.createEl('button', {
      text: 'Start pipeline',
      cls: 'mt-btn mt-btn--primary',
    });
    this.startBtn.disabled = true;
    this.startBtn.addEventListener('click', () => this.runPipeline());
  }

  private updateStartButton(): void {
    this.startBtn.disabled = !this.selectedFilePath;
  }

  // ── Pipeline ──────────────────────────────────────────────────────────────

  private async runPipeline(): Promise<void> {
    if (!this.selectedFilePath) return;

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.startBtn.disabled = true;
    this.startBtn.textContent = 'Running…';
    this.cancelBtn.style.display = '';

    const audioFilename = path.basename(this.selectedFilePath);

    try {
      // Step 0: Ensure servers are reachable (startIfNeeded is idempotent)
      this.setStatus({ stage: 'starting-servers' });
      const [whisperOk, llmOk] = await Promise.all([
        this.whisperManager.startIfNeeded(),
        this.llmManager.startIfNeeded(),
      ]);
      if (!whisperOk) {
        throw new Error(
          'Whisper server could not be started. ' +
          'Check Settings > Local Meeting Transcriber.',
        );
      }
      if (!llmOk) {
        throw new Error(
          'LLM server could not be started. ' +
          'Check Settings > Local Meeting Transcriber.',
        );
      }

      if (signal.aborted) return;

      // Step 1: Transcribe
      this.setStatus({ stage: 'transcribing', elapsed: 0 });
      const transcript = await this.whisperService.transcribe(
        this.selectedFilePath,
        signal,
        (elapsed) => this.setStatus({ stage: 'transcribing', elapsed }),
      );

      if (signal.aborted) return;

      // Step 2: Generate notes
      this.setStatus({ stage: 'summarising' });
      const note = await this.llmService.generateMeetingNotes(
        transcript,
        this.contextText,
        this.noteType,
        signal,
      );

      if (signal.aborted) return;

      // Step 3: Save
      this.setStatus({ stage: 'saving' });
      const notePath = await this.noteWriter.save(note, transcript, this.noteType, audioFilename);

      this.setStatus({ stage: 'done', notePath });

    } catch (err: unknown) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ stage: 'error', message });
      console.error('[Local Meeting Transcriber]', err);
    }
  }
}
