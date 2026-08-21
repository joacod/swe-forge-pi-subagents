# Compatibility and safety boundary

This package is a deliberately narrow Pi `SUBAGENTS` execution primitive. It
projects live SWE-Forge sources and creates one bounded in-process Pi
`AgentSession`; it does not provide workflow orchestration, worktrees, a
sandbox, retries, or delivery automation.

## Tested matrix

| Component | Tested assumption |
| --- | --- |
| Node.js | 24.15.0 locally; package floor is 22.19.0 |
| Pi SDK/package | `@earendil-works/pi-coding-agent` 0.84.2; supported peer range `>=0.84.1 <0.85.0` |
| SWE-Forge fixture | 0.1.0-alpha.1, with the live canonical root shape required by discovery |
| Capability protocol | `protocolVersion: 1`, independent from `packageVersion` |
| Advertised isolation | context isolation true; process isolation, filesystem isolation, and OS sandbox false |
| Supported profiles | `READ_ONLY`, `WRITABLE` |
| Worker result bound | 64 KiB maximum canonical result; oversized results fail closed |
| Platforms | macOS exercised; Linux and Windows remain portability targets |

The Pi compatibility boundary is the public SDK used by `createAgentSession`,
`ModelRuntime`, `SessionManager.inMemory`, `SettingsManager.inMemory`, and
`ResourceLoader`. The package declares the tested peer range and does not
silently select a fallback runtime or spawn a different Pi executable.

SWE-Forge compatibility remains conservative. The adapter accepts only the
live 0.1.x support line, validates the required contract shape, and reports an
explicit compatibility error for an unknown or unsupported version. It loads
installed files at runtime and does not pin or bundle canonical roles or
contracts.

## Canonical installation boundary

Runtime discovery uses only `~/.pi/agent/swe-forge/`. `SWE_FORGE_ROOT` is an
explicit development/test override; it never falls back to a project-local
`.swe-forge/` tree. A root must contain regular-file targets for
`SWE-FORGE.md`, `AGENTS.md`, and `VERSION`, plus a `.swe-forge` directory. The
root is normalized through `realpath`; role names are allowlisted single path
segments and unsafe names are rejected before resolution.

Canonical role files and fixed contracts are bounded and validated. The
concrete task and returned output remain untrusted data: duplicate task IDs or
`write_access` declarations conflict, unknown result statuses are rejected,
and output above the bound never becomes a successful result.

## In-process Pi child boundary

Each invocation creates fresh, non-persisted state:

- a new `ModelRuntime` using the normal Pi auth/model configuration, with model
  network refresh disabled;
- a new `SettingsManager.inMemory()` with compaction and retry disabled;
- a new `SessionManager.inMemory(cwd)`;
- a minimal `ResourceLoader` containing only the composed canonical system
  prompt; and
- a new `AgentSession` with the explicit model, thinking level, tool allowlist,
  and delegation denylist.

The resource loader returns no extensions, skills, prompt templates, themes, or
context files. The session receives no parent messages or session history.
The user/project checkout and host process are shared by design.

The capability protocol therefore reports:

```json
{
  "contextIsolation": true,
  "processIsolation": false,
  "filesystemIsolation": false,
  "osSandbox": false
}
```

`WRITABLE` workers retain the invoking user's normal write and shell
permissions. This package is not a security boundary; use a worktree,
container, VM, or OS sandbox for untrusted projects. SWE-Forge `ISOLATED`
execution remains outside this package.

## Model, tools, and resources

The caller must supply a concrete `provider/model` identifier. The child
runtime resolves that identifier through its fresh `ModelRuntime`; it does not
fall back to parent settings or silently choose another model. Runtime-only
provider registrations and API keys held by the parent extension context are
not inherited.

The two exact model-visible profiles are:

| Profile | Tools |
| --- | --- |
| `READ_ONLY` | `read`, `grep`, `find`, `ls` |
| `WRITABLE` | read-only tools plus `edit`, `write`, `bash` |

The runtime also excludes `subagent` and `swe_forge_subagent`. The package does
not load extensions, so recursive delegation cannot be introduced by inherited
resources. A canonical task's concrete `write_access` metadata must agree with
the selected profile.

## Lifecycle, output, and diagnostics

The runtime subscribes only to bounded lifecycle events. It ignores streaming
text deltas, waits for the session to settle, and extracts the last assistant
message from the settled run. Intermediate assistant messages are never
returned as canonical output. Final assistant usage, when present, is reported
as non-model-visible diagnostics.

Diagnostics may include `queueWaitDurationMs`,
`sessionInitializationDurationMs`, `agentExecutionDurationMs`,
`totalRuntimeDurationMs`, `turns`, and final usage fields. They never duplicate
canonical output or expose a transcript.

A final result above 64 KiB fails closed and returns no partial canonical text.
A malformed result, provider failure, aborted run, or missing assistant result
also remains non-success. The task runtime validates the final text against the
selected canonical result/review contract; SWE-Forge remains responsible for
interpreting status, evidence, and workflow outcomes.

Cancellation calls `AgentSession.abort()`, waits for idle, releases the
checkout lease, and disposes the session. Cancellation is never upgraded to a
successful result. Cleanup is attempted on provider errors and session
initialization failures as well.

## Checkout and trust semantics

The in-process scheduler canonicalizes existing cwd symlinks and provides
shared-read/exclusive-write leases. Readers may overlap; a writer waits for
active readers and other writers, then excludes readers until it finishes.
Canceled waiters are removed. The lock is process-local and is not a worktree,
OS lock, cross-process lock, or substitute for `ISOLATED` execution.

Installing a Pi package runs extension code with full user permissions. Trust
both this package and the installed canonical SWE-Forge support root. Child
output is untrusted model data and never proves that Git, tests, evidence,
integration, or delivery actions occurred.

## Package/API dependencies

`@earendil-works/pi-coding-agent` is a peer in the tested public SDK range and
`typebox` remains a Pi-supplied runtime peer. No community subagent runtime or
other production orchestration dependency is bundled.

`projection.ts` intentionally validates a minimal duplicated wire shape because
SWE-Forge does not currently publish a small versioned schema export. The
runtime recognizes the current result/review shape and fails closed when the
live contract or output drifts.

## Real cross-repository acceptance

The opt-in harness exercises the real Pi host and canonical support root. A-D
may invoke real model calls; Scenario C writes only to a disposable checkout;
E uses a deterministic malformed in-process session; and F runs the main Pi
adapter topology-protection fixture:

```bash
cd /path/to/swe-forge-pi-subagents
npm install
npm run build
npm test
npm run acceptance -- --scenario E
```

A-D are skipped unless a model is configured through
`SWE_FORGE_ACCEPTANCE_MODEL`, `PI_PROVIDER` plus `PI_MODEL`, or Pi settings.
Set `SWE_FORGE_ACCEPTANCE_REQUIRED=1` when a skipped real-model acceptance run
must fail. For a release check, also run the relevant main SWE-Forge fixture
and inspect the negotiated `processIsolation: false` capability.
