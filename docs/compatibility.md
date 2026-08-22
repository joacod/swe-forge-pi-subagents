# Compatibility and safety boundary

This package is a deliberately narrow Pi `SUBAGENTS` execution primitive. It
projects live SWE-Forge sources and starts one bounded child process; it does
not provide workflow orchestration, worktrees, a sandbox, retries, or delivery
automation.

## Tested matrix

| Component | Tested assumption |
| --- | --- |
| Node.js | 24.15.0 in the local validation environment; package floor is 22.19.0 because the supported Pi line has that engine floor |
| Pi package/API | `@earendil-works/pi-coding-agent` 0.84.2 from the package development install; minimum-version behavior is covered by compatibility fixtures for 0.84.1 |
| Pi CLI | 0.84.2 from the package development install and the host's installed CLI; the public CLI/event surfaces were checked against the current docs |
| Pi compatibility line | `>=0.84.1 <0.85.0`; the package declares Pi core packages as `*` peers, while the runtime probes each configured child invocation before use, caches successful matching checks per host process, and fails closed when the version cannot be read or is outside this line |
| Capability protocol | `protocolVersion: 1`; independent from `packageVersion` |
| Advertised isolation | context/process isolation true; filesystem isolation and OS sandbox false |
| Supported profiles | `READ_ONLY`, `WRITABLE` |
| Worker result bound | 64 KiB maximum model-visible canonical result; oversized results fail closed without returning a truncated canonical value |
| SWE-Forge fixture | 0.1.0-alpha.1, with the live canonical root shape required by discovery |
| SWE-Forge compatibility line | `0.1.x`; malformed or outside-line `VERSION` values fail before role/contract projection |
| Platforms | macOS was exercised. POSIX cancellation uses a detached process group; Windows uses direct termination plus best-effort `taskkill /T /F`. Windows and Linux remain portability targets, not fully exercised release claims. |

The SWE-Forge version policy is intentionally conservative. This adapter does
not claim exact semantic compatibility with arbitrary future roles, contracts,
or policy revisions. It accepts only the tested 0.1.x line, validates the
required contract shape, and reports an explicit compatibility error for an
unknown or unsupported version. It loads the installed files at runtime and
does **not** pin or bundle canonical roles/contracts.

Successful Pi compatibility probes are cached in memory for the host process
and keyed by the configured invocation; in-flight matching calls share the
probe, while failed checks are evicted and retried. Runtime details may include
queue-wait, child-startup, agent, and total durations, turn count, and final
assistant usage fields. These optional diagnostics are small, non-model-visible
metadata and are never part of canonical worker result text.

## Canonical installation boundary

Runtime discovery uses only `~/.pi/agent/swe-forge/`. `SWE_FORGE_ROOT` is an
explicit development/test override; it never falls back to a project-local
`.swe-forge/` tree. A root must contain regular-file targets for `SWE-FORGE.md`,
`AGENTS.md`, and `VERSION`, plus a `.swe-forge` directory. The root is
normalized through `realpath`; supported-root entries and role files may be
symlinks, but their targets must be readable regular files. Role names are an
allowlisted single path segment, so absolute paths, separators, drive syntax,
`.`/`..`, and NUL bytes are rejected before resolution.

Canonical role files must be non-empty and bounded. The fixed task, result, and
review contracts must contain the fields this adapter validates. The concrete
task and returned output are still treated as untrusted data: duplicate task
IDs or `write_access` declarations conflict, unknown result statuses are
rejected, and output truncated by the transport never becomes a successful
result.

These checks do not eliminate filesystem TOCTOU races or make a user-owned
SWE-Forge installation trustworthy. The installation path is a user-level
trust boundary and should not be replaced with a repository-controlled path.

## Pi child boundary

Each task uses the documented one-shot JSON CLI shape:

- `--mode json --print --no-session`;
- explicit `--model` and optional `--thinking`;
- one closed built-in tool profile (`READ_ONLY` or `WRITABLE`);
- `--no-extensions --no-skills --no-prompt-templates --no-themes`;
- `--no-context-files --no-approve`; and
- an explicit delegation-tool denylist plus a temporary 0600 system-prompt file.

The child has no Pi extension, skill, prompt-template, theme, context-file, or
session inheritance. `--no-approve` follows current Pi project-trust
semantics for the child: untrusted project-local resources are not loaded in
headless execution. This is an input-loading control, **not** an OS sandbox.
The capability protocol reports this explicitly as context/process isolation
without filesystem isolation or an OS/security sandbox; workers retain the
user's normal OS permissions.
Pi and its built-in tools retain the invoking user's filesystem permissions,
and the child inherits the normal environment/configuration needed for model
authentication. Do not run this adapter on an untrusted project without a
real OS/container/VM boundary.

JSONL parsing requires authoritative `message_end`/`agent_end` records.
Current Pi JSON mode emits delta-only `message_update` records, so the adapter
ignores streaming usage and reads usage from the final assistant message in
`message_end`/`agent_end`. Plain stdout noise, malformed event lines, oversized
event lines, stream errors, non-zero exits, missing assistant results, truncated
or over-limit assistant output, and conflicting canonical assistant results are
reported as failed runtime evidence. Stderr is retained only as bounded process
diagnostics; it is not treated as a worker result. A canonical `BLOCKED` or
`FAILED` result remains data with that status and is never upgraded by the
adapter.

The parent signal terminates the child process group on POSIX and waits for
process closure. Windows uses a direct kill and `taskkill` tree request where
available. A child that deliberately escapes its process group or a process
started outside this adapter's scheduler remains an operating-system
responsibility; the runtime reports unresolved process termination rather than
claiming isolation.

## Checkout and trust semantics

The in-process scheduler canonicalizes existing cwd symlinks and provides
shared-read/exclusive-write leases. Writers block readers and other writers in
the same normalized checkout, and canceled waiters are removed. The lock is
process-local: it is not a worktree, OS lock, cross-process lock, or substitute
for SWE-Forge `ISOLATED` execution. The runtime rejects missing/non-directory
cwd values and passes the canonical real path to Pi, so changing a caller's
relative or symlinked cwd cannot silently select a different checkout.

`write_access` in a task is checked against the selected profile. Conflicting
metadata fails closed. A writable child has the invoking user's normal write
and shell permissions; `READ_ONLY` restricts model-visible Pi tools but cannot
restrict arbitrary OS access outside those tools.

## Package/API dependencies

Pi core packages are peers and are not bundled. `typebox` is a runtime peer for
the tool schema; `@earendil-works/pi-coding-agent` is the typed Pi extension
peer. Both use the Pi convention of a `*` peer range; the runtime compatibility
check is the actual guard for the tested `>=0.84.1 <0.85.0` window. No community
subagent runtime or other production dependency is needed. The build, test,
lint, and format checks use the existing TypeScript/Node toolchain without
adding an unneeded formatter or linter dependency.

`projection.ts` intentionally validates a minimal duplicated
`worker_briefing/v1` wire shape because SWE-Forge does not currently publish a
small versioned schema export. It checks the root-rendered marker/schema,
concrete `task_id`, profile access, `SUBAGENTS` topology, and `SHARED`
write-isolation without rendering or loading the canonical task contract. The
result projection recognizes the current `RESULT_PROFILE`/`FINDINGS`/`EVIDENCE`
shape and the older `SUMMARY`/`VALIDATION` fixture shape within the tested
0.1.x line; it does not define or bundle either contract. This is deferred
technical debt: validation remains fail-closed until a low-coupling canonical
schema boundary exists.

When updating Pi or SWE-Forge, rerun the repository tests, package-install
smoke test, and a fixture-backed child invocation. If a public flag, event
shape, trust behavior, or canonical contract changes, update the compatibility
policy and adapter deliberately; do not guess or silently widen the ranges.

## Real cross-repository acceptance

The release harness is opt-in because A-D invoke real model calls and Scenario
C writes to a disposable temporary checkout:

```bash
cd /path/to/swe-forge
scripts/swe-forge install pi
scripts/swe-forge verify pi

cd /path/to/swe-forge-pi-subagents
npm install
pi install /path/to/swe-forge-pi-subagents
npm run build
SWE_FORGE_ACCEPTANCE_MODEL=provider/model \\
  SWE_FORGE_ACCEPTANCE_REPO=/path/to/swe-forge \\
  SWE_FORGE_ACCEPTANCE_PACKAGE=/path/to/swe-forge-pi-subagents/src/index.ts \\
  npm run acceptance -- --scenario all
```

The harness creates temporary run state and checkouts, exercises real Pi and
canonical SWE-Forge capability negotiation for A-D, and removes those paths by
default. Model resolution checks, in order, `SWE_FORGE_ACCEPTANCE_MODEL`,
non-empty `PI_PROVIDER` plus `PI_MODEL`, and then `defaultProvider` plus
`defaultModel` from Pi's `settings.json`. The settings file is read-only
fallback configuration: CI may set `PI_CODING_AGENT_DIR` to the directory that
contains it, otherwise `$HOME/.pi/agent` is used. Settings contents and
credentials are not logged. Model selection does not provide authentication;
Pi authentication is still required for A-D. Without a resolved model, A-D
are reported as skipped unless `SWE_FORGE_ACCEPTANCE_REQUIRED=1` is set; use
that variable when skipped acceptance must fail. E and F remain runnable
without a model. E uses the built runtime with malformed child output; F runs
the Pi-adapter fixture that proves `ISOLATED` protection. Run an individual
scenario with `--scenario A` through `--scenario F`.
