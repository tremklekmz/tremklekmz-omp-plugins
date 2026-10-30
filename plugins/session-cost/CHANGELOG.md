# Changelog

Release history for `session-cost`. Versions match this plugin's `package.json` and marketplace catalog entry.

## Unreleased

## 1.0.2

### Fixed

- Navigating empty `/cost` pages with Down or Page Down no longer crashes in ordinary terminals.

## 1.0.1

### Fixed

- `/cost` opens a native, clickable dialog in Tern instead of showing terminal fallback rows in the editor area.

## 1.0.0

### Added

- `/cost` command that breaks session spend down by main chat, prompt turns, individual model calls, subagents (nested included), and advisors.
- Whole-transcript total next to the `/session info` active-window total, both including async subagents.
- Plain-text summary when no interactive UI is available.
