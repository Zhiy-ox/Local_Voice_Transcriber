# Local Meeting Transcriber

An Obsidian plugin that turns meeting recordings into structured notes — entirely on your machine. No cloud, no subscriptions.

**Pipeline:** Audio file → [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (speech-to-text) → Any local or remote LLM (note generation) → Obsidian note

---

## Features

- 🎙️ Transcribe any audio file (m4a, mp3, wav, ogg, flac, mp4, webm, aac)
- 🤖 Compatible with **any OpenAI-compatible LLM server** — local or remote
- 📝 Generates structured notes: title, participants, summary, discussion, action items, decisions
- 🔧 Fully configurable — system prompt, output folder, frontmatter, ffmpeg path
- ⚡ Auto-start your local server from within Obsidian

---

## Privacy and Security

- The plugin is **desktop-only** and uses local system binaries such as `whisper-cli` and `ffmpeg`.
- It reads the audio file you choose and writes the generated note into your vault.
- It can connect to the Whisper health-check URL and the LLM API URL you configure.
- If you point the LLM URL at a **remote** service, your transcript and prompt data are sent to that service.
- It can run **user-configured shell commands** to start local servers, but only if you explicitly enter those commands in settings and trigger them manually or enable auto-start.
- The plugin itself does **not** require an account, does **not** include ads, and does **not** include telemetry.

---

## Requirements

- **Obsidian** desktop (macOS, Windows, Linux)
- **whisper.cpp** for transcription:
  ```bash
  brew install whisper-cpp   # macOS
  ```
  [Build from source](https://github.com/ggerganov/whisper.cpp) for other platforms.

- **A whisper GGML model** (download from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)):
  ```bash
  mkdir -p ~/.whisper-models
  curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
       -o ~/.whisper-models/ggml-base.en.bin
  ```

- **An OpenAI-compatible LLM server** — pick one:

  | Backend | Format | Install |
  |---------|--------|---------|
  | [ollama](https://ollama.com) | GGUF | `brew install ollama` |
  | [llama.cpp](https://github.com/ggerganov/llama.cpp) | GGUF | build from source |
  | [vmlx-serve](https://vmlx.app) | MLX (Apple Silicon) | install vMLX.app |
  | [mlx_lm.server](https://github.com/ml-explore/mlx-examples) | MLX (Apple Silicon) | `pip install mlx-lm` |
  | [LM Studio](https://lmstudio.ai) | GGUF + MLX | download app |
  | OpenAI / Groq / Anthropic proxy | — | set API key in settings |

- **ffmpeg** for m4a/mp4/webm conversion (most common meeting formats):
  ```bash
  brew install ffmpeg   # macOS
  ```
  Leave the ffmpeg path empty in settings to auto-detect.

---

## Installation

### From Obsidian Community Plugins (recommended)
Settings → Community plugins → Browse → search **"Local Meeting Transcriber"** → Install → Enable

### Manual installation
1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/Zhiy-ox/Local_Voice_Transcriber/releases/latest)
2. Place in `.obsidian/plugins/local-meeting-transcriber/` inside your vault
3. Enable in Settings → Community plugins

---

## Quick Start with ollama

1. Install ollama: `brew install ollama`
2. Pull a model: `ollama pull llama3`
3. Configure the plugin:
   - **whisper-cli path:** `/opt/homebrew/bin/whisper-cli`
   - **Whisper model path:** `~/.whisper-models/ggml-base.en.bin`
   - **LLM URL:** `http://127.0.0.1:11434`
   - **Model name:** `llama3`
   - **LLM start command:** `ollama serve`
   - Enable **Auto-start LLM server**
4. Click the microphone icon in the ribbon → drop your audio file → **Start pipeline**

---

## Configuration Reference

### Speech-to-Text

| Setting | Default | Description |
|---------|---------|-------------|
| whisper-cli path | *(auto-detect)* | Path to `whisper-cli`. Auto-detects from `/opt/homebrew/bin` and `/usr/local/bin` |
| Whisper model path | — | Path to a `.bin` GGML model file |
| Default language | `en` | Language code or `auto` for auto-detection |
| Whisper server URL | `http://127.0.0.1:8178` | Used for health checks only |
| Auto-start Whisper | off | Run the start command on plugin load |
| Whisper start command | — | e.g. `whisper-server --model ~/.whisper-models/ggml-base.en.bin` |

### Audio Conversion

| Setting | Default | Description |
|---------|---------|-------------|
| ffmpeg path | *(auto-detect)* | Leave empty to auto-detect. Required for m4a, mp4, webm, aac |

### LLM Server

| Setting | Default | Description |
|---------|---------|-------------|
| LLM URL | `http://127.0.0.1:11434` | Base URL of any OpenAI-compatible server |
| Model name | — | Model ID (e.g. `llama3`, `gpt-4o`, `mistral`) |
| API key | — | Bearer token. Leave empty for local servers |
| Auto-start LLM | off | Run start command on plugin load |
| LLM start command | — | e.g. `ollama serve` or `vmlx-serve serve /path/to/model --port 8000` |

### Prompt

| Setting | Default | Description |
|---------|---------|-------------|
| System prompt | *(built-in)* | Editable. Must instruct the LLM to return JSON with the required fields |
| Speaker hint | — | Injected as context into every request |

### Output

| Setting | Default | Description |
|---------|---------|-------------|
| Meetings folder | `Meetings` | Vault-relative folder where notes are saved |
| Include raw transcript | on | Append collapsible full transcript to the note |

---

## Output Format

Each meeting note is saved as `YYYY-MM-DD Title.md` with:

```markdown
---
tags:
  - meeting
  - [content tags from LLM]
created: 2026-04-20
type: meeting-note
note_type: general
participants:
  - Alice
  - Bob
duration_minutes: 45
audio_file: "recording.m4a"
audio_transcribed: true
---

# Quarterly Planning Session

> [!summary]
> Two-sentence executive summary.

## Discussion

### Topic One
Flowing narrative…

### Topic Two
…

## Action Items

- [ ] Task description [Alice] [by 2026-04-27]

## Decisions

- Decided to adopt new framework by Q3.

---

## Raw Transcript

<details>
<summary>Expand raw transcript</summary>

Full whisper output…

</details>
```

- `type: meeting-note` enables Dataview queries: `FROM "Meetings" WHERE type = "meeting-note"`
- `- [ ]` action items surface in the Tasks plugin
- `<details>` keeps the note clean while preserving the full searchable transcript

---

## Troubleshooting

**whisper-cli not found**
→ Run `brew install whisper-cpp` or set the path explicitly in settings.

**ffmpeg not found**
→ Run `brew install ffmpeg` or set the ffmpeg path in settings.

**LLM server offline**
→ Start your server manually, or set a start command in settings and enable Auto-start.

**"model name not configured"**
→ Set the model name in Settings → LLM Server.

**m4a transcription fails**
→ Ensure ffmpeg is installed. The plugin auto-converts m4a to WAV before passing to whisper.

**LLM returns malformed JSON**
→ The plugin falls back gracefully — the raw response appears in the Discussion field. Try a larger/better model or adjust the system prompt.

**Transcription takes too long**
→ Use a smaller whisper model (ggml-tiny.en or ggml-base.en). The `medium` and `large` models are much slower.

---

## Development

```bash
git clone https://github.com/Zhiy-ox/Local_Voice_Transcriber.git
cd Local_Voice_Transcriber
npm install
npm run dev   # watch mode
npm run build # production build
```

Copy `main.js`, `manifest.json`, `styles.css` to your vault's plugin folder to test.

---

## License

MIT © Zhiyu Xu
