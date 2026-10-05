# Personal OMP Plugins

A plugin marketplace for [oh-my-pi](https://github.com/can1357/oh-my-pi). Plugins run on a normal OMP binary; no fork or rebuild is required.

## Install from GitHub

Once this repository is published as `tremklekmz/tremklekmz-omp-plugins`, run these commands from any directory. OMP fetches and caches the marketplace; no manual clone is needed.

```sh
omp plugin marketplace add tremklekmz/tremklekmz-omp-plugins
omp plugin discover tremklekmz-omp-plugins
omp plugin install subagent-effort-guard@tremklekmz-omp-plugins
```

**Exit OMP completely and launch it again after installing or linking this extension.** To resume your conversation, run `omp --continue` from the same project directory. An enabled entry in plugin settings means enabled on disk, not loaded in the already-running process. `/reload-plugins` does not initialize newly installed extension modules.

For local development only, run this from a checkout:

```sh
omp plugin link ./plugins/subagent-effort-guard
```

The same full restart is required after `plugin link`; linking does not activate the guard in an existing OMP process.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [subagent-effort-guard](plugins/subagent-effort-guard/README.md) | Approve reasoning escalations using the child's actual resolved effort and the immediate parent's live effort. Defaults to `auto` with a `parent` autonomous limit. |

## Configuration

```sh
omp plugin config set subagent-effort-guard mode auto
omp plugin config set subagent-effort-guard maxAutonomousEffort parent
```

Restart OMP after changing plugin settings. See the [plugin guide](plugins/subagent-effort-guard/README.md) for approval actions, project overrides, headless behavior, verified lifecycle, and test procedure.

## Extend

To add another plugin:

1. Add a directory under `plugins/` with a `package.json` declaring `omp.extensions` and, if needed, native `omp.settings`.
2. Add a unique catalog entry in `.omp-plugin/marketplace.json`. `metadata.pluginRoot` is `plugins`, so `source` is relative to that directory.
3. Bump the plugin and catalog versions when publishing an update.
4. Refresh the catalog with `omp plugin marketplace update tremklekmz-omp-plugins`, then install updates with `omp plugin upgrade`.

## Development

```sh
bun install
bun test
```

The test-only development dependency supplies OMP's catalog helpers. Installed plugins use the modules bundled with OMP.

See OMP's [marketplace guide](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md) and [extension guide](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md).
