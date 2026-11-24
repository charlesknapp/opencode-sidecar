# Changelog

## 0.1.3 (2026-11-23)

**New**

- **Find in the conversation** with Ctrl/Cmd+F: matches highlighted in place, Enter / Shift+Enter to step, Esc to close.
- **Code blocks** can be inserted at the editor's cursor or opened in a new editor, besides Copy code.
- **Export to Markdown** (in the / palette and the Command Palette) opens the session as a readable Markdown document.
- **Delete** a session permanently, from the Archived view of History or the / palette, after a confirmation.
- The **Git branch** shows beside the session title (from VS Code's Git; a detached HEAD shows its commit).
- **MCP servers…** in the / palette lists the folder's MCP servers and their state as OpenCode reports them.
- **Always-allowed actions**: **/ → Always-allowed actions…** lists the rules OpenCode saved for the folder when you chose _Yes, always allow_, and removes one after a confirmation, so OpenCode asks again.
- A **count on Sidecar's icon** while permission requests or questions wait, so a hidden panel still says it needs you.
- **↑/↓ in an empty message box** recall this session's earlier prompts, as in a terminal.
- **Jump to latest**: scrolled up while the agent works, a pill above the box shows how many steps are new and takes you back to the end.
- New commands: **Sidecar: Show History** and **Sidecar: Export Session to Markdown**, ready to bind to keys.

**Message box**

- **Steer or queue** moved from the agent menu to a two-way switch in the message box's footer, shown while the agent works: steer (blue) or queue (purple, and the box border follows). Under 360px only the chosen mode shows, and a click flips it. **Alt+Enter** sends one message the other way, and each waiting message can be switched between the two before it is delivered.
- The **variant and Budget Guard sliders** take a click anywhere along the track and follow a drag, picking the nearest step; the choice is sent once, on release. The chosen dot grows in place, so no dot moves under the pointer.
- A new **permission request or question** closes any open menu, the @ list, Bookmarks and History, so nothing covers it.
- The message box is a little wider in a wide panel (up to **670px**).

**Look and feel**

- Every action in the **/ palette** has an icon and a line saying what it does, OpenCode's own commands included; the switches sit under **Display** and MCP servers, always-allowed actions and Sidecar's settings under **Settings**.
- The **Working line** moves to a new word every 8 seconds, a block cursor sweeping across to turn the old word into the new one in about a second, and the mark orbits faster; it sits a little further below the last step. With reduced motion the cursor stays off.
- **Build** and **Plan** have their own icons (a hammer and a clipboard), in the message box and the agent menu; other agents show a person.

**Notifications**

- **Notifications** for a request now say what is asked (a question, or the permission and what it is for, with credentials redacted), and no longer pop up while you are watching the chat, where the request is already in front of you.

## 0.1.2 (2026-11-23)

- **Context ring** in the message box: it fills with the context in use (from the tokens OpenCode reports and the model's limit), in the theme's warning colour from 70% and error colour from 90%. Hover for the numbers; click for context, cost, steps, the task budget and Compact.
- The **prompt cache clock** shows only when the last step reported prompt-cache tokens, so models without a prompt cache (such as most local ones) no longer show a countdown that means nothing.
- The **/** button is a drawn icon matching the others in the message box.
- The chat **dims across the whole box area**, as it passes beside and below the message box, instead of only at the bottom edge.
- The message box stops growing at **640px**, centred under the chat, so in a wide panel it no longer stretches across it, and it starts one line tall.
- The **status strip** above the message box is as wide as the box and joins it as one unit, and its workspace line stays on one row ("HEAD ↔ working tree" moves to the tooltip in a narrow panel).
- In a **narrow panel** (420px or less) the model pill moves to a row of its own under the tools instead of being squeezed; just above that width the model's variant gives way to its name (it stays in the tooltip and the model menu).

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
