// Agent names, checked the same way in the agent form and by the host before it writes a file.

/** Windows cannot have files with these names, whatever the extension. */
export const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Checks a new agent's name, which is its file name and the id OpenCode lists (and `@name`
 * in a prompt). OpenCode takes any file name; Sidecar keeps to letters, digits, `-` and
 * `_` so the id works in mentions and on every file system. `taken` are the ids in use.
 */
export function validateAgentName(name: string, taken: readonly string[] = []): string | null {
  if (!name) return "Give the agent a name.";
  if (name.length > 64) return "Use 64 characters or fewer.";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))
    return "Use letters, digits, - and _ only, starting with a letter or digit.";
  if (RESERVED_NAME.test(name)) return `Windows does not allow a file named “${name}”.`;
  // Windows and macOS file names ignore case, so "Docs" and "docs" would be one file.
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) return `An agent named “${name}” exists.`;
  return null;
}
