# swe-forge-pi-subagents

Minimal Pi package primitive for SWE Forge's canonical `SUBAGENTS` topology.
It discovers the installed SWE-Forge support root, projects canonical roles and
contracts into one transient runtime prompt, and executes exactly one bounded
child task in a fresh Pi JSON subprocess. It does not implement orchestration,
workflows, or filesystem isolation.

## Architecture

- **SWE-Forge** is the orchestration layer and source of truth.
- **This package** is an optional Pi execution primitive for one bounded child-agent context.
- **Pi** is the harness/runtime that loads the extension.

The package discovers the canonical SWE-Forge support root at
`~/.pi/agent/swe-forge/` and validates `SWE-FORGE.md`, `AGENTS.md`,
`.swe-forge/`, and `VERSION` without copying or modifying the installation.
For development and tests only, set `SWE_FORGE_ROOT` to an alternate root;
invalid overrides do not fall back to another location. Runtime projection
loaders rediscover that root on each invocation, accept role names only, and
return canonical markdown without generating `.pi/agents/*.md` files. Child
execution is intentionally deferred to a later step.

The public projection helpers are exported from `src/index.ts`: discover role
names with `discoverCanonicalRoleNames`, load roles and the fixed `task`,
`result`, and `review` contracts, compose a prompt with
`composeRuntimePrompt`, and validate lightweight task/output boundaries with
`validateTaskContract` and `validateCanonicalOutput`. The single-task runtime
is exposed through `executeSWEForgeTask` (also `runSWEForgeTask`) and provides
only `READ_ONLY` (`read`, `grep`, `find`, `ls`) and `WRITABLE` (those tools plus
`edit`, `write`, `bash`) profiles. Profiles restrict model-visible Pi tools;
they are not an operating-system sandbox, so the child retains the invoking
user's OS permissions.

See [`docs/architecture.md`](docs/architecture.md) for the technical spike,
compatibility assumptions, and isolation semantics.
