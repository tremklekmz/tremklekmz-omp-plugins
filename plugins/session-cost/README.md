# session-cost

`/cost` breaks the current session's spend down by main chat, prompt turns, individual model calls, subagents (nested ones included), and advisors.

Built-in `/session info` sums only the active window of the main transcript, so async subagents never reach it. The status line shows them as `(+…)` without detail. `/cost` reads every transcript the session wrote and prices each one exactly once.

## Install

```sh
omp plugin marketplace add tremklekmz/tremklekmz-omp-plugins
omp plugin install session-cost@tremklekmz-omp-plugins
```

Exit OMP completely and start it again (`omp --continue` resumes the conversation). For local development: `omp plugin link ./plugins/session-cost`.

## Usage

Run `/cost` in the interactive TUI.

In **Tern**, this opens a native dialog with clickable rows, full-width details, and **Back**, **Refresh**, and **Close** buttons. In other terminals, the same dialog uses keyboard navigation. No terminal-row `fallback` is needed in Tern.

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k`, `PgUp` `PgDn`, `Home` `End` | Move |
| `Enter` / `→` | Open the selected row |
| `←` / `Backspace` | Back |
| `Esc` | Back; closes at the root |
| `q`, `Ctrl+C` | Close |
| `r` | Re-read transcripts (useful while agents run) |

Pages:

- **Root**: two totals, then *Main chat*, *Subagents*, and *Advisors*. The rows add up to **Total**.
- **Main chat**: one row per user prompt. A turn's cost includes the subagents its `task` calls spawned, async ones included. Turns on abandoned branches are dimmed.
- **Turn**: each model call (time, model, tokens, cost); auxiliary calls (compaction, judges, …) are prefixed `aux`. Spawned agents follow.
- **Agent**: transcript path, its turns or calls, then its nested subagents and advisors.

Outside the TUI (`omp -p`, RPC), `/cost` emits a plain-text summary through `notify`.

## Totals

- **Total**: every billed call in the main transcript (all branches, compacted history, auxiliary calls) plus every subagent and advisor transcript in the session's artifact directory.
- **Active window**: the `/session info` scope (active branch since the last compaction or reset boundary), plus the subagent trees spawned from task calls inside that window.

Main-chat advisors are a separate category. Advisors reviewing a subagent count inside that subagent's tree, matching the status line.

## Caveats

- Costs come from `usage.cost` recorded by OMP at list price; subscription plans are shown at list price too.
- Transcript layout (`<session>/<AgentId>.jsonl`, nested agents in `<session>/<AgentId>/`, advisors in `__advisor[.<slug>].jsonl`) is internal to OMP and may change between releases. Verified against OMP 18.14.0.
- Running agents show the calls written so far and are marked `running`; refresh with `r`.
- Task calls that never recorded an agent id cannot be attributed to a turn; their transcripts still count in the totals.

## Verification

`bun test plugins/session-cost` covers whole-transcript versus window totals across branches, compaction, and reset boundaries; no double counting of task-result usage; nested trees; advisor placement; async attribution; malformed JSONL; and missing usage fields.

Manually verified on OMP 18.14.0 against a real session with one async subagent: Subagents showed $0.0973, matching the status line's `(+0.10)`, and the turn that spawned it included that cost. Navigation and the headless summary were exercised through a throwaway extension driving the component; the colored terminal rendering was not inspected.

Native dialog support was exercised inside OMP 18.14.0 without model inference: the component emitted semantic nodes rather than fallback rows, and activation, Back, Refresh, Close, stale-page event rejection, and the ANSI render path passed. The actual Tern window appearance was not inspected.
