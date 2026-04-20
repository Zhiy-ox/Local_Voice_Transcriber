import { App, TFolder, normalizePath } from 'obsidian';
import type { MeetingTranscriberSettings, MeetingNote, TranscriptionResult, NoteType } from './types';

export class NoteWriter {
  constructor(private app: App, private settings: MeetingTranscriberSettings) {}

  updateSettings(settings: MeetingTranscriberSettings): void {
    this.settings = settings;
  }

  async save(
    note: MeetingNote,
    transcript: TranscriptionResult,
    noteType: NoteType,
    audioFilename: string,
  ): Promise<string> {
    const folder = normalizePath(this.settings.meetingsFolder);
    await this.ensureFolder(folder);

    const today = new Date().toISOString().slice(0, 10);
    const safeTitle = sanitiseFilename(note.title);
    const filename = `${today} ${safeTitle}.md`;
    const filePath = normalizePath(`${folder}/${filename}`);

    const content = this.renderNote(note, transcript, noteType, audioFilename, today);

    // Deduplicate filename if one already exists
    let finalPath = filePath;
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(finalPath)) {
      finalPath = normalizePath(`${folder}/${today} ${safeTitle} (${counter}).md`);
      counter++;
    }

    await this.app.vault.create(finalPath, content);
    return finalPath;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private renderNote(
    note: MeetingNote,
    transcript: TranscriptionResult,
    noteType: NoteType,
    audioFilename: string,
    date: string,
  ): string {
    const durationMinutes = Math.round(transcript.duration / 60);
    const tags = dedupeAndSort([...note.tags, 'meeting']);

    const participantLines = note.participants.length > 0
      ? note.participants.map(p => `  - ${p}`).join('\n')
      : '  - unknown';

    const frontmatter = [
      '---',
      'tags:',
      ...tags.map(t => `  - ${t}`),
      `created: ${date}`,
      'type: meeting-note',
      `note_type: ${noteType}`,
      'participants:',
      participantLines,
      ...(durationMinutes > 0 ? [`duration_minutes: ${durationMinutes}`] : []),
      `audio_file: "${audioFilename}"`,
      'audio_transcribed: true',
      '---',
    ].join('\n');

    const parts: string[] = [frontmatter, ''];

    parts.push(`# ${note.title}`, '');

    if (note.summary) {
      parts.push('> [!summary]');
      parts.push(`> ${note.summary.replace(/\n/g, '\n> ')}`, '');
    }

    if (note.discussion) {
      parts.push('## Discussion', '');
      parts.push(note.discussion, '');
    }

    if (note.action_items.length > 0) {
      parts.push('## Action Items', '');
      parts.push(...note.action_items.map(a => `- [ ] ${a}`), '');
    }

    if (note.decisions.length > 0) {
      parts.push('## Decisions', '');
      parts.push(...note.decisions.map(d => `- ${d}`), '');
    }

    if (this.settings.includeRawTranscript) {
      parts.push('---', '');
      parts.push('## Raw Transcript', '');
      parts.push('<details>');
      parts.push('<summary>Expand raw transcript</summary>', '');
      parts.push(transcript.text || '_No transcript available._', '');
      parts.push('</details>');
    }

    return parts.join('\n');
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.app.vault.createFolder(folderPath);
    } else if (!(existing instanceof TFolder)) {
      throw new Error(`"${folderPath}" exists but is not a folder`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitiseFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function dedupeAndSort(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}
