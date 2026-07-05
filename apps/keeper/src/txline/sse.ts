/**
 * Minimal SSE frame parsing shared by the live score stream and the
 * historical-scores fetcher (VERIFIED live 2026-07-04: `/api/scores/historical/{id}`
 * returns the SAME SSE-framed text — `data:` / `id:` / `event:` lines separated
 * by blank lines — NOT a JSON array).
 */

export interface SseFrame {
  /** `event:` field (e.g. "heartbeat"); undefined for unnamed frames. */
  event?: string;
  /** `id:` field (the stream sequence id). */
  id?: string;
  /** Joined `data:` payload (usually one JSON object). */
  data: string;
}

/** Parse one raw frame (the text between blank-line separators). */
export function parseSseFrame(frame: string): SseFrame | null {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    // comments (`:`) and `retry:` are ignored.
  }
  if (data.length === 0 && event === undefined) return null;
  return { event, id, data: data.join("\n") };
}

/** Incremental SSE parser for streaming bodies (chunk in, complete frames out). */
export class SseFrameParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const frame = parseSseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Drain any trailing partial frame (end of a finite body). */
  flush(): SseFrame[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const frame = parseSseFrame(rest);
    return frame ? [frame] : [];
  }
}

/** Parse a complete SSE-framed text body (historical endpoint). */
export function parseSseText(text: string): SseFrame[] {
  const parser = new SseFrameParser();
  return [...parser.push(text), ...parser.flush()];
}
