// Maps a Markdown code fence's language to a VS Code language id, for "Open in editor".

/** Common fence names that differ from VS Code's language ids. */
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  py: "python",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  ps1: "powershell",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
  rb: "ruby",
  cs: "csharp",
  "c++": "cpp",
  kt: "kotlin",
};

/** The VS Code language for a fence name, among the `known` ids; plain text otherwise. */
export function languageFor(fence: string, known: readonly string[]): string {
  const name = fence.trim().toLowerCase();
  const want = LANG_ALIASES[name] ?? name;
  return want && known.includes(want) ? want : "plaintext";
}
