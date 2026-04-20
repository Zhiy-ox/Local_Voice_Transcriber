import type { MeetingTranscriberSettings, MeetingNote, TranscriptionResult, NoteType } from './types';

const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  general: 'General Meeting',
  'research-meeting': 'Research Meeting',
  supervision: 'Supervision / 1-on-1',
  'conference-call': 'Conference Call',
};

export class LLMService {
  constructor(private settings: MeetingTranscriberSettings) {}

  updateSettings(settings: MeetingTranscriberSettings): void {
    this.settings = settings;
  }

  // ── Health check ───────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.settings.llmApiKey) {
        headers['Authorization'] = `Bearer ${this.settings.llmApiKey}`;
      }
      const res = await fetch(`${this.settings.llmUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Note generation ────────────────────────────────────────────────────────

  async generateMeetingNotes(
    transcript: TranscriptionResult,
    context: string,
    noteType: NoteType,
    signal: AbortSignal,
  ): Promise<MeetingNote> {
    if (!this.settings.llmModel.trim()) {
      throw new Error('LLM model name is not configured. Set it in Settings > Local Meeting Transcriber.');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.settings.llmApiKey) {
      headers['Authorization'] = `Bearer ${this.settings.llmApiKey}`;
    }

    const body = {
      model: this.settings.llmModel,
      messages: [
        { role: 'system', content: this.settings.systemPrompt },
        { role: 'user', content: this.buildUserPrompt(transcript, context, noteType) },
      ],
      temperature: 0.3,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    };

    const res = await fetch(`${this.settings.llmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM returned ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const content: string = json.choices?.[0]?.message?.content ?? '';
    return this.parseNote(content);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildUserPrompt(
    transcript: TranscriptionResult,
    context: string,
    noteType: NoteType,
  ): string {
    const minutes = Math.round(transcript.duration / 60);
    const durationStr = minutes > 0 ? `${minutes} minutes` : 'unknown duration';

    const contextLine = context.trim()
      ? `Meeting context / participants: ${context.trim()}`
      : this.settings.speakerHint
        ? `Speaker hint: ${this.settings.speakerHint}`
        : 'No additional context provided.';

    return `${contextLine}
Note type: ${NOTE_TYPE_LABELS[noteType]}
Audio duration: ${durationStr}

Raw transcript:
---
${transcript.text}
---

Generate structured meeting notes following the JSON schema exactly. Return JSON only.`;
  }

  private parseNote(raw: string): MeetingNote {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    try {
      const obj = JSON.parse(cleaned);
      return {
        title: String(obj.title ?? 'Meeting Note'),
        participants: toStringArray(obj.participants),
        summary: String(obj.summary ?? ''),
        discussion: String(obj.discussion ?? ''),
        action_items: toStringArray(obj.action_items),
        decisions: toStringArray(obj.decisions),
        tags: toStringArray(obj.tags),
      };
    } catch {
      // If JSON parse fails, wrap the raw response so the note is still created
      return {
        title: 'Meeting Note',
        participants: [],
        summary: 'Note generation encountered a formatting issue. See discussion for raw output.',
        discussion: raw,
        action_items: [],
        decisions: [],
        tags: ['meeting'],
      };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map(String);
}
