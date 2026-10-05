# Repository Guidelines

## Project Overview

This repository is an OMP plugin marketplace, not a standalone application or OMP fork. Its current plugin, `subagent-effort-guard`, gates actual resolved subagent reasoning effort before provider dispatch. Plugins run directly in a normal OMP binary.

## Architecture & Data Flow

- `.omp-plugin/marketplace.json` exposes plugins beneath `metadata.pluginRoot: "plugins"`. Each plugin's `package.json` declares its TypeScript entry through `omp.extensions` and native settings through `omp.settings`.
- `plugins/subagent-effort-guard/policy.ts` contains pure configuration validation, effort ranking, approval decisions, ceiling-safe target selection, and dialog-choice construction. Keep policy independent of host lifecycle/UI code.
- `plugins/subagent-effort-guard/index.ts` is the host adapter: `session_start` reads settings; `context` inspects the child's resolved effort, its immediate parent's live effort, and model capabilities before permitting execution; `session_shutdown` cancels pending work and removes owned bindings.
- Module-level agent-ID bindings expose live effort getters and ancestor UI. Each extension factory owns its child's decision state, enforced ceiling, pending promise, and cancellation controller. A shared UI promise queue serializes approvals; do not introduce a shared “current child” or snapshot the root's effort.
- OMP injects the extension API and event context. Use those session/settings/UI APIs; do not mutate provider payloads or replace task/model selection.

## Key Directories

- `plugins/`: independently versioned plugins, each with its manifest, source, README, and changelog.
- `plugins/subagent-effort-guard/`: runtime adapter, pure policy, and colocated policy tests.
- `.omp-plugin/`: marketplace catalog; relative plugin sources resolve beneath `plugins/`.

## Development Commands

```sh
bun install
bun test
bun test plugins/subagent-effort-guard/policy.test.ts

# Exercise the extension in OMP from this checkout:
omp plugin link ./plugins/subagent-effort-guard
# Exit OMP completely, then resume from the same project directory:
omp --continue

omp plugin config set subagent-effort-guard mode auto
omp plugin config set subagent-effort-guard maxAutonomousEffort parent
```

Restart OMP after installation/linking or settings changes. `/reload-plugins` does not initialize newly installed extension modules. No build, lint, formatter, or standalone run script is configured; OMP loads the TypeScript extension directly.

## Code Conventions & Common Patterns

- ESM TypeScript; descriptive camelCase functions/variables and explicit policy types. Preserve file-local formatting: two spaces in `index.ts`, tabs in `policy.ts` and `policy.test.ts`.
- Use OMP's `THINKING_EFFORTS` and capability helpers, not coarse task inputs (`lo`/`med`/`hi`). Distinguish actual `off`, configured `none`, and unknown effort. Unknown reasoning capability is not automatically `off`.
- `safeTarget` must never clamp upward past the ceiling. Read back applied session effort and reject unsafe host normalization. Never modify the parent session's effort.
- Invalid/unreadable settings fall back to `auto`/`none` with a warning. Missing UI or an expired approval deadline uses a safe clamp or aborts; timeout is never approval.
- Deduplicate in-flight decisions; preserve the 20-second total approval deadline, cancellation signals, and `finally` cleanup of timers/queue slots. Do not await abort completion inside a context handler: it can depend on that handler finishing.
- Keep bindings keyed by actual agent ID and remove them only when ownership matches. Later contexts enforce accepted ceilings and re-abort cancelled children.
- Use Conventional Commit messages, e.g. `feat: add a plugin`, `fix: preserve effort ceilings`, `docs: clarify installation`.

## Important Files

- `package.json`, `bun.lock`: private development package, Bun test command, pinned test dependencies.
- `.omp-plugin/marketplace.json`: discovery sources and per-plugin upgrade versions.
- `plugins/subagent-effort-guard/package.json`: extension entry and `mode`, `maxAutonomousEffort`, `debug` schemas/defaults. Keep schema and policy validation aligned.
- `plugins/subagent-effort-guard/index.ts`, `policy.ts`, `policy.test.ts`: host integration, decision rules, and unit coverage respectively.
- `README.md`: marketplace installation and adding/releasing plugins.
- `plugins/subagent-effort-guard/README.md`: behavior, host integration caveats, manual QA procedure, and bounded recorded verification.
- `plugins/subagent-effort-guard/CHANGELOG.md`: plugin release history. Keep pending changes under `Unreleased`; on release, synchronize the plugin's `package.json` version, catalog entry version, and changelog section. There is no marketplace-wide version or root changelog. Catalog entry versions are needed for bulk upgrade checks.

## Runtime/Tooling Preferences

Use Bun for dependency management and tests; keep `bun.lock` consistent. No minimum engine version is declared. Installed plugins use OMP-bundled modules; the root's exact `@oh-my-pi/pi-catalog` dependency (`18.6.1`) is test-only, not a reason to add production dependencies. Host code uses `AbortSignal.any` and `Promise.withResolvers`; preserve compatibility with the target OMP runtime. Integration documentation is based on OMP 18.6.1; do not assume newer host behavior is identical.

## Testing & QA

- Tests use `bun:test` (`describe`, `it`, `it.each`, `expect`) with real catalog constants, direct assertions, and exhaustive effort/capability matrices; no mock host or fixture harness exists.
- Cover consumer-visible boundaries: malformed settings, unknown efforts, `off` versus `none`, parent-relative versus fixed limits, no upward clamping, supported capabilities, and choice deduplication. No numeric coverage threshold is configured.
- Unit tests cover pure policy, not extension loading, UI timing, cancellation, or provider dispatch. For host changes, run the plugin README's minimum verification procedure in a disposable project/profile with a deterministic provider where possible.
- Exercise nested/live parents, concurrent approvals, headless execution, timeout/dismissal, and cancellation recovery when affected. Inspect the first provider request's effective effort; requested task effort alone is not proof.
- Keep verification claims scoped to exercised scenarios. The README explicitly leaves terminal visual verification, AUTO classifier escalation, timeout, and some capability/configuration scenarios unverified.
