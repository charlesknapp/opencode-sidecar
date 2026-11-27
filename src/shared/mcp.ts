// MCP servers added from Sidecar for one OpenCode run (`PUT /api/experimental/mcp/{name}`),
// never written to OpenCode's config: what the user types becomes a local command or a
// remote URL.

import type { McpConfig } from "./model";

/** A server name: letters, digits, `.`, `_` and `-` (OpenCode names its tools after it). */
export const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Splits a command line into arguments the way a shell would for simple cases: spaces
 * separate them, and "double" or 'single' quotes keep spaces (Windows paths stay as typed:
 * a backslash is not an escape).
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** What to add for `target`: an http(s) URL is a remote server, anything else a command to run. */
export function parseMcpTarget(
  target: string,
): { ok: true; config: McpConfig } | { ok: false; error: string } {
  const t = target.trim();
  if (!t) return { ok: false, error: "Type a command to run, or the server's URL." };
  if (/^https?:\/\//i.test(t)) {
    try {
      new URL(t);
    } catch {
      return { ok: false, error: "That URL is not valid." };
    }
    return { ok: true, config: { type: "remote", url: t } };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t))
    return { ok: false, error: "A URL must start with http:// or https://." };
  const command = splitCommand(t);
  if (!command.length || !command[0])
    return { ok: false, error: "Type a command to run, or the server's URL." };
  return { ok: true, config: { type: "local", command } };
}

/** Why a name cannot be used, or null. */
export function mcpNameError(name: string, taken: readonly string[]): string | null {
  if (!name.trim()) return "Give the server a name.";
  if (!MCP_NAME.test(name)) return "Use letters, digits, dots, dashes and underscores (up to 64).";
  if (taken.includes(name)) return `A server named “${name}” already exists.`;
  return null;
}
