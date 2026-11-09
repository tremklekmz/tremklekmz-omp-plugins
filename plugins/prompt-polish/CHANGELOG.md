# Changelog

Release history for `prompt-polish`. Versions match this plugin's `package.json` and marketplace catalog entry.

## Unreleased

## 1.1.0

### Added

- Keys `1`–`3` (or the style buttons in Tern) rewrite the original draft again in the `light`, `standard`, or `strong` style without leaving the review; each candidate remembers its style.
- `intensity: ask` picks the style in a dialog before every polish.

## 1.0.0

### Added

- Alt+E (configurable) and `/polish <draft>` rewrite a draft into a clearer prompt through an OMP side turn that sees the conversation without entering session history.
- Review dialog with rewrite, word-diff, and original views; accept, edit, another pass with notes, and candidate history. Native in Tern.
- `light`, `standard`, and `strong` intensity setting.
- `/polish-undo` restores the editor text the last accepted rewrite replaced.
