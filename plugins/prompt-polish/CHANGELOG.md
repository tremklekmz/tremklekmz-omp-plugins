# Changelog

Release history for `prompt-polish`. Versions match this plugin's `package.json` and marketplace catalog entry.

## Unreleased

## 1.0.0

### Added

- Alt+E (configurable) and `/polish <draft>` rewrite a draft into a clearer prompt through an OMP side turn that sees the conversation without entering session history.
- Review dialog with rewrite, word-diff, and original views; accept, edit, another pass with notes, and candidate history. Native in Tern.
- `light`, `standard`, and `strong` intensity setting.
- `/polish-undo` restores the editor text the last accepted rewrite replaced.
