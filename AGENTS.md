# Agent Guide

## Scope and ownership

`swe-forge-pi-subagents` is an optional Pi execution capability for SWE Forge's
`SUBAGENTS` topology. It is an adapter/runtime boundary, not another
SWE Forge implementation or a generic child-agent framework.

This repository owns only:

- discovery of the installed canonical SWE Forge support root;
- live projection of one selected canonical role and output contract;
- one bounded Pi child execution with closed tool profiles;
- child transport, cancellation/cleanup, bounded runtime diagnostics, and
  recognizable result validation; and
- the process-local shared-reader/exclusive-writer lock for a normalized
  checkout.

The main [SWE Forge repository](https://github.com/joacod/swe-forge) owns
activation, workflow semantics, topology selection, discovery and delegation
policy, roles, task/result/review contracts, evidence, acceptance, review,
integration, delivery, `ISOLATED` execution, and worktree lifecycle. This
package consumes those definitions; it must not copy, reinterpret, or become a
second owner of them.

## Preserve the runtime boundary

- Start a fresh bounded child context/process. Preserve `--no-session`, the
  lack of parent-session inheritance, explicit model/tool selection, disabled
  extensions/skills/templates/themes/context files, and pre-execution Pi
  compatibility verification.
- Keep the two model-visible profiles closed: `READ_ONLY` is `read`, `grep`,
  `find`, and `ls`; `WRITABLE` adds `edit`, `write`, and `bash`. These are Pi
  tool restrictions, not an OS or filesystem sandbox.
- Keep the distinction explicit: context and process isolation are provided;
  filesystem isolation and OS sandboxing are not. Children use the caller's
  checkout and normal OS permissions. Concurrent writable isolation belongs to
  SWE Forge's canonical `ISOLATED` workflow.
- Project canonical sources live from `~/.pi/agent/swe-forge/`. The explicit
  `SWE_FORGE_ROOT` override is for development/tests; a project-local
  `.swe-forge/` tree is never a fallback. Compatibility ranges and protocol
  metadata are owned by the runtime, `package.json`, and
  [`docs/compatibility.md`](docs/compatibility.md); fail closed rather than
  silently widening them.
- Preserve the bounded canonical worker result; see
  [`docs/compatibility.md`](docs/compatibility.md) for the current limit. Keep
  it separate from runtime diagnostics. Oversized, truncated, malformed,
  `BLOCKED`, or `FAILED` results must not be turned into success, and child
  output is never Git, test, or delivery evidence. Cancellation must remain an
  `aborted` outcome, with best-effort process cleanup and temporary prompt
  cleanup.
- Do not allow nested delegation. The caller remains responsible for task
  decomposition, workflow interpretation, evidence, review, integration, and
  acceptance.
- For calls through the same runtime, allow read-only children to overlap and
  keep writable children exclusive, including fairness for queued writers. The
  lock is in-memory and process-local: it does not coordinate other processes,
  package instances, worktrees, machines, or filesystems, and it is not a
  general scheduler.

## Do not broaden this package

Do not add planners, DAG/task databases, workflow state, generic schedulers,
persistent queues, resume/steer frameworks, provider or model-selection
layers, role registries, copied contracts or policies, PR/delivery features,
worktree management, recursive delegation, or generic Pi transport APIs.
Prefer a small deterministic guard or deletion/consolidation to another
abstraction. A new public capability requires a concrete cross-repository
architectural reason and coordinated compatibility work.

## Evaluated direction: in-process `AgentSession`

Replacing the subprocess runtime with an in-process Pi `AgentSession` was
evaluated in [package PR #15](https://github.com/joacod/swe-forge-pi-subagents/pull/15)
and companion [SWE Forge PR #45](https://github.com/joacod/swe-forge/pull/45).
Those PRs were intentionally closed; the migration was not adopted. Small-task
startup improved, but realistic task performance did not show a reliable enough
improvement and overall/parallel gains were limited. The
in-process boundary also weakened process isolation and worst-case forced
termination/cleanup guarantees; cancellation/lifecycle, retry/compaction, and
system-context behavior differed. The apparent context/token advantage was
substantially due to system-prompt differences, not an inherent
`AgentSession` advantage. SWE Forge's process-isolation and pre-execution
compatibility-verification requirements remain useful guarantees.

Do not revive that migration casually or relax the capability contract merely
to support it. Reconsider it if Pi's runtime, isolation, or lifecycle
capabilities change materially, or new evidence changes the tradeoff.
Separately, reducing unnecessary child system/context overhead *within the
subprocess architecture* is a legitimate optimization when it preserves the
current isolation, lifecycle, compatibility, and cleanup guarantees.

## Sources of truth

- [`README.md`](README.md): package role, installation, public capability,
  security model, and supported development commands.
- [`docs/swe-forge-integration.md`](docs/swe-forge-integration.md): the minimal
  optional bridge and the cross-repository responsibility split.
- [`docs/architecture.md`](docs/architecture.md): implementation boundary,
  alternatives, isolation semantics, and deferred technical debt.
- [`docs/compatibility.md`](docs/compatibility.md): tested compatibility,
  trust/security boundaries, result limits, and conditional real-Pi acceptance.
- [`package.json`](package.json): package metadata and the authoritative local
  script names; `src/` and `test/` are the behavioral sources of truth.
- The main repository's [`SWE-FORGE.md`](https://github.com/joacod/swe-forge/blob/main/SWE-FORGE.md),
  [`AGENTS.md`](https://github.com/joacod/swe-forge/blob/main/AGENTS.md),
  `.swe-forge/workflows/`, `.swe-forge/contracts/`, `.swe-forge/policies/`,
  and Pi adapter own canonical workflow meaning. Read those files when a
  change crosses the integration boundary; do not reproduce them here.

## Change and validation expectations

Keep changes small and measured. Preserve canonical ownership, minimize
model-visible context, and load only the canonical material needed for the
active path. Prefer deletion/consolidation over speculative compatibility
shims, benchmark/effectiveness infrastructure, or large telemetry systems.
Bounded diagnostics that answer a concrete runtime question are different from
turning this package into an observability platform.

After a normal code or behavior change, use the repository's existing checks:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Use `npm run test:unit` or `npm run test:integration` for focused feedback when
appropriate. `npm run acceptance -- --scenario all` is conditional: it uses a
real Pi process, the installed canonical SWE Forge root, and model/auth setup
for model-backed scenarios; do not treat it as a required local check for a
document-only change. Run it when changing the real runtime/integration
boundary or when release-level confidence requires it.

Any change to capability metadata, protocol or compatibility, isolation or
profiles, role/contract projection, result validation, fallback behavior,
writable concurrency, or nested delegation requires consideration in both
repositories. Coordinate the companion SWE Forge adapter and run its relevant
checks (including `scripts/test-swe-forge-pi` and the repository's structural
validation) rather than silently widening one side of the contract.

Before finishing, verify focused tests for changed behavior, applicable
type/build/lint/format checks, documentation for public behavior changes, a
final diff containing only intended files, and that no canonical SWE Forge
ownership has been duplicated.
