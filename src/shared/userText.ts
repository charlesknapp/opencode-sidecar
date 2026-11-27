// Splits a sent prompt back into the user's own words and the selection
// snippets appended by src/core/context.ts, so the transcript shows chips
// instead of a wall of code.

const SNIPPET =
  /\n*Selected code from `([^`\n]+)` \((lines? [0-9]+(?:-[0-9]+)?)\):\n(`{3,})[^\n]*\n[\s\S]*?\n\3(?=\n|$)/g;

/** VS Code's problems, from src/core/problems.ts: "Problems from VS Code (1 error in a.ts):". */
const PROBLEMS = /\n*Problems from VS Code \(([^\n]+)\):\n(`{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;

export interface SplitUserText {
  text: string;
  snippets: string[];
}

export function splitUserText(full: string): SplitUserText {
  const snippets: string[] = [];
  const text = full
    .replace(SNIPPET, (_m, path: string, range: string) => {
      const base = path.split(/[\\/]/).pop() ?? path;
      snippets.push(`${base}:${range.replace(/^lines? /, "")}`);
      return "";
    })
    .replace(PROBLEMS, (_m, summary: string) => {
      snippets.push(`Problems: ${summary}`);
      return "";
    });
  return { text: text.trim(), snippets };
}
