// A session as Markdown, from Sidecar's own transcript: prompts, answers, tool calls
// (commands in code blocks, changed files), permission decisions, questions with their
// answers and subagent reports. Thinking and long tool output are left out, so the
// export reads as the conversation. Pure: the host opens it as an untitled document.

import { summarizeAnswer } from "./forms";
import type { TranscriptItem } from "../shared/model";

export interface ExportMeta {
  title: string;
  /** When the export was made (epoch ms). */
  exported: number;
  model?: string | null;
  directory?: string | null;
}

const DECISIONS: Record<string, string> = {
  once: "allowed once",
  always: "always allowed",
  reject: "declined",
  expired: "expired",
  pending: "waiting for an answer",
  sending: "being answered",
};

/** A fence longer than any backtick run in the text, so code never breaks out of it. */
function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

function when(ms: number | undefined): string {
  return ms ? ` · ${new Date(ms).toLocaleString()}` : "";
}

export function sessionMarkdown(items: readonly TranscriptItem[], meta: ExportMeta): string {
  const out: string[] = [`# ${meta.title.replace(/\n/g, " ")}`, ""];
  const facts = [`Exported from Sidecar for OpenCode${when(meta.exported)}`];
  if (meta.model) facts.push(`model \`${meta.model}\``);
  if (meta.directory) facts.push(`in \`${meta.directory}\``);
  out.push(`_${facts.join(" · ")}_`, "");
  // One "OpenCode" heading per turn, before the first thing the agent did after a prompt.
  let agentHeading = false;
  const agent = () => {
    if (!agentHeading) out.push("## OpenCode", "");
    agentHeading = true;
  };
  for (const it of items) {
    switch (it.kind) {
      case "user":
        out.push(`## You${when(it.time)}`, "", it.text.trim(), "");
        if (it.attachments.length)
          out.push(`Attached: ${it.attachments.map((a) => `\`${a}\``).join(", ")}`, "");
        agentHeading = false;
        break;
      case "assistant":
        if (!it.text.trim()) break;
        agent();
        out.push(it.text.trim(), "");
        break;
      case "tool": {
        agent();
        const failed = it.status === "failed" ? " (failed)" : "";
        out.push(`- **${it.name}** ${it.title}${failed}`.trimEnd());
        if (it.detail.command) out.push("", fence(it.detail.command, "sh"));
        if (it.detail.exitCode !== null && it.detail.exitCode !== 0)
          out.push(`  Exit code ${it.detail.exitCode}`);
        for (const f of it.detail.files) out.push(`  - \`${f.path}\` +${f.additions} −${f.deletions}`);
        out.push("");
        break;
      }
      case "permission": {
        agent();
        const what = [it.request.action, ...it.request.resources.slice(0, 3)].join(" ");
        out.push(`- Permission \`${what}\`: ${DECISIONS[it.status] ?? it.status}`);
        if (it.feedback) out.push(`  Instead: ${it.feedback}`);
        out.push("");
        break;
      }
      case "form": {
        agent();
        const answer = it.answer ? summarizeAnswer(it.form, it.answer).replace(/\n/g, "; ") : it.status;
        out.push(`- Question "${it.form.title}": ${answer}`, "");
        break;
      }
      case "turn-summary":
        if (!it.files.length) break;
        agent();
        out.push(
          `Changed: ${it.files.map((f) => `\`${f.path}\` +${f.additions} −${f.deletions}`).join(", ")}`,
          "",
        );
        break;
      case "handback":
        agent();
        out.push(
          `> **Report from ${it.agent ?? "a subagent"}**${it.description ? ` · ${it.description}` : ""}`,
          ">",
          ...it.report
            .trim()
            .split("\n")
            .map((l) => `> ${l}`),
          "",
        );
        break;
      case "notice":
        if (it.level === "error") out.push(`> ⚠ ${it.text}`, "");
        break;
      default:
        // Thinking and other internal rows are not part of the conversation's text.
        break;
    }
  }
  return (
    out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
