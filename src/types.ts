// ── Settings ──────────────────────────────────────────────────────────────────

export interface MeetingTranscriberSettings {
  // Whisper
  whisperCliPath: string;       // path to whisper-cli binary
  whisperModelPath: string;     // path to .bin GGML whisper model
  whisperServerUrl: string;     // URL of running whisper-server (ping only)
  whisperAutoStart: boolean;    // spawn whisperStartCommand on plugin load
  whisperStartCommand: string;  // e.g. 'whisper-server --model ~/path/to/ggml-base.en.bin'
  defaultLanguage: string;      // 'en', 'zh', 'auto', etc.

  // ffmpeg (for m4a/mp4/webm → WAV conversion)
  ffmpegPath: string;           // '' = auto-detect

  // LLM — any OpenAI-compatible backend
  llmUrl: string;               // e.g. 'http://127.0.0.1:11434' (ollama)
  llmModel: string;             // model id sent in API request body
  llmApiKey: string;            // '' for local servers; Bearer token for remote APIs
  llmAutoStart: boolean;        // run llmStartCommand before first request
  llmStartCommand: string;      // e.g. 'ollama serve' or 'vmlx-serve serve /path --port 8000'

  // Prompt
  systemPrompt: string;         // editable; defaults to DEFAULT_SYSTEM_PROMPT
  speakerHint: string;          // injected as context into every request

  // Output
  meetingsFolder: string;       // vault-relative folder, e.g. 'Meetings'
  includeRawTranscript: boolean; // append collapsible raw transcript to note
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `You are a professional meeting scribe. Convert raw speech transcripts into structured, accurate meeting notes.

You MUST respond with a single valid JSON object only — no markdown fences, no explanation, no preamble.

The JSON schema is exactly:
{
  "title": "string — concise meeting title (4-8 words, sentence case, no date prefix)",
  "participants": ["array of participant names or roles mentioned, e.g. 'Alice', 'team lead', 'client'"],
  "summary": "string — 2-4 sentence executive summary of the meeting purpose and key outcome",
  "discussion": "string — detailed markdown narrative of key discussion points. Use ## subheadings for distinct topics. For technical content, use $...$  for inline math where appropriate. Write flowing prose, not bullet points.",
  "action_items": ["array of strings — each a concrete, specific task. Format: 'Task description [Owner if mentioned] [by Date if mentioned]'"],
  "decisions": ["array of strings — each a decision that was made, stated declaratively"],
  "tags": ["array of 3-6 lowercase hyphenated tags relevant to the content, always include 'meeting'"]
}

Guidelines:
- Preserve all technical terminology, product names, and proper nouns exactly as spoken
- Mark unclear or inaudible audio as [inaudible]
- Do not infer or fabricate anything not present in the transcript
- If no decisions or action items are present, return empty arrays
- Always include the tag "meeting" in the tags array`;

export const DEFAULT_SETTINGS: MeetingTranscriberSettings = {
  whisperCliPath: '',
  whisperModelPath: '',
  whisperServerUrl: 'http://127.0.0.1:8178',
  whisperAutoStart: false,
  whisperStartCommand: '',
  defaultLanguage: 'en',

  ffmpegPath: '',

  llmUrl: 'http://127.0.0.1:11434',
  llmModel: '',
  llmApiKey: '',
  llmAutoStart: false,
  llmStartCommand: '',

  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  speakerHint: '',

  meetingsFolder: 'Meetings',
  includeRawTranscript: true,
};

// ── Domain types ──────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  segments: { start: number; end: number; text: string }[];
  duration: number;
}

export interface MeetingNote {
  title: string;
  participants: string[];
  summary: string;
  discussion: string;
  action_items: string[];
  decisions: string[];
  tags: string[];
}

export type NoteType = 'general' | 'research-meeting' | 'supervision' | 'conference-call';

export type PipelineStatus =
  | { stage: 'idle' }
  | { stage: 'starting-servers' }
  | { stage: 'transcribing'; elapsed: number }
  | { stage: 'summarising' }
  | { stage: 'saving' }
  | { stage: 'done'; notePath: string }
  | { stage: 'error'; message: string };
