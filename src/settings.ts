import { App, ButtonComponent, Modal, Notice, PluginSettingTab, Setting } from 'obsidian';
import { asError, execSync, fs, os, path } from './desktop';
import type LocalMeetingTranscriberPlugin from './main';
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT } from './types';

const LLM_PRESETS: Record<string, { url: string; command: string }> = {
  ollama: { url: 'http://127.0.0.1:11434', command: 'ollama serve' },
  'lm-studio': { url: 'http://127.0.0.1:1234', command: 'open -a LM\\ Studio' },
  'llama-cpp': { url: 'http://127.0.0.1:8080', command: 'llama-server -m model.gguf --port 8080' },
  vmlx: { url: 'http://127.0.0.1:8000', command: 'vmlx-serve serve /path/to/model --port 8000' },
  'mlx-lm': { url: 'http://127.0.0.1:8000', command: 'mlx_lm.server --model ~/models/llama --port 8000' },
  openai: { url: 'https://api.openai.com', command: '' },
};

export class LocalMeetingTranscriberSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LocalMeetingTranscriberPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderWhisperSection(containerEl);
    this.renderFfmpegSection(containerEl);
    this.renderLLMSection(containerEl);
    this.renderPromptSection(containerEl);
    this.renderOutputSection(containerEl);
    this.renderActionsSection(containerEl);
  }

  private renderWhisperSection(el: HTMLElement): void {
    new Setting(el)
      .setName('Speech-to-text (whisper.cpp)')
      .setHeading();

    new Setting(el)
      .setName('Whisper-cli binary path')
      .setDesc('Full path to the whisper-cli binary. Leave empty to auto-detect from common install locations.')
      .addText((text) =>
        text
          .setPlaceholder('/opt/homebrew/bin/whisper-cli')
          .setValue(this.plugin.settings.whisperCliPath)
          .onChange((value) => {
            this.plugin.settings.whisperCliPath = value;
            this.persistSettings();
          }),
      );

    new Setting(el)
      .setName('Whisper model path')
      .setDesc('Path to a GGML model file (.bin). Download one from the whisper.cpp model repository.')
      .addText((text) =>
        text
          .setPlaceholder('~/.whisper-models/ggml-base.en.bin')
          .setValue(this.plugin.settings.whisperModelPath)
          .onChange((value) => {
            this.plugin.settings.whisperModelPath = value;
            this.persistSettings();
          }),
      );

    new Setting(el)
      .setName('Default language')
      .setDesc("Language code such as en, zh, fr, or de. Use 'auto' for auto-detection.")
      .addText((text) =>
        text
          .setPlaceholder('en')
          .setValue(this.plugin.settings.defaultLanguage)
          .onChange((value) => {
            this.plugin.settings.defaultLanguage = value;
            this.persistSettings();
          }),
      );

    new Setting(el)
      .setName('Whisper server URL')
      .setDesc('URL of a running whisper-server instance used for connectivity checks.')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:8178')
          .setValue(this.plugin.settings.whisperServerUrl)
          .onChange((value) => {
            this.plugin.settings.whisperServerUrl = value;
            this.persistSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Test')
          .onClick(() => {
            void this.testServer(button, () => this.plugin.whisperManager.ping());
          }),
      );

    new Setting(el)
      .setName('Auto-start whisper server')
      .setDesc('Automatically run the configured start command when the plugin loads.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.whisperAutoStart)
          .onChange((value) => {
            this.plugin.settings.whisperAutoStart = value;
            this.persistSettings();
          }),
      );

    new Setting(el)
      .setName('Whisper server start command')
      .setDesc('Shell command to start whisper-server. Leave empty if you start it yourself.')
      .addText((text) =>
        text
          .setPlaceholder('whisper-server --model ~/.whisper-models/ggml-base.en.bin --port 8178')
          .setValue(this.plugin.settings.whisperStartCommand)
          .onChange((value) => {
            this.plugin.settings.whisperStartCommand = value;
            this.persistSettings();
          }),
      );
  }

  private renderFfmpegSection(el: HTMLElement): void {
    new Setting(el)
      .setName('Audio conversion (FFmpeg)')
      .setHeading();

    new Setting(el)
      .setName('FFmpeg path')
      .setDesc('Path to the FFmpeg binary. Leave empty to auto-detect it from common install locations.')
      .addText((text) =>
        text
          .setPlaceholder('(auto-detect)')
          .setValue(this.plugin.settings.ffmpegPath)
          .onChange((value) => {
            this.plugin.settings.ffmpegPath = value;
            this.persistSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Test FFmpeg')
          .onClick(() => {
            this.testFfmpeg(button);
          }),
      );
  }

  private renderLLMSection(el: HTMLElement): void {
    new Setting(el)
      .setName('LLM server')
      .setDesc('Used for note generation.')
      .setHeading();

    el.createEl('p', {
      text: 'Any OpenAI-compatible server works: Ollama, llama.cpp, vmlx-serve, mlx_lm.server, LM Studio, or remote APIs.',
      cls: 'setting-item-description',
    });

    new Setting(el)
      .setName('Backend preset')
      .setDesc('Pre-fill the API URL and suggested local command for a common backend.')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Pick a preset…');
        Object.keys(LLM_PRESETS).forEach((key) => dropdown.addOption(key, key));
        dropdown.onChange((value) => {
          if (!value) {
            return;
          }

          const preset = LLM_PRESETS[value];
          this.plugin.settings.llmUrl = preset.url;
          this.plugin.settings.llmStartCommand = preset.command;
          this.persistSettingsAndRefresh();
        });
      });

    new Setting(el)
      .setName('LLM server URL')
      .setDesc('Base URL of the OpenAI-compatible API.')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:11434')
          .setValue(this.plugin.settings.llmUrl)
          .onChange((value) => {
            this.plugin.settings.llmUrl = value.replace(/\/$/, '');
            this.persistSettings();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText('Test')
          .onClick(() => {
            void this.testServer(button, () => this.plugin.llmManager.ping());
          }),
      );

    new Setting(el)
      .setName('Model name')
      .setDesc('Model ID sent in the API request, for example llama3 or gpt-4o.')
      .addText((text) =>
        text
          .setPlaceholder('llama3')
          .setValue(this.plugin.settings.llmModel)
          .onChange((value) => {
            this.plugin.settings.llmModel = value;
            this.persistSettings();
          }),
      );

    new Setting(el)
      .setName('API key')
      .setDesc('Bearer token. Leave empty for local servers.')
      .addText((text) => {
        text
          .setPlaceholder('(optional)')
          .setValue(this.plugin.settings.llmApiKey)
          .onChange((value) => {
            this.plugin.settings.llmApiKey = value;
            this.persistSettings();
          });
        text.inputEl.type = 'password';
      });

    new Setting(el)
      .setName('Auto-start LLM server')
      .setDesc('Automatically run the configured start command when the plugin loads.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.llmAutoStart)
          .onChange((value) => {
            this.plugin.settings.llmAutoStart = value;
            this.persistSettings();
          }),
      );

    new Setting(el)
      .setName('LLM server start command')
      .setDesc('Shell command to start your local LLM server.')
      .addText((text) =>
        text
          .setPlaceholder('ollama serve')
          .setValue(this.plugin.settings.llmStartCommand)
          .onChange((value) => {
            this.plugin.settings.llmStartCommand = value;
            this.persistSettings();
          }),
      );
  }

  private renderPromptSection(el: HTMLElement): void {
    new Setting(el)
      .setName('Prompt')
      .setHeading();

    new Setting(el)
      .setName('System prompt')
      .setDesc('The system prompt sent to the LLM. It must instruct the model to return JSON with the expected fields.')
      .addTextArea((textarea) => {
        textarea
          .setValue(this.plugin.settings.systemPrompt)
          .onChange((value) => {
            this.plugin.settings.systemPrompt = value;
            this.persistSettings();
          });
        textarea.inputEl.rows = 14;
        textarea.inputEl.addClass('mt-system-prompt-input');
      })
      .addButton((button) =>
        button
          .setButtonText('Reset to default')
          .setWarning()
          .onClick(() => {
            this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
            this.persistSettingsAndRefresh();
          }),
      );

    new Setting(el)
      .setName('Speaker / context hint')
      .setDesc('Injected into every request as extra context for recurring meetings or known participants.')
      .addText((text) =>
        text
          .setPlaceholder('e.g. Alice (PM), Bob (engineering lead)')
          .setValue(this.plugin.settings.speakerHint)
          .onChange((value) => {
            this.plugin.settings.speakerHint = value;
            this.persistSettings();
          }),
      );
  }

  private renderOutputSection(el: HTMLElement): void {
    new Setting(el)
      .setName('Output')
      .setHeading();

    new Setting(el)
      .setName('Meetings folder')
      .setDesc('Vault-relative folder where notes are saved. The plugin creates it if needed.')
      .addText((text) =>
        text
          .setPlaceholder('Meetings')
          .setValue(this.plugin.settings.meetingsFolder)
          .onChange((value) => {
            this.plugin.settings.meetingsFolder = value;
            this.persistSettings();
          }),
      );

    new Setting(el)
      .setName('Include raw transcript')
      .setDesc('Append the full whisper transcript to the note inside a collapsible details block.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeRawTranscript)
          .onChange((value) => {
            this.plugin.settings.includeRawTranscript = value;
            this.persistSettings();
          }),
      );
  }

  private renderActionsSection(el: HTMLElement): void {
    new Setting(el)
      .setName('Actions')
      .setHeading();

    new Setting(el)
      .setName('Start whisper server')
      .setDesc('Run the configured whisper start command now.')
      .addButton((button) =>
        button
          .setButtonText('Start whisper server')
          .onClick(() => {
            void this.startManagedServer(button, () => this.plugin.whisperManager.startIfNeeded(), 'Start whisper server');
          }),
      );

    new Setting(el)
      .setName('Start LLM server')
      .setDesc('Run the configured LLM start command now.')
      .addButton((button) =>
        button
          .setButtonText('Start LLM server')
          .onClick(() => {
            void this.startManagedServer(button, () => this.plugin.llmManager.startIfNeeded(), 'Start LLM server');
          }),
      );

    new Setting(el)
      .setName('Check server status')
      .setDesc('Ping both servers and show their current connectivity.')
      .addButton((button) =>
        button
          .setButtonText('Check status')
          .onClick(() => {
            void this.checkServerStatus(button);
          }),
      );

    new Setting(el)
      .setName('Reset all settings')
      .setDesc('Restore all settings to their defaults.')
      .addButton((button) =>
        button
          .setButtonText('Reset to defaults')
          .setWarning()
          .onClick(() => {
            void this.resetAllSettings();
          }),
      );
  }

  private persistSettings(): void {
    this.runTask(async () => {
      await this.plugin.saveSettings();
    }, 'Could not save settings');
  }

  private persistSettingsAndRefresh(): void {
    this.runTask(async () => {
      await this.plugin.saveSettings();
      this.display();
    }, 'Could not save settings');
  }

  private runTask(task: () => Promise<void>, failurePrefix: string): void {
    void task().catch((error) => {
      new Notice(`Local Meeting Transcriber: ${failurePrefix} — ${asError(error).message}`, 8000);
    });
  }

  private async testServer(button: ButtonComponent, ping: () => Promise<boolean>): Promise<void> {
    const ok = await ping();
    button.setButtonText(ok ? 'Ready' : 'Offline');
    window.setTimeout(() => button.setButtonText('Test'), 3000);
  }

  private testFfmpeg(button: ButtonComponent): void {
    const ffmpegPath = this.resolveFfmpegForTest();
    if (!ffmpegPath) {
      button.setButtonText('Not found');
      window.setTimeout(() => button.setButtonText('Test FFmpeg'), 3000);
      return;
    }

    try {
      const version = execSync(`"${ffmpegPath}" -version 2>&1`, { timeout: 3000 })
        .toString()
        .split('\n')[0];
      button.setButtonText(version.slice(0, 40));
    } catch {
      button.setButtonText('Error');
    }

    window.setTimeout(() => button.setButtonText('Test FFmpeg'), 4000);
  }

  private async startManagedServer(
    button: ButtonComponent,
    start: () => Promise<boolean>,
    resetLabel: string,
  ): Promise<void> {
    button.setButtonText('Starting…');
    button.setDisabled(true);

    try {
      const ok = await start();
      button.setButtonText(ok ? 'Ready' : 'Failed');
    } finally {
      button.setDisabled(false);
      window.setTimeout(() => button.setButtonText(resetLabel), 4000);
    }
  }

  private async checkServerStatus(button: ButtonComponent): Promise<void> {
    button.setButtonText('Checking…');
    const [whisperOk, llmOk] = await Promise.all([
      this.plugin.whisperManager.ping(),
      this.plugin.llmManager.ping(),
    ]);
    button.setButtonText(`Whisper: ${whisperOk ? 'ready' : 'offline'} | LLM: ${llmOk ? 'ready' : 'offline'}`);
    window.setTimeout(() => button.setButtonText('Check status'), 5000);
  }

  private async resetAllSettings(): Promise<void> {
    const confirmed = await new ResetSettingsModal(this.app).openAndWait();
    if (!confirmed) {
      return;
    }

    Object.assign(this.plugin.settings, DEFAULT_SETTINGS);
    await this.plugin.saveSettings();
    this.display();
  }

  private resolveFfmpegForTest(): string | null {
    const settingPath = this.plugin.settings.ffmpegPath.trim();
    if (settingPath) {
      const resolved = settingPath.startsWith('~')
        ? path.join(os.homedir(), settingPath.slice(1))
        : settingPath;
      return fs.existsSync(resolved) ? resolved : null;
    }

    const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    try {
      const result = execSync('which ffmpeg 2>/dev/null', { timeout: 2000 }).toString().trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      return null;
    }

    return null;
  }
}

class ResetSettingsModal extends Modal {
  private resolvePromise: ((value: boolean) => void) | null = null;
  private settled = false;

  openAndWait(): Promise<boolean> {
    this.open();
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Reset settings?' });
    contentEl.createEl('p', {
      text: 'Restore all plugin settings to their defaults. This cannot be undone.',
    });

    const actions = contentEl.createDiv('mt-actions');
    const cancelButton = actions.createEl('button', { text: 'Cancel', cls: 'mt-btn' });
    cancelButton.addEventListener('click', () => this.closeWithResult(false));

    const confirmButton = actions.createEl('button', {
      text: 'Reset settings',
      cls: 'mt-btn mt-btn--primary',
    });
    confirmButton.addEventListener('click', () => this.closeWithResult(true));
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(false);
  }

  private finish(result: boolean): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.resolvePromise?.(result);
    this.resolvePromise = null;
  }

  private closeWithResult(result: boolean): void {
    this.finish(result);
    this.close();
  }
}
