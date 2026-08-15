# swe-forge-pi-subagents

Minimal Pi child-agent execution primitive for SWE Forge's canonical
`SUBAGENTS` topology. It runs one bounded child Pi process in the active
checkout and does not implement orchestration, roles, workflows, or
filesystem isolation.

See [`docs/architecture.md`](docs/architecture.md) for the technical spike,
compatibility assumptions, and isolation semantics.
