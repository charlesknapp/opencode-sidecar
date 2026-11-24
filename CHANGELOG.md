# Changelog

## 0.1.1 (2026-11-23)

**Look and feel**

- The chat scrolls behind the message box all the way to the panel's bottom edge and stays visible around it; a soft halo fades text near the box, and the chat fades out at the bottom edge. In a wide panel the box sits slightly inside the chat's column.
- The working mark is drawn true: the ring stays still and the disc orbits its centre, cutting the ring's gap as it goes (no more wobble). The gap is a real cut-out, so the mark looks right on any background, and the mark no longer restarts its orbit each time the agent's state changes.
- The status strip no longer covers the top border of the message box.
- One background wherever the view is docked, so fades never show as bands in themes whose panel and side bar colours differ.

**Fixes**

- No "Agent-only diff unavailable" strip when OpenCode recorded no snapshots (for example in a folder that is not a git repository): there was nothing to open. When workspace changes are shown instead, their line explains why on hover.

**Project**

- Releases are published by GitHub Actions with trusted publishing to the Visual Studio Marketplace (and Open VSX), from a clean install with no shared cache; CI actions updated to their Node 24 versions; the packaging tool's `minimatch` moved to a patched version (no change to the extension itself).

## 0.1.0 (2026-11-23)

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
