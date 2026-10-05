# Subagent Effort Guard

A small OMP plugin that approves **real, resolved subagent reasoning effort** before the child's first provider request. It uses the existing `task` tool and session APIs: no core fork, binary patch, provider payload mutation, model-selection changes, or production dependencies.

The default policy is `mode=auto`, `maxAutonomousEffort=parent`, `debug=false`: children may run autonomously up to their immediate parent's current effort; higher effort needs approval. The integration was investigated against OMP **18.6.1** and the pinned source below. This document is a verification procedure, not a claim that every scenario has been exercised.

## Install with a normal OMP binary

Once the marketplace is published as `tremklekmz/tremklekmz-omp-plugins`, run these commands from any directory. OMP fetches and caches the repository; no manual clone is required.

```sh
omp plugin marketplace add tremklekmz/tremklekmz-omp-plugins
omp plugin install subagent-effort-guard@tremklekmz-omp-plugins
```

The equivalent interactive commands are:

```text
/marketplace add tremklekmz/tremklekmz-omp-plugins
/marketplace install subagent-effort-guard@tremklekmz-omp-plugins
```

OMP also accepts the full Git URL, `https://github.com/tremklekmz/tremklekmz-omp-plugins.git`, instead of the GitHub shorthand. If published under another repository name, change only the source; the catalog name remains `tremklekmz-omp-plugins`.

For a project-scoped marketplace installation:

```sh
omp plugin install --scope project subagent-effort-guard@tremklekmz-omp-plugins
```

For local development or an unpublished checkout only, run either command from the repository root:

```sh
omp plugin link ./plugins/subagent-effort-guard
# Equivalent local installation: OMP links the directory.
omp plugin install ./plugins/subagent-effort-guard
```

Keep a linked checkout in place. **After installing or linking, exit the OMP process completely and launch it again.** Run `omp --continue` from the same project directory to resume this conversation with the plugin loaded. Enabling the plugin in settings changes disk state; it does not load a new extension into an already-running process. `/reload-plugins` is not sufficient for a newly installed extension. Restart after configuration changes as well, because the guard reads settings at `session_start`. OMP loads the TypeScript extension through its `omp.extensions` manifest; rebuilding OMP or installing another copy of its SDK is not required. Install only one copy of the plugin, rather than combining a marketplace install, local link, and explicit `--extension` path.

## Configuration

Settings use native OMP plugin configuration, not a separate guard configuration system:

```sh
omp plugin config list subagent-effort-guard
omp plugin config set subagent-effort-guard mode auto
omp plugin config set subagent-effort-guard maxAutonomousEffort parent
omp plugin config set subagent-effort-guard debug false
```

Examples of other policies:

```sh
omp plugin config set subagent-effort-guard maxAutonomousEffort medium
omp plugin config set subagent-effort-guard mode always
omp plugin config set subagent-effort-guard maxAutonomousEffort none
omp plugin config set subagent-effort-guard mode off
```

The native settings command is **`config set`**, not `config --set`. OMP's `plugin features --set` replaces enabled features and does not configure this policy.

For a project override, merge this into `<project>/.omp/plugin-overrides.json`:

```json
{
  "settings": {
    "subagent-effort-guard": {
      "mode": "auto",
      "maxAutonomousEffort": "medium",
      "debug": false
    }
  }
}
```

Project values override stored user values. Missing settings use the defaults. Invalid or unreadable settings cause a warning and a fail-safe `auto`/`none` policy, not silent disablement.

| Setting | Values | Meaning |
| --- | --- | --- |
| `mode` | `off`, `auto`, `always` | Disabled; approve escalations/unknowns only; approve every new child. |
| `maxAutonomousEffort` | `parent`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Immediate parent's live actual effort, no autonomous authorization, or a fixed limit independent of parent effort. |
| `debug` | `false` (default), `true` | Optional OMP debug-log metadata. |

Three different concepts must not be confused:

- **`mode=off`** disables guard inspection, tracking, clamping, and approval UI. Normal OMP task behavior is unchanged.
- **`maxAutonomousEffort=none`** keeps the guard active but approves no effort automatically, including a child whose actual level is `off`.
- **Actual thinking level `off`** means reasoning is disabled, not that the guard is disabled. It ranks below `minimal`. A parent at `off` supplies an `off` limit. `off` is not a fixed `maxAutonomousEffort` setting; it can be a supported Override/clamp result.

The actual effort ladder comes from OMP's `THINKING_EFFORTS`, not coarse task inputs `lo`/`med`/`hi`. For example, `hi` can resolve to `max`; this plugin evaluates `max`. An unknown child effort requires approval. An unknown parent effort requires approval only for a `parent` limit; fixed limits remain independent of the parent.

## Approval UI

The compact dialog displays the child name/ID, resolved provider/model, requested effort, immediate parent effort, and autonomous limit. In `auto`, known requests at or below the limit run without a dialog. In `always`, every newly created child needs a decision.

Available actions:

- **Clamp to limit:** set only the child's actual level to the highest supported level at or below the effective limit.
- **Clamp to parent:** similarly normalize the immediate parent's level, when known and meaningfully different.
- **Allow requested:** preserve the original resolved effort for this child only, without changing configuration or the parent.
- **Override...:** select an explicit supported actual level in a second dialog.
- **Cancel task:** abort the child before provider dispatch. Dismissing either dialog also cancels.

Equivalent direct effort choices are deduplicated: equal limit/parent targets appear once, and an Allow choice equivalent to the limit clamp is omitted. Unsupported clamp targets are not offered. Override lists only the child's declared supported levels. Actual `off` is offered for non-reasoning models, or for a declared controllable effort surface that does not require an effort; it is not invented for unknown/uncontrollable models.

The default selection is the safe limit clamp, or Cancel if there is no safe autonomous target. Each child has one decision, with in-flight decisions deduplicated. Approving a concrete effort pins that child's session level, disabling subsequent AUTO reclassification; later contexts enforce its accepted ceiling without repeated dialogs. Parent sessions are never changed.

**Respond promptly:** approval has a **20-second total deadline**, including time waiting for UI and the Override dialog. A safe limit is pre-clamped before waiting. Timeout or a dialog error keeps/applies the safe clamp, or aborts if no safe target exists. A timeout is never implicit approval. OMP also has a context-handler timeout; the guard's shorter deadline protects that boundary.

## Headless behavior and capability limits

Built-in task children have `hasUI=false`, even under interactive OMP. The plugin shares the interactive ancestor's UI with them. With no reachable interactive UI:

- `auto` requests within a known limit run normally.
- When approval is required (`auto` or `always`), the child is clamped to a supported level no higher than the effective limit.
- `none`, an unknown parent limit, or no supported level at/below the limit causes an abort, not unauthorized escalation.

OMP's capability clamp can fall back upward to a model's lowest supported tier. The guard reuses OMP's canonical order and model capabilities but selects a ceiling-safe target itself; it never uses an upward fallback to authorize execution. The final session level is read back after a change; an invalid or upward result aborts.

A reasoning model with no controllable effort surface is **unknown**, not equivalent to `off`. It requires explicit interactive approval to keep that unknown effort, or aborts headlessly. Override cannot offer nonexistent effort controls. Approval governs OMP's session-level controls and cannot promise a provider-side reasoning cost for an uncontrollable model.

OMP may attempt yield recovery after cancellation. The guard re-aborts at every subsequent `context`, so recovery remains blocked from provider dispatch; Cancel does not promise that OMP will make zero internal recovery attempts.

## Lifecycle and parent tracking

Policy runs in the awaited **`context` event**, after model/effort resolution and AUTO classification but before the request's reasoning snapshot. `session_start` is used only to read configuration and register a session binding; neither it nor `before_agent_start` is late enough for final AUTO effort approval.

Prepared extension factories are rebound to each child without reevaluating the module graph. A shared module-level map is keyed by actual `ctx.agent.id`. Each entry publishes a live getter bound to that session's `getThinkingLevel()`, plus its interactive ancestor's UI. The child uses `ctx.agent.parentId` to look up its **immediate** parent, not a root snapshot.

Thus `root=high -> child=medium -> grandchild=high` compares the grandchild against `medium`. Concurrent children have separate factory-local decision state; there is no shared "current child". Dialogs share an ancestor-owned queue, so concurrent approvals cannot overwrite each other's UI. Within-limit children do not wait for this queue. `session_shutdown` aborts pending UI work and removes only that binding's own map entry, with an ownership check so another binding using the same ID is not removed.

This depends on the current **same-process prepared-factory sharing** runtime. Independently evaluated extension modules or future isolated/out-of-process children would not share this map. Missing parent bindings never substitute the root's effort: parent-based limits require approval or headless abort, while fixed limits still govern independently. Restart and re-check compatibility when changing OMP versions.

### Pinned source references

Investigation source: [`can1357/oh-my-pi@d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c`](https://github.com/can1357/oh-my-pi/tree/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c).

- Coarse task effort resolution and precedence: [`task/executor.ts:4061–4076`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/task/executor.ts#L4061-L4076); child receives the level at [`:4194`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/task/executor.ts#L4194).
- Shared module graph and child factory rebinding: [`sdk.ts:2566–2598`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/sdk.ts#L2566-L2598).
- Getter/setter and abort bind to the current session: [`modes/runtime-init.ts:131–144`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/modes/runtime-init.ts#L131-L144).
- AUTO classification follows agent-start preparation: [`session/agent-session.ts:7555–7581`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/session/agent-session.ts#L7555-L7581).
- SDK awaits `context`: [`sdk.ts:4074–4076`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/sdk.ts#L4074-L4076). Agent loop awaits that transform at [`agent-loop.ts:1919–1925`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/agent/src/agent-loop.ts#L1919-L1925), before reading dynamic reasoning at [`:1989–1995`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/agent/src/agent-loop.ts#L1989-L1995).
- Aborted context prevents dispatch: [`extensions/runner.ts:2038–2041`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/extensibility/extensions/runner.ts#L2038-L2041). Call `ctx.abort()` without awaiting it inside the handler: abort completion waits for the running loop.
- Canonical ordering: [`catalog/src/effort.ts:1–18`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/catalog/src/effort.ts#L1-L18); supported efforts and ordinary normalization: [`model-thinking.ts:18–65`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/catalog/src/model-thinking.ts#L18-L65); actual `off` preservation: [`tui/src/thinking.ts:115–132`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/tui/src/thinking.ts#L115-L132).
- Native settings read/merge: [`plugins/loader.ts:478–489`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/extensibility/plugins/loader.ts#L478-L489); persistence: [`plugins/manager.ts:1008–1027`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/extensibility/plugins/manager.ts#L1008-L1027); CLI settings syntax: [`cli/plugin-cli.ts:1146–1151`](https://github.com/can1357/oh-my-pi/blob/d9ee5e6a31d621f50ac6610cd1cdadccfbf41b0c/packages/coding-agent/src/cli/plugin-cli.ts#L1146-L1151).

## Minimum verification procedure

Use a disposable project/profile and a normal OMP binary with this plugin installed. Record the OMP version. Restart between configuration cases. Select models whose metadata actually supports the requested test levels; confirm **resolved** child levels rather than assuming `lo`/`med`/`hi` map to specific levels. OMP's own task ceilings may lower a requested level before this guard sees it.

Temporarily enable metadata logging:

```sh
omp plugin config set subagent-effort-guard debug true
```

The plugin uses OMP `logger.debug("[effort-guard]", metadata)`: child/parent IDs, resolved model, actual parent/requested/limit/final effort, and decision. It logs no prompts, credentials, auth tokens, or provider payloads. Use the normal OMP debug-log facility; metadata alone is not evidence of the provider's first request.

For each case, observe whether a dialog appears, its actions/default, the final child effort, and the unchanged parent effort:

| Policy | Parent | Resolved child | Expected |
| --- | --- | --- | --- |
| `auto` / `parent` | medium | low | No dialog; low. |
| `auto` / `parent` | medium | medium | No dialog; medium. |
| `auto` / `parent` | medium | high | Approval required. |
| `auto` / `parent` | high | max | Approval required. |
| `auto` / `parent` | max | max | No dialog; max. |
| `auto` / `medium` | high | low | No dialog; low. |
| `auto` / `medium` | high | medium | No dialog; medium. |
| `auto` / `medium` | high | high | Approval required. |
| `auto` / `medium` | high | max | Approval required. |
| `always` / `parent` | high | low | Approval required. |
| `always` / `parent` | high | high | Approval required; equivalent direct actions deduplicated. |
| `off` / any valid limit | any | any | Same execution/effort as plugin disabled; no guard UI. |
| `auto` / `none` | any | any, including off | Approval required; headless abort. |

Also exercise all of the following:

1. **Actions:** with parent high, fixed limit medium, and child max, verify limit clamp -> medium, parent clamp -> high, Allow -> max, Override -> selected supported level, and Cancel -> no child provider call. Equal parent/limit targets must appear once. Approval must not alter stored settings or the parent.
2. **First request and AUTO:** instrument a disposable test provider or inspect provider-side request records to capture the first child's reasoning controls. Resolve AUTO to an above-limit level and verify no expensive request precedes approval. Clamp/Override must already affect the first request; Cancel must dispatch none. Continue the same child and verify no duplicate approval or later unapproved escalation.
3. **Nested/live parent:** root high -> child clamped/overridden medium -> grandchild high must require approval against medium. Change the parent's level before spawning a new child and confirm the live level, not an earlier snapshot, is used.
4. **Concurrent:** root high with A max (approval pending), B low, C high, D max must leave B/C automatic and keep A/D decisions independent. Give A and D different decisions and compare IDs/final efforts; include a nested child during this run.
5. **Headless:** run the same cases without interactive UI (for example `omp -p`). Within-limit `auto` requests pass; parent/fixed-limit escalations clamp safely; `always` follows the same fail-safe; `none`, missing parent, and no safe supported target abort. Do not infer headless status merely from a built-in child's `hasUI=false` in an interactive root.
6. **Capabilities/off/unknown:** use a limited-effort model and ensure Override omits unsupported levels and clamps never normalize upward. Verify an off parent/off-capable child can remain off. A requires-effort model must not offer off. An uncontrollable reasoning model requires explicit Allow or headless abort, not a fabricated off/low fallback.
7. **Timeout/dismissal:** leave a dialog unanswered for more than 20 seconds; repeat while waiting for another dialog and in Override. Confirm safe clamp or abort before dispatch. Escape/dismissal must cancel. Cancelled yield-recovery attempts must stay blocked on every later context.
8. **Cleanup/configuration:** finish/cancel several children, shut down sessions, and repeat nested/concurrent runs without stale parent bindings. Verify project overrides beat user settings, missing settings restore auto/parent/false, and invalid readable values produce the fail-safe warning/policy.

Restore quiet logging and the preferred policy afterward:

```sh
omp plugin config set subagent-effort-guard mode auto
omp plugin config set subagent-effort-guard maxAutonomousEffort parent
omp plugin config set subagent-effort-guard debug false
```

## Recorded verification

Before further testing was handed over to the user:

- Bun policy suite: **35 passed, 0 failed**.
- OMP **18.6.1**: local marketplace discovery, installation, and native settings commands succeeded in an isolated profile.
- Offline scripted-provider runs exercised first-request clamping, unchanged parent effort, headless parent/fixed limits, `off`/`always` modes, `none` cancellation, nested children, and concurrent children.
- Actual RPC UI runs exercised limit clamp, parent clamp, Allow, Override, and Cancel with independent concurrent decisions and no duplicate approval dialogs. Cancel dispatched no child provider call.

These used a local deterministic provider, not paid inference. Terminal visual verification, AUTO classifier escalation, timeout behavior, and remaining capability/configuration scenarios still need the manual procedure above.
