# Compatibility boundary

This is an experimental public bridge, not a stability promise for DSH or Pi.
Compatibility is split between the public process supervisor and the private DSH installation.

## Validated in this worktree

| Layer | Observed value | Result |
| --- | --- | --- |
| Node.js | 24.15.0 | Node tests and package smoke pass |
| PowerShell | 7.6.4 (`pwsh`) | profile, lock, cleanup and smoke pass |
| Pi | 0.84.2 | extension discovery/load pass |
| DSH CLI | 0.1.0-rc.6 | `--version` no-model health probe passes |
| DSH Web/API | 0.1.0-rc.6 | isolated `session.create`/model/prompt/history plus event mux probe passes |
| OS adapter | Windows PowerShell + junctions | supported prototype path |

These are test observations, not a guarantee across every patch release. The
manifest currently intends Node 22.19+, Pi 0.84+, and PowerShell 7 on Windows.

## DSH contract used by the adapter

The public package assumes only a small launcher boundary:

- a configured `dsh` command can answer `--version`;
- the Windows runner can pass `--profile`, optional `--patch`, and a task as
  separate argv values;
- the Web profile can bind a caller-selected loopback port and expose the DSH
  ApiProxy RPC methods plus its event mux;
- the debug route can create a fresh session, select a model, prompt it, and read
  bounded history before shutting down its own profile;
- `DSH_HOME` contains the caller's private profiles and state;
- the caller accepts the DSH developer-preview compatibility risk.

The package does not bundle DSH, a profile, credentials, plugins, prompts, or
session files. CLI flags beyond the adapter's tested path are not promised.

## Explicitly unverified

- DSH versions other than the observed 0.1.0-rc.6;
- `@deepseek-ai/dsh-sdk-client` as a backend;
- Linux/macOS profile isolation;
- restoring a DSH Web session after a child restart;
- controlling an already-running user's Web session;
- automatic replay of a task after a crash;
- model-quality or Pro 0813 benchmark equivalence;
- CI coverage on another Windows, Node, Pi, or PowerShell version.

When DSH changes its CLI or profile layout, update the adapter and this table
from a fresh no-model smoke result before enabling task calls.
