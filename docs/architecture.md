# Architecture

> **Current implementation scope:** this package provides canonical SWE-Forge
> support-root discovery and a runtime projection of canonical role and
> contract markdown. The child execution transport described below is the
> planned next phase and is not implemented yet.

## Project responsibility

`swe-forge-pi-subagents` is a deliberately small Pi adapter for one capability:
launch one real Pi child-agent context for SWE Forge's canonical `SUBAGENTS`
topology and return its structured completion to the SWE Forge orchestrator.
The adapter owns only canonical-source projection plus the future Pi
process/session boundary and transport details:

- discover canonical role names and load selected role/contract markdown from
  the detected support root without copying or translating it;
- compose one bounded prompt from the selected role, supplied task contract,
  expected output contract, and the required Pi-runtime guardrail;
- launch a child with an explicit checkout, model, prompt, and tool allowlist;
- keep the child conversation separate from the parent conversation;
- collect Pi's JSON event stream into a bounded result;
- propagate cancellation and clean up the child process and temporary prompt
  material.

SWE Forge remains authoritative for workflow phases, topology and delivery,
role/contract/policy loading, task decomposition, writable-worker sequencing,
result interpretation, review, integration, and acceptance.

## Explicit non-goals

This package is not a general multi-agent framework. It does not provide:

- topology selection, workflow execution, or policy loading; canonical role
  discovery and contract loading are projections only, not package-owned
  definitions;
- parallel/chain/background scheduling, queues, retries, or persistence;
- worktrees, filesystem isolation, Git integration, or delivery automation;
- role definitions, task/result contracts, or workflow behavior owned by
  SWE Forge;
- a community subagent runtime or another orchestration dependency;
- a sandbox or privilege boundary. Pi and its tools retain the invoking user's
  local permissions;
- recursive delegation. A child is intentionally started without extensions
  and with an explicit built-in tool allowlist.

Context isolation is not filesystem isolation. A `SUBAGENTS` child may use the
same checkout as its parent. SWE Forge must keep writable workers sequential in
that checkout; concurrent writable work belongs to `ISOLATED` and is outside
this package.

## Focused technical spike

The research target was the Pi installation available in this environment:
`@earendil-works/pi-coding-agent` **0.84.2** (Pi CLI `0.84.2`), under
`/Users/joaquindiaz/.nvm/versions/node/v24.15.0/lib/node_modules/`.
Relevant current sources and documentation inspected include:

- `docs/extensions.md` and `examples/extensions/subagent/index.ts`;
- `docs/sdk.md`, `docs/json.md`, `docs/rpc.md`, `docs/packages.md`,
  `docs/models.md`, `docs/settings.md`, `docs/environment-variables.md`, and
  `docs/security.md`;
- the public declarations for `createAgentSession`, `AgentSession`,
  `DefaultResourceLoader`, `ModelRuntime`, and `CreateAgentSessionOptions`;
- the current CLI argument parser and the JSON/RPC mode implementation.

The official subagent example is especially relevant: it uses a separate
`pi` process with `--mode json -p --no-session`, passes a model and tool
allowlist, writes a large system prompt to a temporary file, parses
`message_end` events, and propagates an abort signal to the child. It is prior
art for the transport, not a source of SWE Forge behavior.

A few published packages were inspected only as prior art (no package was
added): `@mystilleef/pi-subagent` 0.12.1 (subprocess orchestration),
`@bacnh85/pi-subagent` 0.15.0 (in-process SDK sessions), and
`@zichuanlan/pi-subagents-lite` 0.2.0 (a broader child-agent runtime with
profiles and UI). They all add orchestration, lifecycle, policy, or UI scope
that this project must not absorb.

## Alternatives considered

### In-process SDK child session

Pi's public SDK supports a fresh `createAgentSession()` with a separate
`SessionManager.inMemory()`, a custom `cwd`, `tools`/`excludeTools`, a
`ResourceLoader`, event subscriptions, `session.abort()`, and
`session.dispose()`. It is technically capable of a separate conversation and
has excellent cancellation and structured events.

However, the extension-facing `ExtensionContext` exposes a `ModelRegistry`,
not the parent `ModelRuntime`. Reusing the exact parent runtime from an
extension therefore requires an unstable/private reach-through or reconstructing
provider/auth state. A fresh loader is also required for every child because
extension factories capture the runtime they were loaded against. In-process
sessions share the host process, module cache, extension state, and accidental
resources, making cleanup and isolation easier to get subtly wrong. The SDK
remains a useful future option if Pi exposes a supported child-runtime handoff;
it is not the minimum robust implementation for this adapter.

### One-shot Pi subprocess in JSON mode — selected

Pi's documented JSON mode gives a one-shot, line-delimited event stream. A
separate process naturally owns a separate context window and can be started in
the requested checkout. The public CLI provides stable controls for the
important boundaries: `--model`, `--thinking`, `--tools`, `--exclude-tools`,
`--no-extensions`, `--no-skills`, `--no-prompt-templates`,
`--no-context-files`, `--no-session`, and `--mode json -p`.

The adapter can use Node's standard `child_process` APIs, parse authoritative
`message_end`/`agent_end` events, and terminate the child on the parent
`AbortSignal`. It does not need to know Pi's internal `Agent`, extension
runner, or resource-loader implementation.

### Persistent RPC subprocess

RPC mode is a sound public subprocess protocol and exposes explicit `abort`,
state, and message commands. It is more machinery than a single bounded task
needs: it requires a long-lived stdin protocol, request correlation, shutdown
state, and handling queued prompts. It becomes attractive only if SWE Forge
later needs steering or multiple prompts in one child context.

### Direct low-level `Agent`/`pi-ai` composition

Constructing `Agent` directly would avoid a process, but would require the
adapter to recreate Pi's model/auth resolution, coding tools, resource policy,
retry behavior, and event/session wiring. That is more coupling and more code
than the supported SDK or CLI surfaces.

### Community subagent runtime dependency

Existing packages demonstrate useful process and SDK patterns, but also bundle
role registries, background jobs, UI, worktrees, persistence, model fallback,
or policy systems. Adding one would make SWE Forge behavior ambiguous and add
an unnecessary compatibility surface. Pi's supported primitives satisfy the
current requirement, so no community runtime is a dependency.

## Comparison

| Alternative | Conversation isolation | Same checkout | Deterministic tools / no recursion | Model/auth inheritance | Cancellation / cleanup | Structured capture | Pi coupling | Scope fit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| In-process `createAgentSession` | Yes, with a fresh session | Yes | Yes, with explicit options and a lean loader | Model yes; exact extension-host runtime auth is awkward without a public handoff | Good APIs, but shared process/resources complicate cleanup | Excellent events/state | Public SDK, but runtime/loader lifecycle details matter | Medium |
| One-shot JSON subprocess | Yes, separate process/context | Yes, `spawn({ cwd })` | Yes, CLI allowlist plus `--no-extensions` | Model and normal env/config auth inherit; runtime-only auth is unresolved | Signal-driven process termination; process-tree edge cases remain | JSONL `message_end`/`agent_end` | Stable documented CLI/event protocol | **High** |
| RPC subprocess | Yes, separate process/context | Yes | Yes, plus command-time controls | Same subprocess caveat | Explicit abort, but persistent lifecycle is larger | Excellent JSONL protocol | Stable, but more protocol surface | Medium |
| Direct `Agent`/`pi-ai` | Only if rebuilt by adapter | Possible | Must rebuild | Must rebuild | Must rebuild | Must rebuild | High/internal | Low |
| Community runtime | Depends on package | Depends on package | Package-specific | Package-specific | Package-specific | Package-specific | Extra dependency/framework | Low |

## Chosen child execution mechanism

Use a **one-shot Pi CLI subprocess in JSON mode**:

```text
pi --mode json --print --no-session
    --no-extensions --no-skills --no-prompt-templates
    --no-themes --no-context-files
    --model <provider/id> --thinking <level>
    --tools <comma-separated-builtins>
    --exclude-tools <delegation-tool-names>
    --append-system-prompt <0600-temporary-file>
    <task>
```

The package skeleton exposes a narrow single-child runner and a Pi extension
tool that delegates to it. It does not expose parallel, chain, role, or
workflow APIs. The parent supplies the task contract and role instructions as
an explicit system-prompt append; the child uses Pi's normal built-in system
prompt and tools but no discovered extensions, skills, templates, context
files, or themes. This makes resource loading predictable and prevents the
adapter's own extension from being rediscovered recursively.

The runner resolves the current Pi executable conservatively: when the active
Pi script is a real file it invokes it with the current Node executable; it
otherwise falls back to the `pi` command. It uses `spawn` without a shell,
passes the selected `cwd`, writes prompt material to a mode-0600 temporary
file, parses UTF-8 JSONL incrementally, and removes temporary material in a
`finally` path. The returned result contains a status, exit code, final
assistant text, final assistant metadata when available, bounded stderr, and
stop/error metadata. SWE Forge remains responsible for interpreting that text
against its result contract.

## Why it was selected

- **Smallest reliable boundary:** the official Pi example already proves the
  required one-shot transport; the adapter does not recreate Pi's agent loop.
- **True context separation:** the child has its own process, session, and
  model context while sharing the caller's checkout as required by
  `SUBAGENTS`.
- **Deterministic safety controls:** an explicit built-in allowlist and
  extension/resource suppression prevent accidental tool or recursive-agent
  inheritance. Writable tools are enabled only when the caller asks for them.
- **Low coupling:** the implementation depends on documented CLI flags and
  JSON event records plus Node standard-library process APIs, rather than
  private SDK fields or a private extension runtime.
- **Straightforward testing:** argument construction, JSONL parsing, result
  selection, abort handling, and cleanup can be tested without an LLM call by
  injecting a command/invocation seam in later work.
- **Minimal dependencies and practical portability:** no community runtime,
  worktree library, shell wrapper, or platform-specific framework is needed.

## Pi compatibility assumptions

These assumptions are intentionally explicit and should be checked when
updating the Pi peer range:

1. Pi continues to support `--mode json --print --no-session` and emits
   line-delimited JSON events whose final `message_end.message` is authoritative.
2. `--tools` is a closed allowlist after CLI parsing and
   `--exclude-tools` is applied to the resulting tool set.
3. `--no-extensions`, `--no-skills`, `--no-prompt-templates`,
   `--no-context-files`, and `--no-themes` prevent the corresponding discovery
   paths in headless mode.
4. `--cwd` is not a Pi CLI flag; the process working directory is therefore
   supplied by the host process via `spawn` and Pi uses it for built-in tools
   and any remaining cwd-bound behavior.
5. A child process inherits `PI_CODING_AGENT_DIR`, provider environment
   variables, and the user's normal Pi auth/models files unless the host
   deliberately changes its environment.
6. `--model provider/id` and `--thinking level` remain accepted by the current
   CLI parser.
7. Pi's JSON stream and the child process can be terminated by the host without
   requiring RPC input. The adapter still treats process termination as a
   best-effort cross-platform operation and reports aborts rather than claiming
   successful completion.

The current 0.84.2 source supports all of these assumptions. The package
should pin a compatible Pi peer range and add a CLI smoke test before widening
that range.

## Security and isolation semantics

- **Conversation:** isolated. The child uses `--no-session`, so it neither
  resumes nor persists a Pi conversation and cannot see the parent's messages.
- **Filesystem:** shared by design. `cwd` points at the active project. This is
  not a sandbox and does not replace SWE Forge's `ISOLATED` worktrees.
- **Tools:** the caller supplies a closed list of Pi built-ins. The runner
  rejects unknown names and always excludes delegation tool names. `bash` is
  intentionally treated as writable/privileged by policy; a read-only worker
  must omit it, `edit`, and `write`.
- **Resources:** extensions, skills, prompt templates, themes, and context
  files are disabled. The caller's explicit system prompt is written with
  restrictive temporary-file permissions and deleted after the child exits.
- **Credentials:** the child receives the normal child-process environment and
  Pi config directory. No secret is copied into the task prompt or logged.
  Runtime-only API-key overrides, in-memory provider registrations, and
  provider-specific headers are not promised to cross the process boundary.
- **Cancellation:** the parent signal requests termination and the runner
  waits for process closure with a bounded escalation. It returns `aborted`
  rather than converting cancellation into a successful result.
- **Prompt injection:** child output is untrusted model output. The adapter
  returns it as data; SWE Forge must validate structured results and must not
  treat child claims as Git or test evidence.
- **Concurrency:** the package does not coordinate writers. SWE Forge owns the
  rule that only one writable worker runs in a shared checkout; concurrent
  writable work requires `ISOLATED`.

## Unresolved risks

1. **Runtime-only authentication:** Pi's extension context does not expose the
   parent `ModelRuntime`. A subprocess sees persisted `auth.json` and ambient
   environment auth, but not an in-memory runtime key or an extension-registered
   provider unless the caller arranges an equivalent child configuration.
2. **Process trees:** a child Pi can launch shell descendants. POSIX process
   groups and Windows termination have different semantics; the first skeleton
   provides conservative termination, while a later acceptance test should
   prove no orphaned Pi/tool process remains on supported platforms.
3. **CLI/event compatibility:** JSON event schemas and headless flags are
   documented public surfaces but still versioned with Pi. A future Pi release
   may require an adapter compatibility update.
4. **Result size:** Pi tool output is truncated, but a long child conversation
   can still produce large event streams. The adapter bounds stderr and keeps
   only final result data; a future result-contract seam should add explicit
   output limits and diagnostics without returning transcripts by default.
5. **Resource policy trade-off:** disabling all discovered resources maximizes
   determinism but means the child does not automatically receive repository
   `AGENTS.md` or Pi extension tools. SWE Forge must include any required
   canonical instructions in the explicit task/system prompt.
6. **No filesystem isolation:** a caller that violates SWE Forge's shared-write
   sequencing can still race another writer. Preventing that belongs in SWE
   Forge routing/authorization, not in this narrow Pi primitive.
