# SWE-Forge integration contract

This document defines the smallest optional bridge in the main SWE-Forge Pi
adapter. It is an integration boundary, not a replacement for the canonical
SWE-Forge workflow. The canonical sources remain `SWE-FORGE.md`,
`.swe-forge/workflows/`, `.swe-forge/agents/`, `.swe-forge/contracts/`, and
`.swe-forge/policies/` in the separately installed SWE-Forge support root.

## Compatibility promise

The main SWE-Forge Pi adapter must remain fully functional when
`swe-forge-pi-subagents` is not installed, disabled, incompatible, or unable to
start a child. The extension is optional. Its absence is a capability result,
not an installation failure for SWE-Forge.

The main SWE-Forge installer must not silently install this executable Pi
extension. Users install and trust it separately through Pi's package
mechanism. The main installer may document the optional package, but it must
not add it to the default installation or turn it into a hidden dependency.

## Boundary of responsibility

### Main SWE-Forge owns

- explicit `/swe-forge` activation;
- the canonical selection or consideration of `SOLO`, `SUBAGENTS`, and
  `ISOLATED`;
- discovery-shape assessment, delegation policy, task ownership, and bounded
  task contracts;
- canonical role, contract, and policy meaning;
- whether a delegated task is useful and safe;
- sequencing writable work in a shared checkout;
- evidence, review, integration, acceptance, delivery, and fallback behavior;
- all worktree and filesystem-isolation lifecycle for `ISOLATED` execution.

This extension must not redefine topology selection, delegation policy,
canonical roles/contracts, or `ISOLATED`/worktree execution.

### This package owns

- feature availability through the `swe_forge_subagent` Pi tool;
- live discovery of the already-installed canonical SWE-Forge support root;
- projection of one selected canonical role and output contract into one child
  prompt;
- one bounded child Pi process with a closed `READ_ONLY` or `WRITABLE` tool
  profile;
- the child conversation/process boundary, bounded transport diagnostics,
  cancellation cleanup, and the process-local shared-reader/exclusive-writer
  checkout lock; and
- recognizable task/output boundary validation.

It does not own workflow state, task queues, planner data, provider/model
selection, retries, PR delivery, worktrees, or recursive delegation.

## Capability handshake

The adapter/orchestrator should feature-detect the exact tool name
`swe_forge_subagent`; it should not hard-import this package or assume that a
Pi installation implies that the tool is present. If the tool is present, the
adapter may request `action: "capabilities"` and inspect the returned
machine-readable result.

Relevant v1 capability facts include:

- `protocolVersion: 1` (independent from `packageVersion`);
- `pi.compatibilityRange` and pre-execution version verification;
- `isolation.contextIsolation: true`, `processIsolation: true`,
  `filesystemIsolation: false`, and `osSandbox: false`;
- `sweForge.installed`, `sweForge.version`, and the discovered `roles`;
- `availableProfiles` and `profileTools` for `READ_ONLY` and `WRITABLE`;
- `readOnlyParallelSupport: true`;
- `writableConcurrencySupport: false`;
- `nestedDelegationSupport: false`; and
- `compatibilityErrors`, if canonical installation or compatibility checks
  failed.

These facts describe an observed execution capability. They do not choose a
topology, authorize a task, or replace canonical policy. A capability result
with errors is unavailable for delegation unless the canonical adapter has an
explicit, evidence-backed way to handle that condition.

## Bounded run contract

Only after the canonical workflow has selected or considered a useful bounded
`SUBAGENTS` task may the adapter request `action: "run"`. The caller supplies:

- a discovered canonical role name (`role`);
- the canonical task contract (`taskContract`);
- `expectedOutputContract: "result"` or `"review"`; and
- `profile: "READ_ONLY"` or `"WRITABLE"`.

The extension uses the current Pi checkout/model context, loads live canonical
sources, and returns canonical output as the primary result with runtime
metadata separate. The main adapter must consume the output as untrusted
worker data, preserve `BLOCKED`/`FAILED` semantics, and continue to own
validation evidence and acceptance. A child result is never proof that a test,
Git operation, integration, or delivery action occurred.

For a shared checkout, the canonical adapter must treat `READ_ONLY` as
potentially overlapping and `WRITABLE` as exclusive. `writableConcurrencySupport`
being false is not a request to create worktrees; it means writable calls must
be sequential or the canonical workflow must choose a different topology.
Filesystem isolation remains outside this package.

## Minimal adapter change

The implemented main-repository change is limited to an optional capability
path in its existing Pi adapter/orchestrator:

1. retain the existing explicit invocation and canonical workflow unchanged;
2. at the point where that workflow has a bounded, useful `SUBAGENTS` task,
   detect `swe_forge_subagent`;
3. if the tool is absent, reports unacceptable capabilities, or fails before a
   usable result, use the existing SOLO/sequential fallback;
4. if the tool is present and the canonical task/profile requirements are
   acceptable, issue one bounded run and return its structured result to the
   existing orchestrator; and
5. let the existing canonical evidence, review, integration, and delivery
   handling decide the final outcome.

No new topology enum, planner, scheduler, role registry, contract copy,
provider-selection layer, worktree layer, or installer dependency is needed in
the main repository for this integration.

## Proposed integration flow

The following is intentionally pseudocode. It shows the handoff without
repeating the canonical workflow procedure:

```text
on explicit /swe-forge invocation:
    canonical workflow selects/considers SUBAGENTS for a bounded task

    if SUBAGENTS is not useful or not selected:
        run the existing SOLO/sequential path

    else:
        tool = feature_detect("swe_forge_subagent")
        if tool is absent:
            run the canonical SOLO/sequential fallback

        capabilities = tool.call(action="capabilities")
        if capabilities are absent, incompatible, or unacceptable for this task:
            record the capability fallback
            run the canonical SOLO/sequential fallback

        result = tool.call(
            action="run",
            role=<canonical role name>,
            taskContract=<canonical bounded task contract>,
            expectedOutputContract=<result or review>,
            profile=<READ_ONLY or WRITABLE>,
        )

        if result is a usable structured completion:
            return it to the canonical orchestrator
        if result is a transport/capability failure before a usable completion:
            record the fallback and use the existing SOLO/sequential path
        else:
            preserve a canonical BLOCKED/FAILED result and follow existing
            canonical recovery/acceptance handling
```

The extension never turns an explicit `SOLO` decision into delegation, and a
capability probe never turns an explicit `ISOLATED` decision into a shared
checkout. The workflow remains the only router.

## Activation and installation behavior

The package may be loaded by Pi after a user installs it globally, in project
settings, or for a one-run test. That load only registers the optional tool. It
does not activate `/swe-forge`, run a task, change canonical routing, or
install SWE-Forge. The main SWE-Forge installer must preserve that separation.

If the package is removed or Pi disables it, the main adapter must still expose
its normal `/swe-forge` behavior and its existing sequential fallback. An
unsupported Pi/SWE-Forge version, missing canonical root, missing role, or
child-process failure must degrade to the same fallback or canonical blocked
status that the existing adapter already uses; it must not trigger an implicit
package installation or a topology rewrite.

## Version and source ownership

The extension's v1 compatibility lines are Pi `>=0.84.1 <0.85.0` and
SWE-Forge `0.1.x`. The extension reads those installed sources live rather than
bundling role or contract definitions. If the main repository changes a public
role/contract shape or the Pi child protocol, it must coordinate a deliberate
compatibility update; this document is not permission to silently widen either
range.

The main adapter now has focused feature-detection, capability-negotiation,
fallback, and `ISOLATED` protection coverage. It does not copy this package's
implementation or canonical workflow prose into the main repository. The
adapter remains dependency-free: users install this package separately.
