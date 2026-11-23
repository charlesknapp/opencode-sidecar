# Changelog

## 0.1.0 (unreleased)

First release of Sidecar for OpenCode.

**Chat**

- A timeline of the agent's work: each prompt starts a turn, with a dot per step for text, thinking ("Thought for 9s"), tool calls and subagents; times on prompts and answers, and a divider for each day.
- Prompts in bubbles that stay pinned while you read their turn (`opencodeSidecar.stickyPrompt`), with **Rewind ↺** to just before a prompt, with or without undoing the agent's file changes.
- Tool calls you can read, with syntax colors from your theme in diffs and code: Shell IN/OUT boxes, file links for reads, changed lines inline for edits (click for VS Code's diff editor), and the full command, output or prompt in a read-only editor tab. Optional grouped view (`opencodeSidecar.activity`).
- Live subagents: their task, exact prompt, current activity, counts and time, with **Stop** and **Open ›** into their own conversation, and the report each one hands back.
- Copy and Bookmark under each turn's final answer; bookmarks per workspace.

**Message box**

- `@` mentions of files, folders, subagents and skills, picked from a list above the box and sent to OpenCode as mentions.
- Images: paste or drop a screenshot, or attach image files; large screenshots are scaled down, and models without image input are pointed out.
- Floats over the chat in the same column, which fades out beneath it, with + context, the / action palette (OpenCode's commands, `/compact`, `!command`, model, session and settings), a prompt-cache clock with usage, the agents pill, the model pill with variant and Budget Guard sliders, the agent switch (Shift+Tab), steer or queue, and send/stop.
- Permission requests and questions take the message box's place until answered; a rejection can tell the agent what to do instead.
- Budget Guard: a local per-task limit on cost and steps.

**Sessions and setup**

- Header with the session title (click to rename), Bookmarks, History with search, and New session.
- Fork a conversation from any prompt (or all of it) into a new session; archive sessions and restore them from History.
- A first-run setup card for installing, starting and signing in to OpenCode, and native notifications when a task completes, needs input, fails or is stopped.
- Agent changes kept apart from workspace changes, both in VS Code's diff editor.
- Follows changes made in other OpenCode clients: rewinds (a staged one can be restored or applied), agent and model choices, and the session list.
- While the agent works, Sidecar's mark turns beside a word for the run, such as _Riding along…_ (`opencodeSidecar.statusWords`), with the elapsed time and Esc to stop.
- Actions appear on hover (Fork and Rewind on prompts, Copy and Bookmark under answers, Copy on IN/OUT lines); destructive ones are confirmed in a dialog over the chat.
- Responsive from 300 px, VS Code theme colors only, high-contrast and reduced-motion support.
