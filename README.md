# swe-forge-pi-subagents

Optional Pi extension for [SWE Forge](https://github.com/joacod/swe-forge). It
adds one bounded child-agent runtime for SWE Forge's `SUBAGENTS` topology:
SWE Forge renders the task, this package launches a fresh Pi process, and the
canonical workflow remains responsible for routing, evidence, review, and
delivery. It registers the Pi tool `swe_forge_subagent`.

Install this package when you use SWE Forge with Pi and want its optional
`SUBAGENTS` backend. It is not required for normal `SOLO` or sequential
execution.

## Quick start

Install [SWE Forge](https://github.com/joacod/swe-forge) separately using its
[installation guide](https://github.com/joacod/swe-forge/blob/main/docs/installation.md)
before continuing. This extension assumes SWE Forge is already installed and
available to Pi.

This package is not published to npm yet. To install the extension from its
source checkout, use Node.js `>=22.19.0`:

```bash
git clone https://github.com/joacod/swe-forge-pi-subagents.git
cd swe-forge-pi-subagents
npm ci
pi install .
```

Use `pi install -l .` for a project-local Pi installation.

Restart Pi or run `/reload`, then confirm the package with:

```bash
pi list
```

Installation only makes the optional capability available. SWE Forge is still
activated explicitly, for example:

```text
/swe-forge pr <ticket>
```

## What it adds

- **One bounded child run.** Starts a fresh Pi JSON subprocess for one
  root-rendered `worker_briefing/v1` projection.
- **Canonical worker-brief validation.** Delegates structural validation to
  `.swe-forge/tools/swe-forge-worker-brief` from the discovered SWE Forge root,
  then enforces only this adapter's execution constraints.
- **Live canonical sources.** Reads the selected role and output contract from
  the installed SWE Forge support root instead of bundling copies.
- **Closed tool profiles.** `READ_ONLY` exposes `read`, `grep`, `find`, and
  `ls`; `WRITABLE` also exposes `edit`, `write`, and `bash`.
- **Safe fallback.** When this optional capability is absent or unavailable,
  SWE Forge keeps its normal SOLO/sequential path.

The main SWE Forge repository remains the source of truth for workflow meaning,
roles, contracts, policies, topology selection, evidence, review, integration,
and delivery.

## How the handoff works

After canonical routing selects or considers a useful `SUBAGENTS` task, the
SWE Forge Pi adapter:

1. feature-detects `swe_forge_subagent`;
2. requests observed capabilities when appropriate;
3. passes one canonical role, worker briefing, output contract, and tool
   profile; and
4. consumes the bounded result through the normal SWE Forge evidence and
   acceptance flow.

The extension exposes exactly two tool actions:

| Action | Purpose |
| --- | --- |
| `capabilities` | Reports the observed Pi compatibility, canonical SWE Forge installation, roles, profiles, and isolation semantics. |
| `run` | Executes one bounded child briefing using `role`, `workerBriefing`, `expectedOutputContract` (`result` or `review`), and `profile` (`READ_ONLY` or `WRITABLE`). |

`workerBriefing` must be the projection rendered by the SWE Forge root. It is
not a replacement for the canonical task contract and should not be assembled
by hand. The package also exports `executeSWEForgeTask` and
`getSWEForgeCapabilities` for the supported Pi integration boundary; transport
and lock helpers are implementation details.

## Isolation and trust boundaries

| Boundary | Semantics |
| --- | --- |
| Context and process | Each child gets a fresh `--no-session` Pi process and context. |
| Filesystem | The child uses the caller's normalized checkout; this package does not create worktrees. |
| Operating system | No OS sandbox or privilege reduction. Children use the invoking user's normal OS permissions. |
| Read-only work | Multiple readers for the same checkout may overlap within this runtime. |
| Writable work | Writers are exclusive within this runtime and wait behind queued writers. SWE Forge must still serialize shared-checkout writes. |
| Output | Canonical worker output is bounded to 64 KiB. Malformed, truncated, `BLOCKED`, or `FAILED` results are not success. |

The process boundary is not a security sandbox. Review and trust Pi extensions
before installing them; they run with the invoking user's permissions. The child
inherits the normal environment and Pi configuration needed for authentication,
and temporary prompt material is removed after execution.

`ISOLATED` execution, worktrees, provider selection, retries, workflow state,
and delivery remain outside this package and belong to SWE Forge.

## Compatibility

| Component | Supported line |
| --- | --- |
| Node.js | `>=22.19.0` |
| Pi CLI/package | `>=0.84.1 <0.85.0` (tested with `0.84.2`) |
| SWE Forge | `0.1.x` |
| Capability protocol | `protocolVersion: 1` |
| Profiles | `READ_ONLY`, `WRITABLE` |
| Exercised platform | macOS with Node 24.15.0; Linux and Windows are portability targets, not fully exercised release claims |

At runtime, canonical discovery uses exactly `~/.pi/agent/swe-forge/`. The
root must provide `AGENTS.md`, `SWE-FORGE.md`, `VERSION`, and `.swe-forge/`.
`SWE_FORGE_ROOT` is an explicit development/test override; a project-local
`.swe-forge/` directory is never a fallback.

See [`docs/compatibility.md`](docs/compatibility.md) for the tested boundary,
trust model, result limits, and real-Pi acceptance setup.

## Troubleshooting

**The tool is missing.** Run `pi list`, confirm the package is installed in the
intended scope, then restart Pi or run `/reload`.

**SWE Forge is unavailable.** Install SWE Forge separately and verify that
`~/.pi/agent/swe-forge/` contains the required root files,
`.swe-forge/agents`, `.swe-forge/contracts`, and the executable
`.swe-forge/tools/swe-forge-worker-brief`. Do not use a project-local support
tree as a workaround.

**A child cannot run.** Confirm that Pi is in the supported version range, that
Pi authentication works in a normal session, and that the selected profile
matches the briefing's write access. A child result is not Git, test, or
delivery evidence; the canonical workflow must validate it independently.

## Development and testing

From this checkout:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Focused suites are available with `npm run test:unit` and
`npm run test:integration`. The opt-in acceptance harness invokes a real Pi
process and model-backed scenarios when a model and authentication are
available:

```bash
npm run acceptance -- --help
npm run acceptance -- --scenario all
```

See [`docs/architecture.md`](docs/architecture.md) for the implementation
boundary and [`docs/swe-forge-integration.md`](docs/swe-forge-integration.md)
for the optional adapter contract.

## License

[MIT](LICENSE)
