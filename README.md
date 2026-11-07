# dsh-plugin-resolve

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that bridges
**DaVinci Resolve** into DSH: it registers Resolve's MCP server through DSH's official
mcp-client bridge, so every DSH agent can inspect and drive Resolve through ordinary,
namespaced tools (`mcp__resolve__*`).

DaVinci Resolve Studio **21.1** ships a native MCP server (`ResolveMCP`, stdio). This bundle
registers that server automatically — and, when it is not available, falls back to the
community [`davinci-resolve-mcp`](https://github.com/samuelgursky/davinci-resolve-mcp) server
(37 compound / 390 granular tools over the official scripting API, Resolve 18.5+, free edition
reachable via its in-app bridge).

## What you get

| Backend | Source | Requires | Tools |
|---|---|---|---|
| `native` (default when present) | `ResolveMCP` bundled with Resolve Studio 21.1+ | Resolve **Studio** 21.1+, External scripting = Local | `get_resolve_status`, `get_whats_new`, `search_scripting_api`, `get_scripting_api`, `get_scripting_docs`, `launch_resolve`, `run_script`, `run_script_unsafe` |
| `community` (fallback) | `davinci-resolve-mcp` npm bootstrapper | Node.js (`npx`) + Resolve 18.5+ | 37 compound tools (projects, media pool, timeline editing, grading, Fusion, Fairlight, render, analysis) |

With `mode: auto` (the default) the bundle picks the native server when its executable exists
and falls back to the community server otherwise. If neither is available the plugin logs a
warning and registers nothing — the rest of DSH boots normally.

## Install

Install `@xtremestuff/dsh-plugin-resolve` from the npm registry into your profile:

```sh
dsh plugin --profile <name> add @xtremestuff/dsh-plugin-resolve
```

(`<name>` is the profile to extend, e.g. `web` or `desktop`.) Equivalently, use the DSH
Plugins page / `plugin_manager` tool (`install_bundle` with `@xtremestuff/dsh-plugin-resolve`),
or run `pnpm add @xtremestuff/dsh-plugin-resolve` inside `~/.dsh/profiles/<name>`.

The `dsh plugin` forwarder records the dependency and adds the bundle to the profile's
`dsh.profile.bundles` layer list automatically. After installation the bundle is enabled;
DSH reconciles the profile on the next start (or immediately in a live profile).

Verify:

```
Plugins → @xtremestuff/dsh-plugin-resolve   (enabled)
Settings → MCP servers                      (a "resolve" entry appears, registered by the plugin)
```

Then ask an agent:

> Use the Resolve MCP to report whether Resolve is running and its version. Tell me the name
> of the open project and how many timelines it contains. Do not change anything yet.

### Local or development install

To install from a checkout (e.g. while developing the bundle), pass the directory path to the
same command:

```sh
dsh plugin --profile <name> add /path/to/dsh-plugin-resolve
```

DSH records it as a `link:` dependency; edits to the directory are picked up without
re-publishing.

## Usage

There is nothing to invoke: once the bundle is enabled, Resolve's tools sit in every agent's
tool list as `mcp__resolve__<tool>` and the agent picks them up whenever your task involves
Resolve. Just have a project open in Resolve (or ask the agent to launch it) and talk.

### Native backend (Resolve Studio 21.1+)

The native server is a thin, deliberate surface: discover the scripting API, then act through
`run_script`. Typical flow per task:

1. **Status** — *"Is Resolve running, and which project is open?"*
   (`mcp__resolve__get_resolve_status`; `mcp__resolve__launch_resolve` starts it if closed)
2. **Discover** — *"Which scripting API calls exist for adding markers to a timeline?"*
   (`mcp__resolve__search_scripting_api` / `mcp__resolve__get_scripting_api`)
3. **Act** — the agent writes and runs a script against the live session
   (`mcp__resolve__run_script`)

Examples:

> Add a blue marker at the start of every clip on the timeline named `Cut_v4`, then read back
> the marker count.

> Queue a ProRes 422 HQ render of the current timeline to `~/Movies/deliver` and report the job
> id.

> Rename every clip in the `Interviews` bin to `CAMERA_SCENE_TAKE` from its file metadata.

### Community backend

The compound server ships guarded workflow tools, so most tasks need no scripting at all — the
agent calls one named tool, and destructive operations run through a plan → review → confirm
gate:

> List all projects and open the one called `My Film`.

> Create a timeline called `Assembly Cut` from all clips in the current bin.

> Probe this timeline for gaps, overlaps, and missing media, and list what needs fixing.

> Build a ProRes 422 HQ render plan for this timeline, validate the settings, and queue the job.

> Copy the review markers from the timeline to the selected clip and export a review report.

### Working habits that pay off

- **Name things explicitly** — "the timeline named `Cut_v4`", not "this timeline".
- **Ask for a plan before execution** on anything destructive, and work on a **duplicated**
  timeline until you trust the agent.
- **Verify in Resolve** after write actions — a successful tool call should be followed by a
  read-back check that the intended clips, ranges, or tracks actually changed.

## Requirements

- **Native backend:** DaVinci Resolve **Studio** 21.1+ (the native MCP server is Studio-only),
  with `Preferences → System → General → External scripting` set to **Local**.
  Default executable locations:

  | OS | Path |
  |---|---|
  | macOS | `/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP` |
  | Windows | `C:\Program Files\Blackmagic Design\DaVinci Resolve\ResolveMCP.exe` |
  | Linux | `/opt/resolve/bin/ResolveMCP` |

- **Community backend:** Node.js ≥ 20.9 on `PATH` (the bundle launches
  `npx -y davinci-resolve-mcp`) and a Python 3.10+ environment the bootstrapper can set up
  (it installs a managed copy under your user application-data directory on first run).

## Configuration

All options are optional row config on the `resolve-mcp` entry in
[`cordis.patch.yml`](./cordis.patch.yml) (edit the installed copy, or overlay from your
profile's own `cordis.patch.yml`):

| Key | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `auto` (native, else community), `native`, or `community` |
| `serverName` | `resolve` | Tool namespace: `mcp__<serverName>__<tool>`; must match `[A-Za-z0-9_-]{1,32}` |
| `nativeCommand` | per-OS default | Path to the `ResolveMCP` executable |
| `communityCommand` | `npx` | Bootstrapper executable (resolved against `PATH`) |
| `communityArgs` | `['-y', 'davinci-resolve-mcp']` | Bootstrapper arguments |
| `env` | — | Extra environment variables for the server process |
| `cwd` | — | Working directory for the server process |
| `toolCallTimeoutMs` | 60 000 | Per tool-call timeout |
| `startupTimeoutMs` | — | Budget for connection + initial tool discovery |
| `closeTimeoutMs` | 5 000 | Transport closure budget |

Example — force the community server with a pinned package version:

```yaml
- id: resolve-mcp
  name: '@xtremestuff/dsh-plugin-resolve'
  config:
    mode: community
    communityArgs: ['-y', 'davinci-resolve-mcp@4.19.3']
```

## How it works

1. The bundle's [`cordis.patch.yml`](./cordis.patch.yml) mounts the plugin in
   [`lib/index.js`](./lib/index.js).
2. The plugin picks the backend (native `ResolveMCP` or the community bootstrapper) and
   registers its tools on the harness tool runtime, mirroring Blackmagic's own MCPB
   distribution (`DaVinciResolve.mcpb`):
   - **Native:** the tool catalog comes from a one-shot `--dump-tools` invocation at
     activation (no persistent process); the server spawns lazily on the first tool
     call, is killed after 5 minutes of idle, and respawns on demand.
   - **Community:** the bootstrapper runs persistently and its tools are discovered over
     a live MCP handshake at activation.
3. Tools are registered as `mcp__resolve__<tool>` with per-call timeouts and cancellation
   support.
4. The registration is lifetime-scoped: disabling or uninstalling the bundle disposes the
   transport and withdraws its tools.

## Safety notes

- `run_script` (native server) executes Python with the scripting API's privileges;
  `run_script_unsafe` adds system access. Prefer the community server's guarded workflow tools
  for destructive work — they implement plan → review → confirm gates and refuse
  verified-destructive operations (e.g. `TimelineItem.CopyGrades`) until you acknowledge.
- Treat project names, client names, and file paths as data leaving your machine when your LLM
  is a cloud model.
- Work on a duplicated timeline until you trust an agent with write access.

## License

MIT
