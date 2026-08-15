# Configuration

The prototype intentionally keeps configuration in the caller's environment.
Do not commit a populated `.env`, DSH profile, session, or credential store.

## Required runtime state

- `DSH_HOME`: private absolute DSH home. The Windows runner refuses to use a
  legacy implicit home fallback.
- `dsh` on `PATH`, unless `PI_DSH_COMMAND` supplies another command name/path.
- PowerShell 7 (`pwsh`) on Windows for the built-in runner.

## Task runner

| Variable | Meaning |
| --- | --- |
| `PI_DSH_COMMAND` | Optional DSH command/path passed to the PowerShell runner. |
| `PI_DSH_TIMEOUT_MS` | Task timeout, bounded to 1–1,800,000 ms. Invalid values fail fast. |
| `PI_DSH_RUNNER_COMMAND` | Optional replacement process for tests or another adapter. |
| `PI_DSH_RUNNER_ARGS` | JSON array of argv strings for that replacement process. |

`dsh_call` also accepts absolute `workspace` and optional absolute `dshHome`
arguments. Commands and paths are passed as argv values; the implementation does
not build a shell command line. `PI_DSH_RUNNER_COMMAND` and
`PI_DSH_RUNNER_ARGS` are honored by the normal task path for adapter tests.

## Web/API debug session

`dsh_debug` always creates a fresh Web profile under a temporary DSH home. It
never attaches to or restarts the user's existing Web process. The temporary Web
process acquires the same workspace lock domain as `dsh_call`, using the original
`DSH_HOME`, and releases it only after the child exits.

- `agentPreset` is optional; when omitted, DSH selects its own default.
- `provider` and `model` must be supplied together.
- `reasoningEffort` requires both `provider` and `model`.
- `saveTrace` defaults to `false`; when enabled it writes only a structural JSON
  summary. It does not write raw event frames, prompts, tool results, or hidden
  reasoning. `includeReasoningFingerprint` is separately opt-in.
- `lockTimeoutSeconds` bounds how long the Web child waits for the workspace lock.
- `PI_DSH_COMMAND` is used by both `dsh_call` and `dsh_debug`.

The Web/API listener binds to loopback on a random port without an application
login. Treat this as a trusted local-process feature: another process running as
the same user could potentially observe the short-lived listener. The child
inherits the caller environment so DSH credential resolution continues to work;
do not enable the extension in an untrusted Pi session.

## Health probe

By default `dsh_smoke` runs the no-model equivalent of `dsh --version`. It may
retry a fresh probe at most twice. It never receives a user task and never
replays a failed `dsh_call`.

| Variable | Meaning |
| --- | --- |
| `PI_DSH_HEALTH_COMMAND` | Optional explicit health executable. |
| `PI_DSH_HEALTH_ARGS` | JSON array of argv strings for that executable. |

A custom health command is an explicit trust decision: the package validates the
argv shape and bounds, but cannot prove that an arbitrary external command is
read-only. Keep custom probes limited to version/configuration/handshake checks.
Health failures return only a bounded classification (`timed out`, `terminated`,
or exit code), not raw stderr.

## Failure and restart semantics

- startup/health probe: bounded fresh-child retry is allowed;
- accepted task: one child invocation, no implicit retry or replay;
- timeout/cancel: terminate the owned process tree;
- user's DSH Web process: never claimed, restarted, or resumed by this prototype;
- debug Web process: only the fresh child owned by this invocation is cleaned up;
- DSH session: process-local state is not restored after a fresh child.
