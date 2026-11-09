# prompt-polish

Turns a rough draft in the editor into a clearer prompt and shows the rewrite before anything changes. It never sends the prompt: accepting only replaces the editor text.

Inspired by [pi-chisel](https://github.com/feveromo/pi-chisel); the concept is the same, the implementation is not. Instead of assembling its own context and calling a model on the side, prompt-polish runs an OMP **side turn** (`ctx.runEphemeralTurn`, the `/btw` pipeline): the model sees the real conversation and project context, the request reuses the session's prompt cache, and neither the draft nor the reply is added to session history.

## Install

```sh
omp plugin marketplace add tremklekmz/tremklekmz-omp-plugins
omp plugin install prompt-polish@tremklekmz-omp-plugins
```

Exit OMP completely and start it again (`omp --continue` resumes the conversation). For local development: `omp plugin link ./plugins/prompt-polish`, or for one run without linking: `omp --no-extensions -e ./plugins/prompt-polish/index.ts`.

## Usage

Type a draft and press **Alt+E**, or run `/polish <draft>`. With `intensity` set to `ask`, a dialog first asks for the style. A dialog then shows a spinner while the model rewrites (**Esc** cancels; nothing changes), then the review:

| Key | Action |
| --- | --- |
| `Enter` / `a` | Use the rewrite: it replaces the editor text, unsent |
| `e` | Edit the rewrite first |
| `r` | Another pass: type notes ("shorter", "in English") or leave empty for a different take |
| `1` `2` `3` | Rewrite the original draft again in the `light`, `standard`, or `strong` style; the active style is highlighted under the views |
| `Tab` / `v`, `d`, `o` | Cycle views; jump to **Changes** (word diff) or **Original** |
| `b` / `f` | Previous / next candidate after another pass or an edit |
| `↑` `↓` / `j` `k`, `PgUp` `PgDn`, `Home` `End` | Scroll |
| `Esc` / `q` | Keep the original |

`/polish-undo` puts back the editor text the last accepted rewrite replaced (same OMP process).

In **Tern**, the same dialog is native, with view, style, and action buttons.

The model may return the draft unchanged; the header then says **already good**.

## Settings

```sh
omp plugin config set prompt-polish intensity strong
omp plugin config set prompt-polish shortcut ctrl+alt+p
```

| Setting | Default | Values |
| --- | --- | --- |
| `intensity` | `standard` | `light` fixes wording only; `standard` clarifies and organizes; `strong` builds a rough idea into a full prompt with specifics, edge cases, and verification; `ask` picks one of these in a dialog before every polish |
| `shortcut` | `alt+e` | Any free key chord. Read at startup: restart OMP after changing it. A taken chord produces a warning at session start; `/polish` still works |

`intensity` is read on every run, so it applies without a restart; inside the review, `1`–`3` switch it for that one polish. Invalid values fall back to the defaults with a warning.

Every level keeps your goal and request type (a question stays a question), hedges, constraints, length limits, tone, language, and literal names, paths, code, and URLs. The instruction is in [`polish.ts`](polish.ts); it is a set of rules for the model, not a guarantee, so read the rewrite before using it.

## Privacy and cost

- Each pass sends the **whole current conversation** plus your draft to the session's current model provider, like `/btw`. The prompt cache usually makes this cheap, but the first pass in a long uncached session costs as much as a normal turn's input.
- Side turns use the session model at its lowest effort where the provider supports per-message effort without losing the cache; otherwise at the session's effort. There is no separate model setting.
- Tool definitions stay in the request to keep the cache; any tool call the model attempts is discarded and reported as a failed pass.
- Nothing is stored on disk. Candidates and the undo text live in memory until the overlay closes or the session ends.

## Safety

- Failed, empty, cut-off, cancelled, or timed-out (120 s) passes never touch the editor. Esc during the first pass closes the dialog; during a later pass it returns to the previous candidate.
- Accepting checks that the editor still holds what it held when polishing started and asks before overwriting anything else. `/polish-undo` asks before replacing unrelated text.
- Terminal control characters in model output are removed before display.
- One polish at a time; OMP shutdown aborts a running pass.

## Requirements

Interactive TUI with side-turn support (`ctx.runEphemeralTurn`). In print, JSON, or RPC mode the command only reports that it is unavailable.

## Verification

`bun test plugins/prompt-polish` covers settings validation, rewrite extraction (tagged, fenced, cut-off, empty), and the word diff (exact reconstruction of both sides, phrase grouping, change counts, the large-input fallback).

Manually verified on OMP 18.18.3 with Claude Opus 5.5 in a scratch Git project, driving the real TUI through a pseudo-terminal: Alt+E on a typed draft opened the dialog and produced a rewrite in about a second; the Changes view showed a word diff with strikethrough removals; another pass with the note "in Czech please" produced a Czech candidate with `2/2` history; Enter placed it in the editor unsent; `/polish-undo` restored the original draft; Esc during a pass closed the dialog. The session's context usage stayed unchanged throughout. Not exercised: the Tern native dialog, the `e` edit path, the editor-changed confirmation, timeouts, and providers other than Anthropic.
