# swe-forge-pi-subagents

Minimal Pi package skeleton for SWE Forge's canonical `SUBAGENTS` topology.
It discovers the installed SWE-Forge support root and reserves one bounded
child-agent tool name; child execution is deferred. It does not implement
orchestration, roles, workflows, or filesystem isolation.

## Architecture

- **SWE-Forge** is the orchestration layer and source of truth.
- **This package** is an optional Pi execution primitive for one bounded child-agent context.
- **Pi** is the harness/runtime that loads the extension.

The package discovers the canonical SWE-Forge support root at
`~/.pi/agent/swe-forge/` and validates `SWE-FORGE.md`, `AGENTS.md`,
`.swe-forge/`, and `VERSION` without copying or modifying the installation.
For development and tests only, set `SWE_FORGE_ROOT` to an alternate root;
invalid overrides do not fall back to another location. Child execution is
intentionally deferred to a later step.

See [`docs/architecture.md`](docs/architecture.md) for the technical spike,
compatibility assumptions, and isolation semantics.
