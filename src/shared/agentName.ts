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

/**
 * OpenCode 2.4.2's built-in agents that a file of the same name (exactly: ids are case
 * sensitive) overrides. Its hidden compaction, title and summary agents are not offered.
 */
export const BUILT_IN_AGENTS: readonly string[] = ["build", "plan", "general", "explore"];

export const isBuiltInAgent = (name: string): boolean => BUILT_IN_AGENTS.includes(name);

/**
 * What an agent file named after a built-in does. Checked live: OpenCode applies the file
 * on top of its built-in agent rather than replacing it, field by field.
 */
export function overrideWarning(names: readonly string[], scope: "project" | "global"): string {
  const many = names.length > 1;
  const which = many
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} agents`
    : `${names[0]} agent`;
  return `${many ? "The files override" : "The file overrides"} OpenCode's built-in ${which} ${scope === "global" ? "in every folder" : "in this folder"}. OpenCode applies ${many ? "each" : "it"} on top of the built-in: the description, mode, model and temperature it sets replace the built-in's, its text replaces the built-in's prompt (an empty one leaves none), and its permissions come after the built-in's own rules, so they win where both match. Delete the file to get the built-in back.`;
}
