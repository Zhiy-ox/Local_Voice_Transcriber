import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import { asError, path, requireDialogModule } from './desktop';
import type { WhisperService } from './WhisperService';
import type { LLMService } from './LLMService';
import type { ServerManager } from './ServerManager';
import type { NoteWriter } from './NoteWriter';
import type { NoteType, PipelineStatus } from './types';

interface FileWithPath extends File {
  path?: string;
}

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
    contentEl.createEl('h2', { text: 'Transcribe meeting recording' });

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

  private renderFileZone(parent: HTMLElement): void {
    this.fileZoneEl = parent.createDiv('mt-drop-zone');
    this.fileZoneEl.setText('Drop audio file here, or click to browse');
    this.fileZoneEl.addEventListener('click', () => {
      void this.handleBrowseClick();
    });

    this.fileZoneEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.fileZoneEl.addClass('mt-drop-zone--active');
    });

    this.fileZoneEl.addEventListener('dragleave', () => {
      this.fileZoneEl.removeClass('mt-drop-zone--active');
    });

    this.fileZoneEl.addEventListener('drop', (event) => {
      event.preventDefault();
      this.fileZoneEl.removeClass('mt-drop-zone--active');
      const file = event.dataTransfer?.files[0] as FileWithPath | undefined;
      if (file?.path) {
        this.selectFile(file.path);
      }
    });

    this.fileNameEl = parent.createDiv('mt-filename mt-hidden');
  }

  private async handleBrowseClick(): Promise<void> {
    const filePath = await this.openFilePicker();
    if (filePath) {
      this.selectFile(filePath);
    }
  }

  private selectFile(filePath: string): void {
    this.selectedFilePath = filePath;
    this.fileNameEl.removeClass('mt-hidden');
    this.fileNameEl.setText(`Selected: ${path.basename(filePath)}`);
    this.fileZoneEl.addClass('mt-drop-zone--selected');
    this.updateStartButton();
  }

  private async openFilePicker(): Promise<string | null> {
    const filters = [
      { name: 'Audio files', extensions: ['m4a', 'mp3', 'wav', 'ogg', 'flac', 'mp4', 'webm', 'aac'] },
      { name: 'All files', extensions: ['*'] },
    ];

    try {
      const result = await requireDialogModule().dialog.showOpenDialog({
        properties: ['openFile'],
        filters,
      });

      if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
      }
    } catch {
      return this.htmlFilePicker();
    }

    return null;
  }

  private htmlFilePicker(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.m4a,.mp3,.wav,.ogg,.flac,.mp4,.webm,.aac';
      input.onchange = () => {
        const file = input.files?.[0] as FileWithPath | undefined;
        resolve(file?.path ?? null);
        input.remove();
      };
      input.click();
    });
  }

  private renderOptions(parent: HTMLElement): void {
    this.optionsEl = parent.createDiv('mt-options');

    new Setting(this.optionsEl)
      .setName('Context and participants')
      .setDesc('Names, roles, or topics. Helps the model identify speakers and tag correctly.')
      .addText((text) =>
        text
          .setPlaceholder('Add names, roles, or topics')
          .onChange((value) => {
            this.contextText = value;
          }),
      );

    new Setting(this.optionsEl)
      .setName('Meeting type')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            general: 'General meeting',
            'research-meeting': 'Research meeting',
            supervision: 'Supervision / 1-on-1',
            'conference-call': 'Conference call',
          })
          .setValue(this.noteType)
          .onChange((value) => {
            this.noteType = value as NoteType;
          }),
      );
  }

  private renderProgress(parent: HTMLElement): void {
    this.progressEl = parent.createDiv('mt-progress mt-hidden');
  }

  private setStatus(status: PipelineStatus): void {
    this.progressEl.empty();

    if (status.stage === 'idle') {
      this.progressEl.addClass('mt-hidden');
      return;
    }

    this.progressEl.removeClass('mt-hidden');

    if (status.stage === 'done') {
      const noteName = status.notePath.split('/').pop() ?? status.notePath;
      this.progressEl.createEl('p', {
        cls: 'mt-status mt-status--done',
        text: `Note saved: ${noteName}`,
      });

      const link = this.progressEl.createEl('a', { text: 'Open note', cls: 'mt-link' });
      link.addEventListener('click', () => {
        void this.openSavedNote(status.notePath);
      });

      this.cancelBtn.addClass('mt-hidden');
      this.startBtn.disabled = false;
      this.startBtn.textContent = 'Transcribe another';
      return;
    }

    if (status.stage === 'error') {
      this.progressEl.createEl('p', {
        cls: 'mt-status mt-status--error',
        text: status.message,
      });
      this.cancelBtn.addClass('mt-hidden');
      this.startBtn.disabled = false;
      this.startBtn.textContent = 'Retry';
      return;
    }

    let message = '';
    switch (status.stage) {
      case 'starting-servers':
        message = 'Starting servers…';
        break;
      case 'transcribing':
        message = `Transcribing audio (${status.elapsed}s)…`;
        break;
      case 'summarising':
        message = 'Generating meeting notes…';
        break;
      case 'saving':
        message = 'Saving note to vault…';
        break;
    }

    this.progressEl.createEl('p', { cls: 'mt-status', text: message });

    const stages: PipelineStatus['stage'][] = ['starting-servers', 'transcribing', 'summarising', 'saving'];
    const stageLabels: Record<string, string> = {
      'starting-servers': 'Servers',
      transcribing: 'Transcribing',
      summarising: 'Summarising',
      saving: 'Saving',
    };

    const dotsEl = this.progressEl.createDiv('mt-stages');
    stages.forEach((stage) => {
      const dot = dotsEl.createSpan({ cls: 'mt-stage-dot' });
      dot.setText(stageLabels[stage] ?? stage);

      if (stage === status.stage) {
        dot.addClass('mt-stage-dot--active');
      } else if (stages.indexOf(stage) < stages.indexOf(status.stage)) {
        dot.addClass('mt-stage-dot--done');
      }
    });
  }

  private async openSavedNote(notePath: string): Promise<void> {
    const file: TFile | null = this.app.vault.getFileByPath(notePath);
    if (!file) {
      return;
    }

    await this.app.workspace.getLeaf().openFile(file);
    this.close();
  }

  private renderActions(parent: HTMLElement): void {
    const row = parent.createDiv('mt-actions');

    this.cancelBtn = row.createEl('button', { text: 'Cancel', cls: 'mt-btn mt-hidden' });
    this.cancelBtn.addEventListener('click', () => {
      this.abortController?.abort();
      this.cancelBtn.addClass('mt-hidden');
      this.startBtn.disabled = false;
      this.startBtn.textContent = 'Start pipeline';
      this.setStatus({ stage: 'idle' });
      new Notice('Canceled.');
    });

    this.startBtn = row.createEl('button', {
      text: 'Start pipeline',
      cls: 'mt-btn mt-btn--primary',
    });
    this.startBtn.disabled = true;
    this.startBtn.addEventListener('click', () => {
      void this.runPipeline();
    });
  }

  private updateStartButton(): void {
    this.startBtn.disabled = !this.selectedFilePath;
  }

  private async runPipeline(): Promise<void> {
    if (!this.selectedFilePath) {
      return;
    }

    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.startBtn.disabled = true;
    this.startBtn.textContent = 'Running…';
    this.cancelBtn.removeClass('mt-hidden');

    const audioFilename = path.basename(this.selectedFilePath);

    try {
      this.setStatus({ stage: 'starting-servers' });
      const [whisperOk, llmOk] = await Promise.all([
        this.whisperManager.startIfNeeded(),
        this.llmManager.startIfNeeded(),
      ]);

      if (!whisperOk) {
        throw new Error('Whisper server could not be started. Check the plugin settings.');
      }
      if (!llmOk) {
        throw new Error('LLM server could not be started. Check the plugin settings.');
      }
      if (signal.aborted) {
        return;
      }

      this.setStatus({ stage: 'transcribing', elapsed: 0 });
      const transcript = await this.whisperService.transcribe(
        this.selectedFilePath,
        signal,
        (elapsed) => {
          this.setStatus({ stage: 'transcribing', elapsed });
        },
      );

      if (signal.aborted) {
        return;
      }

      this.setStatus({ stage: 'summarising' });
      const note = await this.llmService.generateMeetingNotes(
        transcript,
        this.contextText,
        this.noteType,
        signal,
      );

      if (signal.aborted) {
        return;
      }

      this.setStatus({ stage: 'saving' });
      const notePath = await this.noteWriter.save(note, transcript, this.noteType, audioFilename);
      this.setStatus({ stage: 'done', notePath });
    } catch (error: unknown) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return;
      }

      this.setStatus({ stage: 'error', message: asError(error).message });
      console.error('[Local Meeting Transcriber]', error);
    }
  }
}
