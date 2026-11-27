// Generation speed. OpenCode reports a step's output tokens only when the step ends, with
// the time of its first token and of the end of its stream, so the speed of a finished
// step is exact. While a reply streams only its text arrives: the live readout is an
// estimate from the text, at about four characters a token.

import type { TokenUsage } from "./model";

/** Rough characters per token for English text and code. */
export const CHARS_PER_TOKEN = 4;

/** Tokens a second of a finished step, or null without stream timing or output. */
export function stepRate(tokens: TokenUsage, streamMs: number | undefined): number | null {
  const generated = tokens.output + tokens.reasoning;
  if (!streamMs || streamMs <= 0 || generated <= 0) return null;
  return generated / (streamMs / 1000);
}

/**
 * The live estimate for the step that is streaming. It counts from the first streamed
 * text, so the wait for the first token does not lower it, and it goes quiet when no
 * text has arrived for `idleMs` (the model is waiting on a tool, or done).
 */
export class ThroughputMeter {
  private first: number | null = null;
  private last = 0;
  private chars = 0;
  /** The first chunk arrived at `first`: only the text after it took the time measured. */
  private firstChars = 0;

  constructor(private readonly idleMs = 2000) {}

  /** A new step started: count from its own first text. */
  reset(): void {
    this.first = null;
    this.chars = 0;
  }

  add(text: string, now: number): void {
    if (!text) return;
    // After a pause (a tool ran) the next text starts a new measurement.
    if (this.first === null || now - this.last > this.idleMs) {
      this.first = now;
      this.chars = 0;
      this.firstChars = text.length;
    }
    this.chars += text.length;
    this.last = now;
  }

  /** Estimated tokens a second, or null before there is enough to measure or once streaming stopped. */
  rate(now: number): number | null {
    if (this.first === null || now - this.last > this.idleMs) return null;
    const seconds = (this.last - this.first) / 1000;
    const chars = this.chars - this.firstChars;
    // Under half a second or a few words, the figure would jump about.
    if (seconds < 0.5 || chars < 40) return null;
    return chars / CHARS_PER_TOKEN / seconds;
  }
}

/** "38 tok/s", "1.2k tok/s". */
export function formatRate(rate: number): string {
  return rate >= 1000 ? `${(rate / 1000).toFixed(1)}k tok/s` : `${Math.round(rate)} tok/s`;
}
