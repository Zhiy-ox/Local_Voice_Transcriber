import { App, PluginSettingTab, Setting } from 'obsidian';
import type LocalMeetingTranscriberPlugin from './main';
import { DEFAULT_SYSTEM_PROMPT } from './types';

const { execSync } = (window as any).require('child_process') as typeof import('child_process');
const fs = (window as any).require('fs') as typeof import('fs');
const os = (window as any).require('os') as typeof import('os');
const path = (window as any).require('path') as typeof import('path');

// ── LLM backend presets ───────────────────────────────────────────────────────

const LLM_PRESETS: Record<string, { url: string; hint: string }> = {
  'ollama':       { url: 'http://127.0.0.1:11434', hint: 'Start command: ollama serve' },
  'lm-studio':   { url: 'http://127.0.0.1:1234',  hint: 'Start command: open -a LM\\ Studio' },
  'llama-cpp':   { url: 'http://127.0.0.1:8080',  hint: 'Start command: llama-server -m model.gguf --port 8080' },
  'vmlx':        { url: 'http://127.0.0.1:8000',  hint: 'Start command: vmlx-serve serve /path/to/model --port 8000' },
  'mlx-lm':      { url: 'http://127.0.0.1:8000',  hint: 'Start command: mlx_lm.server --model ~/models/llama --port 8000' },
  'openai':      { url: 'https://api.openai.com',  hint: 'Set your API key above' },
};

export class LocalMeetingTranscriberSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: LocalMeetingTranscriberPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Local Meeting Transcriber' });

    this.renderWhisperSection(containerEl);
    this.renderFfmpegSection(containerEl);
    this.renderLLMSection(containerEl);
    this.renderPromptSection(containerEl);
    this.renderOutputSection(containerEl);
    this.renderActionsSection(containerEl);
  }

  // ── Section 1: Speech-to-Text ─────────────────────────────────────────────

  private renderWhisperSection(el: HTMLElement): void {
    el.createEl('h3', { text: '🎙️ Speech-to-Text (whisper.cpp)' });

    new Setting(el)
      .setName('whisper-cli binary path')
      .setDesc('Full path to the whisper-cli binary. Leave empty to auto-detect from /opt/homebrew/bin and /usr/local/bin. Install: brew install whisper-cpp')
      .addText(text =>
        text
          .setPlaceholder('/opt/homebrew/bin/whisper-cli')
          .setValue(this.plugin.settings.whisperCliPath)
          .onChange(async v => {
            this.plugin.settings.whisperCliPath = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Whisper model path')
      .setDesc('Path to a GGML model file (.bin). Download from huggingface.co/ggerganov/whisper.cpp')
      .addText(text =>
        text
          .setPlaceholder('~/.whisper-models/ggml-base.en.bin')
          .setValue(this.plugin.settings.whisperModelPath)
          .onChange(async v => {
            this.plugin.settings.whisperModelPath = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Default language')
      .setDesc("Language code (en, zh, fr, de…) or 'auto' for auto-detection.")
      .addText(text =>
        text
          .setPlaceholder('en')
          .setValue(this.plugin.settings.defaultLanguage)
          .onChange(async v => {
            this.plugin.settings.defaultLanguage = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Whisper server URL')
      .setDesc('URL of a running whisper-server instance (used for connectivity checks only).')
      .addText(text =>
        text
          .setPlaceholder('http://127.0.0.1:8178')
          .setValue(this.plugin.settings.whisperServerUrl)
          .onChange(async v => {
            this.plugin.settings.whisperServerUrl = v;
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn
          .setButtonText('Test')
          .onClick(async () => {
            const ok = await this.plugin.whisperManager.ping();
            btn.setButtonText(ok ? '✓ reachable' : '✗ offline');
            setTimeout(() => btn.setButtonText('Test'), 3000);
          })
      );

    new Setting(el)
      .setName('Auto-start Whisper server')
      .setDesc('Automatically run the start command below when the plugin loads.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.whisperAutoStart)
          .onChange(async v => {
            this.plugin.settings.whisperAutoStart = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Whisper server start command')
      .setDesc('Shell command to start whisper-server (e.g. whisper-server --model ~/.whisper-models/ggml-base.en.bin --port 8178). Leave empty to manage it yourself.')
      .addText(text =>
        text
          .setPlaceholder('whisper-server --model ~/.whisper-models/ggml-base.en.bin --port 8178')
          .setValue(this.plugin.settings.whisperStartCommand)
          .onChange(async v => {
            this.plugin.settings.whisperStartCommand = v;
            await this.plugin.saveSettings();
          })
      );
  }

  // ── Section 2: Audio conversion ───────────────────────────────────────────

  private renderFfmpegSection(el: HTMLElement): void {
    el.createEl('h3', { text: '🔄 Audio Conversion (ffmpeg)' });

    new Setting(el)
      .setName('ffmpeg path')
      .setDesc('Path to the ffmpeg binary. Leave empty to auto-detect. Required for m4a, mp4, webm, aac input. Install: brew install ffmpeg')
      .addText(text =>
        text
          .setPlaceholder('(auto-detect)')
          .setValue(this.plugin.settings.ffmpegPath)
          .onChange(async v => {
            this.plugin.settings.ffmpegPath = v;
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn
          .setButtonText('Test ffmpeg')
          .onClick(() => {
            const ffmpegPath = this.resolveFfmpegForTest();
            if (!ffmpegPath) {
              btn.setButtonText('✗ not found');
              setTimeout(() => btn.setButtonText('Test ffmpeg'), 3000);
              return;
            }
            try {
              const version = execSync(`"${ffmpegPath}" -version 2>&1`, { timeout: 3000 })
                .toString()
                .split('\n')[0];
              btn.setButtonText(`✓ ${version.slice(0, 40)}`);
            } catch {
              btn.setButtonText('✗ error');
            }
            setTimeout(() => btn.setButtonText('Test ffmpeg'), 4000);
          })
      );
  }

  // ── Section 3: LLM server ─────────────────────────────────────────────────

  private renderLLMSection(el: HTMLElement): void {
    el.createEl('h3', { text: '🤖 LLM Server (note generation)' });

    el.createEl('p', {
      text: 'Any OpenAI-compatible server works: ollama, llama.cpp, vmlx-serve, mlx_lm.server, LM Studio, or remote APIs.',
      cls: 'setting-item-description',
    });

    // Preset picker
    new Setting(el)
      .setName('Backend preset')
      .setDesc('Pre-fill URL and hint for a common backend. You can edit after.')
      .addDropdown(dd => {
        dd.addOption('', '— pick a preset —');
        Object.keys(LLM_PRESETS).forEach(k => dd.addOption(k, k));
        dd.onChange(v => {
          if (!v) return;
          const preset = LLM_PRESETS[v];
          this.plugin.settings.llmUrl = preset.url;
          this.plugin.settings.llmStartCommand = preset.hint.replace('Start command: ', '');
          this.plugin.saveSettings().then(() => this.display());
        });
      });

    new Setting(el)
      .setName('LLM server URL')
      .setDesc('Base URL of the OpenAI-compatible API.')
      .addText(text =>
        text
          .setPlaceholder('http://127.0.0.1:11434')
          .setValue(this.plugin.settings.llmUrl)
          .onChange(async v => {
            this.plugin.settings.llmUrl = v.replace(/\/$/, '');
            await this.plugin.saveSettings();
          })
      )
      .addButton(btn =>
        btn
          .setButtonText('Test')
          .onClick(async () => {
            const ok = await this.plugin.llmManager.ping();
            btn.setButtonText(ok ? '✓ reachable' : '✗ offline');
            setTimeout(() => btn.setButtonText('Test'), 3000);
          })
      );

    new Setting(el)
      .setName('Model name')
      .setDesc('Model ID sent in the API request. For ollama: llama3, mistral, etc. For OpenAI: gpt-4o, etc.')
      .addText(text =>
        text
          .setPlaceholder('llama3')
          .setValue(this.plugin.settings.llmModel)
          .onChange(async v => {
            this.plugin.settings.llmModel = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('API key')
      .setDesc('Bearer token. Leave empty for local servers. Required for OpenAI, Groq, Anthropic proxies, etc.')
      .addText(text => {
        text
          .setPlaceholder('(optional)')
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async v => {
            this.plugin.settings.llmApiKey = v;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = 'password';
      });

    new Setting(el)
      .setName('Auto-start LLM server')
      .setDesc('Run the start command below when the plugin loads.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.llmAutoStart)
          .onChange(async v => {
            this.plugin.settings.llmAutoStart = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('LLM server start command')
      .setDesc('Shell command to start your local LLM server. The plugin waits up to 5 minutes for it to become reachable.')
      .addText(text =>
        text
          .setPlaceholder('ollama serve')
          .setValue(this.plugin.settings.llmStartCommand)
          .onChange(async v => {
            this.plugin.settings.llmStartCommand = v;
            await this.plugin.saveSettings();
          })
      );
  }

  // ── Section 4: Prompt ─────────────────────────────────────────────────────

  private renderPromptSection(el: HTMLElement): void {
    el.createEl('h3', { text: '📝 Prompt' });

    new Setting(el)
      .setName('System prompt')
      .setDesc('The system prompt sent to the LLM. Must instruct it to return JSON with fields: title, participants, summary, discussion, action_items, decisions, tags.')
      .addTextArea(ta => {
        ta.setValue(this.plugin.settings.systemPrompt)
          .onChange(async v => {
            this.plugin.settings.systemPrompt = v;
            await this.plugin.saveSettings();
          });
        ta.inputEl.rows = 14;
        ta.inputEl.style.width = '100%';
        ta.inputEl.style.fontFamily = 'monospace';
        ta.inputEl.style.fontSize = '0.82em';
      })
      .addButton(btn =>
        btn
          .setButtonText('Reset to default')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(el)
      .setName('Speaker / context hint')
      .setDesc('Injected into every request as additional context. Useful for recurring meetings where participants are always the same.')
      .addText(text =>
        text
          .setPlaceholder('e.g. Alice (PM), Bob (engineering lead)')
          .setValue(this.plugin.settings.speakerHint)
          .onChange(async v => {
            this.plugin.settings.speakerHint = v;
            await this.plugin.saveSettings();
          })
      );
  }

  // ── Section 5: Output ─────────────────────────────────────────────────────

  private renderOutputSection(el: HTMLElement): void {
    el.createEl('h3', { text: '📁 Output' });

    new Setting(el)
      .setName('Meetings folder')
      .setDesc('Vault-relative folder where notes are saved. Created automatically if it does not exist.')
      .addText(text =>
        text
          .setPlaceholder('Meetings')
          .setValue(this.plugin.settings.meetingsFolder)
          .onChange(async v => {
            this.plugin.settings.meetingsFolder = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(el)
      .setName('Include raw transcript')
      .setDesc('Append the full whisper transcript to the note inside a collapsible HTML details block.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.includeRawTranscript)
          .onChange(async v => {
            this.plugin.settings.includeRawTranscript = v;
            await this.plugin.saveSettings();
          })
      );
  }

  // ── Section 6: Actions ────────────────────────────────────────────────────

  private renderActionsSection(el: HTMLElement): void {
    el.createEl('h3', { text: '⚡ Actions' });

    new Setting(el)
      .setName('Start Whisper server')
      .setDesc('Run the configured Whisper start command now.')
      .addButton(btn =>
        btn
          .setButtonText('Start Whisper server')
          .onClick(async () => {
            btn.setButtonText('Starting…');
            btn.setDisabled(true);
            const ok = await this.plugin.whisperManager.startIfNeeded();
            btn.setButtonText(ok ? '✓ Ready' : '✗ Failed');
            btn.setDisabled(false);
            setTimeout(() => btn.setButtonText('Start Whisper server'), 4000);
          })
      );

    new Setting(el)
      .setName('Start LLM server')
      .setDesc('Run the configured LLM start command now.')
      .addButton(btn =>
        btn
          .setButtonText('Start LLM server')
          .onClick(async () => {
            btn.setButtonText('Starting…');
            btn.setDisabled(true);
            const ok = await this.plugin.llmManager.startIfNeeded();
            btn.setButtonText(ok ? '✓ Ready' : '✗ Failed');
            btn.setDisabled(false);
            setTimeout(() => btn.setButtonText('Start LLM server'), 4000);
          })
      );

    new Setting(el)
      .setName('Check server status')
      .setDesc('Ping both servers and show current connectivity.')
      .addButton(btn =>
        btn
          .setButtonText('Check status')
          .onClick(async () => {
            btn.setButtonText('Checking…');
            const [whisperOk, llmOk] = await Promise.all([
              this.plugin.whisperManager.ping(),
              this.plugin.llmManager.ping(),
            ]);
            btn.setButtonText(
              `Whisper: ${whisperOk ? '✓' : '✗'}  LLM: ${llmOk ? '✓' : '✗'}`,
            );
            setTimeout(() => btn.setButtonText('Check status'), 5000);
          })
      );

    new Setting(el)
      .setName('Reset all settings')
      .setDesc('Restore all settings to their defaults. This cannot be undone.')
      .addButton(btn =>
        btn
          .setButtonText('Reset to defaults')
          .setWarning()
          .onClick(async () => {
            if (!confirm('Reset all Local Meeting Transcriber settings to defaults?')) return;
            const { DEFAULT_SETTINGS } = await import('./types');
            Object.assign(this.plugin.settings, DEFAULT_SETTINGS);
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private resolveFfmpegForTest(): string | null {
    const settingPath = this.plugin.settings.ffmpegPath.trim();
    if (settingPath) {
      const resolved = settingPath.startsWith('~')
        ? path.join(os.homedir(), settingPath.slice(1))
        : settingPath;
      return fs.existsSync(resolved) ? resolved : null;
    }
    const CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    for (const c of CANDIDATES) {
      if (fs.existsSync(c)) return c;
    }
    try {
      const result = execSync('which ffmpeg 2>/dev/null', { timeout: 2000 }).toString().trim();
      if (result && fs.existsSync(result)) return result;
    } catch { /* noop */ }
    return null;
  }
}
