# Changelog

## Unreleased

- **Tidier in a narrow panel, with one name per action.** With the limits chip or a long model name, Send no longer wraps onto a line of its own: the model pill moves down beside it. Paste chips keep their number at 300 px. The approval badge is just a shield until you pick a mode. **Sign in again** is the one name for signing in to a provider or MCP server, the rules editor says **Remove** for every rule, and Ask aside's button is **Add to session**. Typing `/agents`, `/providers`, `/mcp` or `/permissions` opens that panel, the session strip is a single Tab stop (the arrow keys move along it), a new session's page points to **/** and **@**, and a session whose messages did not load no longer invites you to ask.
- **Write commit message no longer fails with "Model not found" now and then.** OpenCode generates the message in its default folder, which it unloads when idle; loaded again, it does not list your account's models for a moment. Sidecar asks once more when that happens.
- **No sign-in offer to a signed-in user in a new folder.** A folder OpenCode has not loaded yet lists no connections for a moment, which read as signed out: Sidecar showed the optional sign-in note (or, with no models yet, the sign-in screen). The account is read again once the folder has loaded.
- **A variant picked right after a model sticks.** OpenCode echoes each switch as an event; the model's echo could arrive while the variant was being saved, before its own switch went out, and put the variant back to the default for the session and the next new one (the same for two agents picked in a row).
- **Stop right after sending keeps your message.** OpenCode accepts a prompt a moment before it stores it, and an interrupt in between dropped it: the message showed in the chat but was gone from the session (also a `/goal` kickoff or a command). Stop now waits for OpenCode to take the message (up to 3 s) before it interrupts.
- **`/models`, `/new`, `/sessions` and `/export` in the `/` list.** OpenCode's server doesn't list the TUI's own commands, so they were missing. Picking one, or typing it and pressing Enter, opens the model menu, starts a session, opens History or exports the session. An OpenCode command of the same name still wins. ([#1](https://github.com/charlesknapp/opencode-sidecar/issues/1#issuecomment-7212265904))
- **Long conversations stay fast.** A 2,000-entry session with large diffs and outputs drew its first screen in about 16 s and now in about 0.4 s: the newest turns show at once and older ones are built in the background in small slices (Find, bookmarks and Rounds build the rest first), turns out of view skip layout, and a large output or diff keeps only the lines that show, with **Show all N lines** to see the rest in place (shorter ones look and work as before). 2,000 streamed words took 3 s with dozens of frames blocked up to 150 ms; now about 0.3 s with none over 50 ms. Find no longer slows the page while it has thousands of matches.
- **Long and damaged sessions open safely.** A session opens with its newest 400 messages, now with **Load earlier messages** above them (400 more at a time, up to 2,000, keeping your place); a 1,200-message session opens in about 0.2 s. A stored message Sidecar cannot read, or an entry the chat cannot draw, becomes one row, _This part couldn't be shown — Open raw JSON_, logged in the output, and the rest of the session shows. When OpenCode cannot return a session's messages, the session stays open read-only with the reason and **Retry** instead of a blank panel.
- **Says when the agent seems stuck.** The same tool call with the same input and result three times in a row, two calls taking turns, or a running task that sends nothing for 3 minutes (`opencodeSidecar.stuckMinutes`; not while a shell command runs or a request waits for you) brings up a card in the timeline naming the call, with **Stop**, **Steer…** (the message box in steer mode with a suggested message) and **Dismiss**. It never stops the agent by itself and goes away once the agent moves on. Re-reading files that changed, reading different files and polling a background job do not count. A subagent shows it on its row. `opencodeSidecar.stuckDetection` turns it off.

- **A header for the session's goal.** With `/goal` running, the objective stays pinned above the conversation with how it stands (in progress, achieved, or stopped with OpenCode's reason) and its round, read from OpenCode's goal plugin and kept up to date by its events, also for a goal set in another client. **Rounds** jumps through the goal's notices, **Pause** / **Resume** / **End goal** use OpenCode's own `/goal` command (ending asks first), and an achieved goal can be cleared.

- **Project instructions.** **/ → Project instructions…** and the Agents panel show which instruction files OpenCode reads for the folder (the global AGENTS.md or Claude's, each folder's AGENTS.md or CLAUDE.md up to your home folder, the config's `instructions`), worked out the way OpenCode 2.4.2 does, with what it skips (a CLAUDE.md beside an AGENTS.md). **Open** any of them, **Create AGENTS.md** from a short template (a global one only after asking; beside a CLAUDE.md, after the same warning and copy offer as Remember this), or **Set up with /init**.
- **Remember this.** Under a reply, it adds the text you selected (or the reply's first line) to the project's AGENTS.md as one line: you edit it first, see the change as a diff and confirm. Line endings and a BOM are kept. While the project only has a CLAUDE.md, it first warns that a new AGENTS.md makes OpenCode stop reading CLAUDE.md, and offers to create AGENTS.md from a copy of CLAUDE.md (then the line), with the template only, or to cancel.

- **MCP servers you can manage.** **/ → MCP servers…** is now a panel: each server's state (connected, connecting, disabled, failed with OpenCode's reason, needs sign-in), **Disconnect**, **Connect** and **Retry** for this OpenCode run, and **Authenticate** for a remote server that needs OAuth, which opens OpenCode's sign-in page, waits for it and reconnects the server. It follows OpenCode's MCP events, so a server connecting or failing in another client shows too.
- **Add an MCP server for this run.** A name and a command line (quotes and Windows paths work) or an `http(s)://` URL add a server through OpenCode's runtime API, labelled _added for this OpenCode run_; OpenCode's config is never changed, and a reload or restart drops it. **Remove** asks first.
- **Reload config from the MCP panel**, the Providers panel's reload with its retries, after editing `opencode.json`, MCP servers or skills.
- **An MCP server's sign-in no longer shows as a provider.** OpenCode lists it among its integrations; the Providers panel now leaves it to the MCP panel.

- **Review the agent's changes hunk by hunk.** Each change the agent made shows **Keep | Undo** above it in the editor, with **Keep file | Undo file** at the top and shading on what is left to review. **Undo** puts back exactly that change with an ordinary editor edit (Ctrl+Z restores it), also after you edited other parts of the file; a change you edited since says _Changed since — open diff_ instead of guessing, and your own changes are never touched. New files are deleted after asking, deleted ones restored; binary, incomplete and very large files are reviewed as a whole.
- **Review all.** The agent changes strip's **Review all** (now with the count left) and **Sidecar: Review Agent Changes** list every file with its changes to review, kept and undone, with **Keep all** and **Undo all** (both ask first), **Next change** and **Open all diffs**. Each file row shows what is left. **Alt+]** / **Alt+[** go to the next and previous change while a review is active, leaving the keys to inline suggestions while one shows.
- **Decisions that stay.** Keep and Undo are saved per session and change in the workspace, so switching sessions, reloading the window or restarting VS Code keeps them; changes the agent later rewrote are dropped, and a new edit to a reviewed file adds only the new changes.
- **Stage kept changes.** Stages exactly the hunks you kept with `git apply --cached` (VS Code's Git API cannot stage part of a file), against the staged version, with CRLF files, autocrlf and Windows paths handled; a hunk the staged version already has or that differs there is reported, not forced.
- **Rewind says what it reverts.** _Rewind conversation and code_ now lists the files that revert, from the agent's step snapshots, and warns when shell commands ran since, which files no edit tool reported, and which changed files stay (commands run with `!` and edits between prompts are not part of any step, so OpenCode does not revert them).
- **Agent-only diffs of files with several changes.** OpenCode 2.4.2 sends a whole-file hunk per change when a session diff has no context, which is not a valid patch once a file has two changes, so those files fell back to the workspace diff. Sidecar now asks for full-file context.

- **Custom agents.** **Agents…** in the `/` menu, **Manage agents…** under the agent switcher and **Sidecar: Manage Agents** open an Agents panel: every agent OpenCode has for the folder, built-in ones read-only, your own with their mode, model and file, and a note for a file OpenCode did not load. **New agent** and **Edit** fill in the name (checked so it works as a file name and an `@mention` everywhere), description, mode, a model from the catalog with its variant, temperature, permission switches and the system prompt, and save OpenCode's own Markdown file in the project's `.opencode/agents/` or, after asking, OpenCode's global config. Edits change only the fields that changed, keeping comments, unknown keys and line endings; an OpenCode 1 file (tools, permission) is converted only when a permission or the temperature changes. OpenCode picks the file up without a restart (Sidecar waits for it, and reloads OpenCode's config if it has to), a new primary agent is selected, and **Delete** asks first. Nothing is ever overwritten without asking. A name of a built-in agent (`build`, `plan`, `general`, `explore`) overrides it after a warning that says what that does: OpenCode 2.4.2 applies the file on top of the built-in (the description, mode, model, temperature and prompt it sets win, its permissions come after the built-in's rules), for the folder or, saved globally, every folder. Such a row reads **Built-in, overridden by** the file, with **Remove override**.
- **Import Roo Code and Kilo Code modes.** A banner in the Agents panel and **Sidecar: Import Roo Code Modes as Agents** find `.roomodes` and `.kilocodemodes` (JSON or YAML) and the global custom modes of Roo Code and Kilo Code (VS Code, Insiders, Cursor, VSCodium), and preview each mode as an agent: its role and instructions (plus `.roo/rules-<slug>/`) become the prompt, its tool groups permissions, its edit `fileRegex` globs when they can express it (otherwise edits ask), and an orchestrator a primary agent that may start the others as subagents. Modes that would replace an agent start unchecked; one named after a built-in agent can be checked, shows the override warning when it is, and the import asks once for every override; what does not carry over exactly is listed in the preview, the summary and as comments in each file.

- **Fix with OpenCode.** Errors and warnings get **Fix with OpenCode** in the light bulb and in the Problems view's quick fixes, in every language. The problem lands in the message box as a chip (with _Fix these problems._ typed into an empty box): the file relative to the folder, line and column, severity, source and code such as `ts(2322)`, the message and the code around it. **Fix problems in this file** and **Fix all problems in the workspace** (in **+**, **/** and the palette) take a whole file's or the folder's problems, grouped by file, errors first and at most 50, saying so when there were more.
- **Follow the editor (opt-in).** `opencodeSidecar.autoContext`, off by default, keeps the active editor's selection, or its file, as a dashed _editor_ chip in the message box that follows you. It is sent only if the chip is still there when you send; remove it to leave it out. Other open tabs are never included.
- **Write commit message with OpenCode.** In the Source Control title bar and the agent changes strip: a message for the staged changes (or the agent's, when nothing is staged) in your repository's style, written into the Git commit box with the chat's model through OpenCode's one-off generation, so the conversation is untouched. It never commits, asks before replacing a message you typed, and says plainly when the free limit is reached.
- **No VS Code shortcut is taken.** Sidecar's only keybinding stays Focus Chat on macOS (Cmd+Alt+O); every other key works inside the chat only, and a test keeps Ctrl+P, Ctrl+K, Ctrl+Escape and the other core bindings free.

- **A Providers panel.** **Providers…** in the `/` menu, **Manage providers…** under the model list and the setup card's provider buttons open one place for model providers: each connected one with its state (connected, needs sign-in, or the last error in plain English), how it is connected (OAuth, API key, an environment variable or OpenCode's config, never the secret) and its model count. **Connect** searches every provider OpenCode knows (over 300); **Sign in again** runs OpenCode's own sign-in again (the browser page OpenCode returns, a masked key box whose key goes straight to OpenCode, or OpenCode's terminal flow); **Disconnect** asks first and removes the stored sign-in; **Reload config** has OpenCode read its config again after you edit it.
- **Error cards that say what to do.** When a run fails because the provider rejected the key, a sign-in expired, the model is gone or the provider is not set up, the card offers **Sign in to _Provider_ again** and **Choose another model** instead of only explaining. OpenCode's error tags (`provider.auth`, `provider.no-route`, `provider.free-limit`, …) decide, so it also works when providers word their errors differently.
- **Sidecar: Check OpenCode Setup.** One Markdown report, with **Copy Report**: whether `opencode` is found and its version, the background service (registered, reachable, the same process, the same version), sign-in, whether the default model is offered, providers that need a sign-in or failed, and on Windows whether `opencode` is on PATH and the folder's drive letter is sent the way OpenCode records it. A local server (Ollama, LM Studio) gets a warning when a model's context is below 16k tokens, where OpenCode's instructions and tools no longer fit, with how to raise it. Also in the `/` menu, the panel and the setup card.
- **Start OpenCode works with npm's `opencode.cmd` on Windows.** Node cannot start a `.cmd` script directly, so Start OpenCode failed for npm installs; it now runs through `cmd.exe`.
- **A question pattern such as `\S` now means "not only spaces"**, as in OpenCode, instead of "exactly one character".

- **What a session costs, by model and by agent.** The usage menu (click the context ring) adds tables of the session's cost, steps and tokens by model and by agent, with subagents nested under the agent that started them and their own subagents' costs added ("$0.01 ($0.03)"). A free model shows $0.00 and a step with no reported cost shows —; cost OpenCode spent on titles and compaction is named, and today's cost in the project is underneath. A subagent's row adds its subagents' cost to its tooltip.
- **What fills the context.** The same menu splits the context in use into your messages, replies and thinking, tool calls and results, attached files and the summary of earlier messages, estimated from their text, and shows the rest of OpenCode's total as the system prompt, tools and instructions, which OpenCode adds but does not list.
- **Tokens a second, and the model per turn.** While a reply streams, the Working line shows an estimate of its speed. Each turn ends with a quiet line naming the model it ran on, its steps, tokens, speed and cost.
- **OpenCode Go and Console limits.** When OpenCode is signed in to an OpenCode workspace, the usage menu shows its Go allowance (rolling, weekly, monthly) and budgets as meters with when each resets, and a warning chip appears beside the ring once one is 80% used. Nothing is shown when OpenCode reports no limits.
- **Budget Guard never stops mid-edit.** When the budget runs out while the agent writes a file, it finishes that file and then stops ("Stopped after finishing src/a.ts"). It also stops before the step that would go over the cost limit, judged by the task's average step, instead of after it.
- **Approval modes: Ask, Balanced and Auto.** A badge in the header always shows the open session's mode as OpenCode reports it, and opens a menu to switch, with one line saying what each mode does. Ask asks before every edit, command and web request; Balanced lets reads, searches and edits in the folder run and asks for commands, the web and files outside the folder; Auto lets everything run except destructive commands (`rm -rf`, force pushes, `git reset --hard`, `Remove-Item -Recurse`, `rmdir /s` and the like), and asks once before switching, with _Don't ask again_. Apply a mode to this session or to the folder (new sessions start in it). Modes are OpenCode's own session rules, fitted to the agent so Plan still never edits; rules changed in OpenCode's terminal UI or another window show on the badge. OpenCode's config is never changed.
- **A permission rules editor.** **Permission rules…** lists the session's rules (the mode's, and your own to add, edit or delete as action, pattern and Allow, Ask or Deny) and the folder's always-allowed rules, which you can now edit as well as remove. It replaces **Always-allowed actions…**.
- **Always allow commands like this…** in a permission request suggests a pattern you can edit before saving (`npm test -- --grep foo` becomes `npm test *`; PowerShell and Windows commands too), says whether it covers the request, and saves it for this session or the folder, so near-identical commands stop asking. Sensitive-path warnings stay on the request.
- **Session strip: watch several sessions at once.** The sessions you opened lately in the folder, and any that are working or waiting for you, sit as tabs under the header, each with a status dot: working, waiting for your answer, finished or failed since you last looked. Click to switch; × only takes a session off the strip. It shows once two or more sessions are on it, remembers its tabs per folder, works with the keyboard, and `opencodeSidecar.sessionStrip` hides it.
- **Notifications for sessions you're not looking at.** When one finishes, fails or asks for a permission or an answer, a notification says so (following your notification settings, even while the chat is on screen) with **Open** to switch to it. The count on Sidecar's icon and the Status Bar include its waiting requests. Side questions and subagents are never notified on their own, and reconnecting or reopening never repeats a notice.
- **Ask aside with `/btw`.** Ask a quick question while the agent works, without derailing it or adding to its context. It runs in a hidden copy of the session with the Plan agent and streams into a card above the chat; follow up in the same side thread, **Add to session** to queue the answer into the session, or **Close** to delete the copy. Copies never appear in History and are cleaned up if VS Code closes with one open. Also in the `/` list and palette (**Ask aside…**).
- **Long pastes become a chip.** Pasting more than 8 lines or 800 characters of text into the message box no longer floods it: you get **Pasted text #1 · 120 lines · ~3.1k tokens**, with `[Pasted text #1]` where you pasted. Open the chip to read the text, use the pencil to put it back in the box, or × to remove it. The text is sent exactly as pasted, in its place, also when you steer or queue; the prompt in the chat shows it folded, and ↑ brings it back as a chip. Short pastes and pasted images work as before.
- **Ask aside's Add to session goes to the session you asked from.** It used to go to whichever session was open when you clicked, so an answer could land in the wrong conversation after you switched. If that session was deleted meanwhile, the card says so instead.
- **A model or variant you pick is no longer undone a moment later.** OpenCode confirms each model or agent switch with an event, and a late or out-of-order confirmation of an earlier switch could put the variant back to the model default. A reload of the open session that was still under way (for example after the connection to OpenCode came back) could also restore the session's old model. Your latest choice now wins, and goes to the session.

## 0.1.7 (2026-11-26)

- **Type `/` for commands.** A `/` at the start of the message opens OpenCode's commands above the box, filtered as you type. Tab or Enter completes one; a command typed out in full still runs on Enter. ([#1](https://github.com/charlesknapp/opencode-sidecar/issues/1))
- **Session history shows which sessions are working**, with a small spinner, including sessions started from OpenCode's terminal UI. ([#1](https://github.com/charlesknapp/opencode-sidecar/issues/1))
- **Windows: sessions from OpenCode's CLI and TUI appear in the history.** VS Code reports the drive letter as `c:` and OpenCode records `C:`, and OpenCode's filter is case-sensitive, so they were missing. Sidecar now uses `C:`, and still lists sessions it created under `c:`. ([#3](https://github.com/charlesknapp/opencode-sidecar/issues/3))
- **Connects to a service bound to every interface** (`opencode service set hostname 0.0.0.0`). Its registered `0.0.0.0` (or `::`) address is reached at loopback instead of being refused as remote. ([#2](https://github.com/charlesknapp/opencode-sidecar/issues/2))

## 0.1.6 (2026-11-24)

**OpenCode 2.4**

- **Subagent reports arrive live** again. OpenCode 2.4 hands them back through the session's inbox in a new wrapper; Sidecar reads both, so the one-line **Report from …** shows as soon as a subagent finishes.
- **Background notices** get their own row instead of being dropped: a shell command that went to the background reports its result, and a finished image or video job names the file it saved.
- **Goals** (`/goal`, which keeps OpenCode working until a reviewer confirms the objective) show as **Goal · set:** and the objective, then each round's reason and next step, without OpenCode's instructions to the model.
- **Todo lists** (OpenCode's experimental todo tool, `experimental.todo`) show as a checklist with what is done, in progress, to do and cancelled, instead of looking like a file edit.
- **Generated images and videos** show their prompt and link the file OpenCode saves.
- The **count on Sidecar's icon** no longer waits on a request OpenCode already dropped (such as one a subagent was still asking when it ended): when a turn or a subagent ends, Sidecar checks which requests are really open.

**Diffs and changes**

- In a wide panel (700px and up), inline diffs show **old beside new**, with a divider you can drag (or move with ←/→) to share the width. Narrower panels keep the stacked view.
- An inline diff says **Click to open in the diff editor** when you point at it.
- Edits say what they did: **Changed 1 line**, **Added 3, removed 1 line**, instead of a net count or just "Modified".
- The **Agent changes** strip: each file is one row that opens its diff (an icon at the end opens the file), the name first and its folder muted, no zero counts, and **new** or **deleted** as a small tag. **Review all** opens every change.

**Look and feel**

- The timeline is evenly spaced: a reply's text no longer carries extra space above and below, so its dot sits on its first line.
- The streaming caret sits right after the last word, not on a line of its own.
- A working step's dot breathes (a slow fade) instead of blinking.
- **Steering** and **Queued** badges are readable in every theme.
- A search's pattern shows as code, so `refreshToken(` reads as the text searched.
- No stray dot for a reply part that holds only whitespace.

## 0.1.5 (2026-11-24)

- The README (and so the Marketplace and Open VSX pages) opens with an animated demo of the timeline, the diff and live subagents. No change to the extension itself.

## 0.1.4 (2026-11-24)

- The listing says what Sidecar is in the words people search for: **Sidecar for OpenCode: Chat Sidebar & GUI**, an OpenCode chat sidebar and GUI for VS Code, Cursor and VSCodium. The extension ID and the panel's title are unchanged.
- The README compares Sidecar with the official OpenCode extension and answers more questions: Cursor, Windsurf and VSCodium, supported OpenCode versions, and local models.
- Open VSX releases are published with trusted publishing, so no access token is stored anywhere.

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
