# Architecture

> **Current implementation:** one bounded SWE-Forge child task runs through a
> fresh in-process Pi `AgentSession` with explicit model, thinking, tools,
> settings, session, and resource-loader configuration.

## Project responsibility

`swe-forge-pi-subagents` is a deliberately small Pi adapter for one capability:
run one bounded canonical task for SWE Forge's `SUBAGENTS` topology and return
its structured completion. The package owns only:

- discovery of the already-installed canonical support root;
- projection of one selected role and output contract into one system prompt;
- one fresh in-process Pi session with a closed built-in tool profile;
- bounded lifecycle diagnostics and final-result extraction;
- cancellation, session disposal, and the process-local checkout lock; and
- recognizable task/output validation.

SWE Forge remains authoritative for workflow phases, topology and delivery,
role/contract/policy meaning, task decomposition, evidence, review,
integration, acceptance, and worktree isolation.

## Explicit non-goals

This package is not a general multi-agent framework. It does not provide:

- topology selection, workflow execution, or policy loading;
- parallel/chain/background task scheduling, queues, retries, or persistence;
- worktrees, filesystem isolation, Git integration, or delivery automation;
- role definitions, task/result contracts, or workflow behavior;
- a provider-selection layer or parent-session model fallback; or
- recursive delegation.

Context isolation is not filesystem or process isolation. A child shares the
host process, selected checkout, and OS permissions with its caller. SWE Forge
must keep writable workers sequential in a shared checkout; concurrent writable
work belongs to `ISOLATED` and is outside this package.

## Current Pi SDK boundary

The runtime targets the public API of
`@earendil-works/pi-coding-agent` in `>=0.84.1 <0.85.0`, tested locally with
0.84.2. It uses:

- `ModelRuntime.create()` and an explicit `getModel(provider, model)` lookup;
- `SettingsManager.inMemory()` with compaction and retry disabled;
- `SessionManager.inMemory(cwd)`;
- a minimal `ResourceLoader` with no discovered resources;
- `createAgentSession({ model, thinkingLevel, tools, excludeTools, ... })`;
- `session.subscribe()` for lifecycle/usage observations;
- `session.prompt()` with prompt-template expansion disabled;
- `session.abort()` and `session.waitForIdle()`; and
- `session.dispose()` after the run has settled.

The package does not import Pi's private `Agent` implementation, spawn the Pi
CLI, parse JSONL, write a temporary prompt file, or reuse the parent extension
runtime. A fresh SDK `ModelRuntime` intentionally reads normal persisted/ambient
model authentication, but parent-only in-memory provider registrations and keys
are not copied.

## Child execution flow

```text
validate profile/model/cwd
  → acquire normalized checkout lease
  → validate and project live canonical role/task/output sources
  → create fresh ModelRuntime, in-memory settings/session, and minimal loader
  → resolve exactly the requested model and configure thinking/tools explicitly
  → create one AgentSession
  → subscribe to agent_start/turn_start/agent_end/agent_settled
  → prompt exactly once with template expansion disabled
  → on AbortSignal: AgentSession.abort() and wait for idle
  → extract the final settled assistant message only
  → enforce the 64 KiB canonical result bound
  → validate canonical output
  → dispose session and release checkout lease
```

The caller supplies one of these exact profiles:

```text
READ_ONLY = read, grep, find, ls
WRITABLE  = read, grep, find, ls, edit, write, bash
```

The runtime excludes `subagent` and `swe_forge_subagent`, and the minimal loader
returns no extensions, skills, prompt templates, themes, or context files. The
only model-visible projected workflow material is the canonical system prompt;
timing, usage, queue, and lifecycle details remain outside model output.

## Resource and session isolation

Every call receives a new in-memory session manager and a new settings manager.
No previous child messages are restored. The resource loader is intentionally
explicit:

```text
extensions: []
skills: []
prompt templates: []
themes: []
context files: []
append system prompt: []
system prompt: composed canonical role/task/output projection
```

This prevents the parent package, user/project extensions, skills, and context
files from being rediscovered by a child. It also makes the absence of
recursive delegation a construction property rather than a CLI flag that can
drift.

## Result and diagnostics boundary

Pi's streaming updates are not canonical output. The runtime waits for the
settled session and selects the last assistant message from the final agent
run, then concatenates only text content blocks. A preceding assistant message
or a streaming delta cannot replace the final result.

The canonical text is bounded at 64 KiB before it is returned. Oversized output
fails closed with no truncated success value. Failed, aborted, malformed, and
missing-result runs expose empty canonical output and structured runtime status.
Validation failures include bounded runtime metadata but deliberately omit
assistant message content and runtime text from error details.

Optional diagnostics include:

- queue wait;
- session initialization;
- agent execution and total duration;
- turn count; and
- usage from the final assistant message.

No transcript, reasoning block, tool stream, or raw provider response is copied
into canonical output.

## Scheduler and cancellation

`CheckoutScheduler` remains the process-local shared-reader/exclusive-writer
lock. Multiple readers may overlap in one normalized checkout. A writer waits
for active readers and other writers, then blocks readers until it releases;
queued writers prevent reader starvation. The lock does not coordinate another
Pi process, package instance, machine, or worktree.

A caller timeout is represented by an `AbortSignal`. The runtime requests
`session.abort()`, waits for the session to become idle, disposes the session,
and only then releases the checkout lease. A normal completion also waits for
idle before disposal. Cleanup is attempted after provider/session errors, and a
cleanup failure can downgrade an otherwise completed runtime to failed rather
than leaking a live session.

## Capability semantics

Capabilities advertise:

```json
{
  "contextIsolation": true,
  "processIsolation": false,
  "filesystemIsolation": false,
  "osSandbox": false
}
```

The package is an in-process runtime, not a security sandbox. `READ_ONLY`
restricts model-visible Pi tools but cannot prevent another process from
modifying the checkout. `WRITABLE` uses the invoking user's ordinary OS
permissions. SWE Forge's `ISOLATED` topology remains the only boundary for
worktree/process-provider isolation.

## Alternatives considered

### Pi CLI subprocess

The former implementation used a one-shot JSON subprocess, CLI argument
construction, a version probe, JSONL parsing, temporary prompt files, and
process-tree termination. That provided OS-process separation but duplicated
Pi's session lifecycle and could not carry parent runtime provider/auth state.
It is intentionally removed: the supported SDK supplies structured lifecycle,
model, tools, resource loading, abort, idle, and disposal primitives directly.

### Persistent RPC subprocess

RPC would add stdin correlation, long-lived process lifecycle, and queued
prompt state for a primitive that needs exactly one bounded prompt. It remains
out of scope.

### Direct low-level `Agent`/`pi-ai`

Constructing Pi's low-level agent would require reimplementing session
persistence, tool registration, model/auth request handling, and extension
lifecycle. The public `createAgentSession` SDK provides the required pieces with
less coupling.

### Community subagent runtimes

Third-party runtimes add orchestration, UI, worktrees, persistence, or policy
layers that belong to SWE Forge. They are unnecessary dependencies here.

## Cross-repository integration

The main SWE Forge Pi adapter feature-detects `swe_forge_subagent`, requires
capability protocol 1, requires the public SDK/in-process metadata and
`processIsolation: false`, and blocks the tool for `SOLO` and `ISOLATED` runs.
Missing, incompatible, or failed capability negotiation preserves the existing
SOLO/sequential fallback. The main adapter does not import this package or
select a topology.
