# Changelog

Release history for `subagent-effort-guard`. Versions match this plugin's `package.json` and marketplace catalog entry.

## Unreleased

### Added
- Documented the 1.0.0 release features for subagent effort approval and policy settings
## 1.0.0

### Added

- Approval of resolved subagent reasoning effort before provider dispatch, using the immediate parent's live effort as the default autonomous limit.
- Native OMP settings for `off`, `auto`, and `always` modes, fixed or parent-relative effort limits, and optional debug logging.
- Interactive actions to clamp effort, allow the requested effort, override it with a supported level, or cancel the task.
- Ceiling-safe clamping or cancellation when approval UI is unavailable or its deadline expires.
- Per-child decision tracking and a shared approval queue for nested and concurrent subagents.
