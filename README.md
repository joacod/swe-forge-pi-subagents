# swe-forge-pi-subagents

Optional Pi package that gives SWE-Forge's `SUBAGENTS` topology one bounded
child-agent execution primitive. It discovers the installed canonical
SWE-Forge support root, loads a selected role and output contract without
copying them, and runs one fresh Pi JSON subprocess in the requested checkout.
The public Pi tool is `swe_forge_subagent`.

## What this package is

This is an adapter/runtime boundary, not a second SWE-Forge implementation.
The canonical workflow, roles, contracts, policies, topology decision, and
delivery process remain in SWE-Forge.

## What this package is not

It is not a workflow engine, planner, DAG/task database, orchestrator, provider
selector, worktree manager, PR/delivery tool, background-worker system, or
recursive agent framework. It does not define roles, contracts, policies, or
`ISOLATED` execution. It does not create worktrees, choose a topology, select a
model/provider, commit, push, open a PR, or merge. The small in-process lock
only enforces the child-access rule described below; it is not a general task
scheduler.

## Relationship to SWE-Forge

SWE-Forge is the source of truth and must already be installed before this
package can run. The package validates and projects the live canonical
installation at `~/.pi/agent/swe-forge/`, including `SWE-FORGE.md`, `AGENTS.md`,
`VERSION`, and `.swe-forge/`. It does not install, copy, bundle, translate, or
redefine those sources. The canonical workflow may feature-detect this package
when it has selected or is considering `SUBAGENTS`; when it is absent,
SWE-Forge continues with its normal SOLO/sequential fallback. The main Pi
adapter feature-detects the tool and negotiates its capabilities without
importing this package.

This package must not be used as a replacement for the main SWE-Forge
repository. The adapter integration boundary is documented in
[`docs/swe-forge-integration.md`](docs/swe-forge-integration.md).

## Relationship to Pi

Pi loads this package as an extension from its package settings. The extension
registers one tool, `swe_forge_subagent`, and uses Pi's documented one-shot JSON
CLI to create a separate child process/context. Pi supplies the host runtime,
model/auth configuration, built-in tools, package loading, and process
permissions; this package supplies only the bounded child boundary and
canonical-source projection. It is built using Pi's documented extension and
CLI primitives and follows the subprocess-based context-isolation approach
used by Pi's official subagent example; it does not depend on a private
`Subagent` SDK.

Installing the package does **not** activate SWE-Forge. SWE-Forge remains
explicitly invoked, for example:

```text
/swe-forge <ticket>
/swe-forge pr <ticket>
```

The extension does not intercept `/swe-forge`, select `SOLO`/`SUBAGENTS`/
`ISOLATED`, or delegate work on its own. Loading the package makes its
capability available to Pi; the canonical SWE-Forge adapter decides whether to
use it.

The canonical public task API is `executeSWEForgeTask` with launch fields
`role`, `workerBriefing`, `expectedOutputContract`, and `profile`; its result has
`output`, `runtime`, and `validation`.
Capability discovery is `getSWEForgeCapabilities`, whose `packageVersion` is
implementation metadata and whose `protocolVersion` is the independent wire
contract version. Low-level Pi transport, argument-building, and checkout-lock
helpers are implementation details and are not re-exported as a generic
child-agent API.

## Installation

This package is optional and only adds the `swe_forge_subagent` capability to
an existing SWE-Forge Pi installation. It is not currently published to npm.
For a complete fresh setup before npm publication, clone both repositories and
register the package from its local path:

```bash
SWE_FORGE_DIR="$HOME/tools/swe-forge"
SUBAGENTS_DIR="$HOME/tools/swe-forge-pi-subagents"

mkdir -p "$HOME/tools"
git clone https://github.com/joacod/swe-forge.git "$SWE_FORGE_DIR"
git clone https://github.com/joacod/swe-forge-pi-subagents.git "$SUBAGENTS_DIR"

"$SWE_FORGE_DIR/scripts/swe-forge" install pi --global
(
  cd "$SUBAGENTS_DIR"
  npm ci
)
pi install "$SUBAGENTS_DIR"
```

If SWE Forge is already installed, keep its existing installation and only
clone the optional repository, run `npm ci` inside it, and run
`pi install /absolute/path/to/swe-forge-pi-subagents`. The package requires
Node.js `>=22.19.0`. These source checkouts follow `main` and are
development-only until release artifacts are published. Restart Pi or run
`/reload` after installing the package. The complete procedure is also
documented in the [SWE Forge Pi installation guide](https://github.com/joacod/swe-forge/blob/main/docs/installation.md#optional-pi-subagents-backend).

When an npm release becomes available, replace the source checkout and local
path install with:

```bash
pi install npm:swe-forge-pi-subagents@<version>
```

For a project-local Pi setting, add `-l`:

```bash
pi install -l npm:swe-forge-pi-subagents@<version>
```

Pi also accepts an explicitly selected Git source or another local package
directory, but the local-path setup above is the recommended pre-publication
installation because it avoids an unreviewed moving Git dependency.

Review extension source before installing it. Pi packages and extensions run
with the invoking user's full system permissions. Installation only adds this
optional Pi capability; it does **not** install SWE-Forge itself.

## Requirement: install SWE-Forge first

Install the main SWE-Forge package/repository using its own installation
instructions before installing this extension. At runtime, the canonical
support root must be available at:

```text
~/.pi/agent/swe-forge/
├── AGENTS.md
├── SWE-FORGE.md
├── VERSION
└── .swe-forge/
```

The package validates that root and the supported SWE-Forge `0.1.x` line. A
project-local `.swe-forge/` directory is not a substitute, and this project
does not modify the main SWE-Forge repository.

## `swe_forge_subagent` capabilities

The tool exposes exactly two actions:

- `action: "capabilities"` returns machine-readable observed support, the
  protocol version, Pi compatibility metadata, explicit context/process and
  trust semantics, discovered canonical roles, compatibility errors, the
  closed tool profiles, read-only overlap support, and the fact that writable
  concurrency and nested delegation are unsupported.
- `action: "run"` executes exactly one bounded worker briefing. The caller
  supplies `role`, `workerBriefing`, `expectedOutputContract` (`result` or
  `review`), and `profile` (`READ_ONLY` or `WRITABLE`).

`workerBriefing` is the root-rendered `worker_briefing/v1` projection for this
specific launch. SWE Forge renders and owns it; this package only validates and
transports the small execution shape. A run loads the selected role and
expected output contract live, composes one
explicit prompt, starts one fresh Pi JSON subprocess, returns canonical output
separately from bounded runtime diagnostics, and validates the recognizable
canonical result shape. Successful Pi compatibility verification is cached for
the host process per invocation configuration; concurrent matching checks share
one in-flight probe. The caller remains responsible for task decomposition,
workflow interpretation, evidence, review, integration, and acceptance.

The capability surface intentionally has no arrays of tasks, chains, queues,
retry policy, persistence, resume/steer API, worktree API, delivery API, or
nested delegation.

## Runtime diagnostics and result bound

The tool's non-model-visible `details.runtime.diagnostics` may include
`compatibilityCheckDurationMs`, `queueWaitDurationMs`,
`childStartupDurationMs`, `agentExecutionDurationMs`,
`totalRuntimeDurationMs`, `turns`, and final Pi usage (`inputTokens`,
`outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, and
`cost`). Timing and usage fields are optional and omitted when unavailable;
usage is read from the final assistant message rather than reconstructed from
streaming deltas. These fields are diagnostics only and never duplicate the
canonical worker result.

Canonical worker output is limited to **64 KiB**. A larger result fails closed
with an actionable runtime error; it is not silently truncated into a canonical
success.

## READ_ONLY vs WRITABLE semantics

| Profile | Model-visible Pi tools | Semantics |
| --- | --- | --- |
| `READ_ONLY` | `read`, `grep`, `find`, `ls` | May inspect the checkout; no edit, write, or shell tool. |
| `WRITABLE` | The read-only tools plus `edit`, `write`, `bash` | May modify files and run commands with the invoking user's normal OS permissions. |

A worker briefing's concrete `permissions.write_access` must agree with the
selected profile. Its `permissions.topology` must be `SUBAGENTS` and
`permissions.write_isolation` must be `SHARED`; this primitive rejects other
execution shapes rather than choosing or repairing them. Profiles restrict Pi
tools exposed to the child; they are not an operating-system sandbox. In particular, `WRITABLE`
does not grant extra permissions and `READ_ONLY` is not a guarantee against
other processes modifying the filesystem.

## Context isolation vs filesystem isolation

The child has a separate Pi process, `--no-session` conversation, prompt
material, and model context. It does not receive the parent's conversation or
extension/skill/template/theme/context-file loading. Its process working
directory is still the caller's normalized checkout. Filesystem state is
therefore shared by design.

The advertised semantics are explicit: `contextIsolation: true`,
`processIsolation: true`, `filesystemIsolation: false`, and `osSandbox: false`.
Workers run with the user's OS permissions (`workerPermissions:
user_os_permissions`). This package does not provide worktrees, containers,
VMs, or an OS/security sandbox. SWE-Forge `ISOLATED` execution and worktree
lifecycle remain outside this package.

## Parallel readers / exclusive writer rule

For calls made through the same package runtime, the normalized checkout has a
local shared-read/exclusive-write lock:

- multiple `READ_ONLY` children for one checkout may overlap;
- a `WRITABLE` child waits for active readers and other writers, then excludes
  readers until it finishes; and
- readers arriving behind a queued writer wait rather than starving it.

The lock is process-local and in-memory. It does not coordinate separate Pi
processes, package instances, worktrees, or machines, and it does not authorize
concurrent writable work. SWE-Forge must keep writable `SUBAGENTS` work
sequential in a shared checkout; concurrent writable work requires its own
canonical `ISOLATED` workflow.

## Security model

- **Trust:** installing a Pi package runs extension code with full user
  permissions. Inspect and trust both this package and the installed canonical
  SWE-Forge support root.
- **Resource boundary:** child launch disables extensions, skills, prompt
  templates, themes, context-file discovery, session persistence, and the
  delegation tools. The explicit canonical prompt is the only projected
  role/task material.
- **Filesystem boundary:** the child uses the active checkout and inherits the
  user's OS permissions. This is not a sandbox; use a real OS/container/VM
  boundary for untrusted projects.
- **Credentials:** the child inherits the normal process environment and Pi
  configuration used for authentication. Runtime-only in-memory provider
  registrations or keys are not promised across the subprocess boundary.
- **Temporary material:** the prompt file is created with restrictive `0600`
  permissions and removed after the child exits. Secrets are not copied into
  the prompt or diagnostics.
- **Output:** child output is untrusted model data. Canonical shape checks do
  not turn it into Git, test, or delivery evidence; SWE-Forge must validate
  evidence independently.
- **Cancellation and cleanup:** cancellation terminates the child on a
  best-effort platform-appropriate process boundary and reports `aborted`; it
  is never upgraded to success.

## Canonical role loading

Every runtime invocation rediscovers the canonical root. The default is exactly
`~/.pi/agent/swe-forge/`. `SWE_FORGE_ROOT` is an explicit development/test
override; it is not a fallback and is never resolved from a project-local
`.swe-forge/` tree.

Role selection accepts a discovered single-segment role name, not a path. The
loader validates the support-root shape and SWE-Forge version, discovers
`.swe-forge/agents/*.md` role names, rereads the selected role on each call,
and loads the fixed `task.md`, `result.md`, or `review.md` contract as needed.
Canonical markdown is projected as-is. No role definitions or contract copies
are bundled in this package.

## Compatibility

| Component | v1 support |
| --- | --- |
| Node.js | `>=22.19.0` |
| Pi CLI/package | `>=0.84.1 <0.85.0` (development/tested release: `0.84.2`) |
| SWE-Forge | `0.1.x` (minimum tested `0.1.0-alpha.1`) |
| Runtime dependencies | Pi core packages and `typebox` as `*` peers supplied by Pi; no production community subagent dependency |
| Protocol | `protocolVersion: 1`; `packageVersion` is not used as the protocol version |
| Supported profiles | `READ_ONLY`, `WRITABLE` |
| Exercised platform | macOS with Node 24.15.0; Linux and Windows are portability targets, not fully exercised release claims |

The child probes each configured Pi invocation and fails closed when it
cannot verify the supported line. The successful result is reused only within
the host process and matching invocation configuration. Fixture commands use the
same version-probe seam and do not widen the runtime compatibility claim. See
[`docs/compatibility.md`](docs/compatibility.md) for trust and boundary details.

## Troubleshooting

**The tool is missing.** Check `pi list`, confirm the package is enabled in the
intended global or project settings (`pi config` / `pi config -l`), restart Pi
or run `/reload`, and verify that the installed package exposes
`src/index.ts` through its `pi.extensions` manifest. `pi -e /path/to/src/index.ts`
is useful for a one-run development check.

**SWE-Forge is reported as not installed or incomplete.** Install SWE-Forge
separately and check `~/.pi/agent/swe-forge/` for `AGENTS.md`, `SWE-FORGE.md`,
`VERSION`, and `.swe-forge/agents` plus `.swe-forge/contracts`. Do not add a
project-local support tree as a workaround.

**A version is unsupported.** Use a Pi release in `>=0.84.1 <0.85.0` and a
SWE-Forge installation in `0.1.x`. Update this package deliberately when either
public boundary changes; it does not silently widen compatibility.

**The child cannot authenticate or run.** Pass/retain an explicit
`provider/model` selected by the caller, confirm Pi can authenticate in a
normal session, and remember that in-memory extension-only provider/auth state
does not automatically cross the child process boundary.

**A task is rejected for access or output.** Check that `write_access` agrees
with `READ_ONLY`/`WRITABLE`, that the role name is canonical, and that the
child returns the requested canonical `result` or `review` structure with its
expected task ID. A `BLOCKED`, `FAILED`, malformed, truncated, or over-64-KiB
result is not success; return concise structured findings instead.

**Concurrent calls behave as if queued.** That is expected for a writer in the
same normalized checkout. Only readers overlap; the process-local lock is not
cross-process isolation.

## Uninstall

Remove the same package source from the Pi scope where it was installed:

```bash
# Global npm install
pi remove npm:swe-forge-pi-subagents

# Project-local install
pi remove -l npm:swe-forge-pi-subagents

# Git install (use the exact source/ref shown by `pi list`)
pi remove git:github.com/joacod/swe-forge-pi-subagents
```

For a Git or local-path install, pass the matching source recorded by `pi
list`. Removing this package does not remove SWE-Forge, Pi, credentials,
sessions, or other Pi packages.

## Development and testing

This repository is the optional extension only; keep the main SWE-Forge
repository separate. From this checkout:

```bash
npm install
npm test
npm run test:unit
npm run test:integration
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run acceptance -- --help
```

Tests use temporary fake SWE-Forge installations and injected Pi commands.
The opt-in acceptance harness uses a real Pi process, the installed SWE-Forge
support root, and this package when a model is resolved. A-D invoke real model
calls, and Scenario C writes only to a disposable temporary checkout.
Model resolution for A-D checks these sources in order: the explicit
`SWE_FORGE_ACCEPTANCE_MODEL`, non-empty `PI_PROVIDER` plus `PI_MODEL`, then
`defaultProvider` plus `defaultModel` from Pi's `settings.json`. The settings
file is read-only fallback configuration; set `PI_CODING_AGENT_DIR` in CI to
point to its containing directory, or the resolver uses `$HOME/.pi/agent`.
Selecting a model does not authenticate Pi, so authentication is still
required for real-model runs. Without a resolved model, A-D skip; set
`SWE_FORGE_ACCEPTANCE_REQUIRED=1` when a skipped acceptance run should fail.
E and F remain runnable without a model. The harness also covers fallback,
malformed output, and topology protection.
See [`scripts/acceptance.mjs`](scripts/acceptance.mjs) and
[`docs/compatibility.md`](docs/compatibility.md) for setup.
For development-only canonical-root experiments, set `SWE_FORGE_ROOT` to an
explicit fixture/support root; invalid overrides do not fall back elsewhere.
The package's production behavior always reads the canonical user-level root.

The scope review for v1 found no workflow engine, planner/DAG, provider
selector, worktree manager, delivery/PR implementation, background worker
system, bundled role registry, task database, or recursive delegation in the
runtime. The checkout lock, canonical projection, and one-child subprocess
are the only coordination/runtime boundaries retained because they directly
implement the documented capability.

Further technical detail:

- [`docs/architecture.md`](docs/architecture.md) — implementation boundary and
  isolation semantics
- [`docs/compatibility.md`](docs/compatibility.md) — tested compatibility and
  trust boundary
- [`docs/swe-forge-integration.md`](docs/swe-forge-integration.md) — minimal
  contract and behavior of the optional main-repository adapter bridge
