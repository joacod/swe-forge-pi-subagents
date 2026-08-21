import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DELEGATION_TOOL_NAMES,
	READ_ONLY_TOOLS,
	runChildAgent,
	getToolsForProfile,
	PI_COMPATIBILITY_POLICY,
	WRITABLE_TOOLS,
	type ChildAgentSession,
	type ChildAgentSessionFactory,
} from "../src/runtime.js";
import { SWE_FORGE_ROOT_ENV } from "../src/discovery.js";
import { MAX_WORKER_RESULT_BYTES, SWEForgeRuntimeError } from "../src/projection.js";
import { executeSWEForgeTask } from "../src/runtime.js";
import { copyFakeSWEForgeInstallation } from "./fixtures.js";

const temporaryPaths: string[] = [];

const TASK_CONTRACT = "# Task Contract\n\nTASK_ID: task-123\nOBJECTIVE: bounded fixture task\n";
const RESULT_OUTPUT = "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: fixture complete\nVALIDATION: fixture passed\n";
const REVIEW_OUTPUT = "STATUS: PASS\nTASK_ID: task-123\nREVIEW_FOCUS: fixture review\nFINDINGS: []\n";

interface SessionRecord {
	readonly input: Parameters<ChildAgentSessionFactory>[0];
	readonly session: ChildAgentSession;
	disposed: boolean;
	aborted: boolean;
}

type FakeMode = "success" | "review" | "malformed" | "oversized" | "error" | "no-result" | "hang";

async function createCanonicalRoot(): Promise<string> {
	const root = await copyFakeSWEForgeInstallation();
	temporaryPaths.push(root);
	await Promise.all([
		writeFile(join(root, ".swe-forge", "agents", "reader.md"), "# Reader\n\nRead-only canonical role.\n"),
		writeFile(join(root, ".swe-forge", "agents", "writer.md"), "# Writer\n\nWritable canonical role.\n"),
		writeFile(join(root, ".swe-forge", "contracts", "task.md"), TASK_CONTRACT),
		writeFile(
			join(root, ".swe-forge", "contracts", "result.md"),
			"# Result Contract\n\nSTATUS: DONE | BLOCKED | FAILED\nTASK_ID: <task identifier>\nSUMMARY:\nVALIDATION:\n",
		),
		writeFile(
			join(root, ".swe-forge", "contracts", "review.md"),
			"# Review Contract\n\nstatus: PASS | CHANGES_REQUIRED\nreview_focus:\nfindings:\n",
		),
	]);
	return root;
}

function discovery(root: string) {
	return { env: { [SWE_FORGE_ROOT_ENV]: root } };
}

async function createProject(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "swe-forge-runtime-project-"));
	temporaryPaths.push(project);
	return project;
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not reached before timeout");
}

function makeAssistant(mode: FakeMode): Record<string, unknown> {
	const text =
		mode === "review"
			? REVIEW_OUTPUT
			: mode === "malformed"
				? "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: incomplete\n"
				: mode === "oversized"
					? `STATUS: DONE\nTASK_ID: task-123\nSUMMARY: ${"x".repeat(MAX_WORKER_RESULT_BYTES)}\nVALIDATION: fixture passed\n`
					: RESULT_OUTPUT;
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23, cost: { total: 0.35 } },
	};
}

function fakeSessionFactory(mode: FakeMode, records: SessionRecord[]): ChildAgentSessionFactory {
	return async (input) => {
		const listeners = new Set<(event: unknown) => void>();
		const messages: unknown[] = [];
		const waiters: Array<() => void> = [];
		let streaming = false;
		let aborted = false;
		let releaseHang: (() => void) | undefined;
		let disposed = false;

		const emit = (event: unknown) => {
			for (const listener of listeners) listener(event);
		};
		const settleIdle = () => {
			streaming = false;
			for (const resolve of waiters.splice(0)) resolve();
			emit({ type: "agent_settled" });
		};
		const session: ChildAgentSession = {
			get messages() {
				return messages;
			},
			get isStreaming() {
				return streaming;
			},
			subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
			async prompt() {
				streaming = true;
				emit({ type: "agent_start" });
				emit({ type: "turn_start" });
				if (mode === "hang") {
					await new Promise<void>((resolve) => {
						releaseHang = resolve;
					});
				}
				if (aborted) {
					emit({ type: "agent_end", messages: [] });
					settleIdle();
					return;
				}
				if (mode === "no-result") {
					emit({ type: "agent_end", messages: [] });
					settleIdle();
					return;
				}
				if (mode === "error") {
					const errorMessage = {
						role: "assistant",
						content: [{ type: "text", text: "provider failed" }],
						stopReason: "error",
						errorMessage: "provider failed",
					};
					messages.push(errorMessage);
					emit({ type: "message_end", message: errorMessage });
					emit({ type: "agent_end", messages: [errorMessage] });
					settleIdle();
					return;
				}
				const intermediate = {
					role: "assistant",
					content: [{ type: "text", text: "STATUS: BLOCKED\nTASK_ID: task-123\nSUMMARY: intermediate\nVALIDATION: ignored\n" }],
					stopReason: "toolUse",
				};
				const finalMessage = makeAssistant(mode);
				messages.push({ role: "user", content: [{ type: "text", text: "task" }] }, intermediate, finalMessage);
				emit({ type: "message_end", message: intermediate });
				emit({ type: "message_end", message: finalMessage });
				emit({ type: "agent_end", messages: [intermediate, finalMessage] });
				settleIdle();
			},
			async abort() {
				aborted = true;
				releaseHang?.();
			},
			async waitForIdle() {
				if (!streaming) return;
				await new Promise<void>((resolve) => waiters.push(resolve));
			},
			dispose() {
				disposed = true;
			},
		};
		const record: SessionRecord = {
			input,
			session,
			disposed,
			aborted,
		};
		// Keep the mutable lifecycle flags observable without widening the runtime API.
		Object.defineProperties(record, {
			disposed: { get: () => disposed, enumerable: true },
			aborted: { get: () => aborted, enumerable: true },
		});
		records.push(record);
		return session;
	};
}

type TestTaskOptions = Parameters<typeof executeSWEForgeTask>[0] & {
	readonly discovery: ReturnType<typeof discovery>;
	readonly sessionFactory: ChildAgentSessionFactory;
};

function taskOptions(
	root: string,
	project: string,
	factory: ChildAgentSessionFactory,
	extra: Partial<TestTaskOptions> = {},
): TestTaskOptions {
	return {
		role: "reader",
		taskContract: TASK_CONTRACT,
		expectedOutputContract: "result",
		profile: "READ_ONLY",
		cwd: project,
		model: "fixture/model",
		discovery: discovery(root),
		sessionFactory: factory,
		...extra,
	};
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("runs a read-only role through a fresh AgentSession with bounded diagnostics", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const records: SessionRecord[] = [];
	const result = await executeSWEForgeTask(taskOptions(root, project, fakeSessionFactory("success", records)));

	assert.equal(result.output, RESULT_OUTPUT);
	assert.equal(result.validation?.status, "DONE");
	assert.equal(result.runtime.status, "completed");
	assert.equal(result.runtime.profile, "READ_ONLY");
	assert.deepEqual(result.runtime.tools, READ_ONLY_TOOLS);
	assert.equal(result.runtime.cleanup, "complete");
	assert.ok((result.runtime.diagnostics?.queueWaitDurationMs ?? -1) >= 0);
	assert.ok((result.runtime.diagnostics?.sessionInitializationDurationMs ?? -1) >= 0);
	assert.ok((result.runtime.diagnostics?.agentExecutionDurationMs ?? -1) >= 0);
	assert.ok((result.runtime.diagnostics?.totalRuntimeDurationMs ?? -1) >= 0);
	assert.equal(result.runtime.diagnostics?.turns, 1);
	assert.deepEqual(result.runtime.diagnostics?.usage, {
		inputTokens: 11,
		outputTokens: 7,
		cacheReadTokens: 3,
		cacheWriteTokens: 2,
		totalTokens: 23,
		cost: 0.35,
	});
	assert.equal(records.length, 1);
	assert.deepEqual(records[0].input.tools, READ_ONLY_TOOLS);
	assert.equal(records[0].input.model, "fixture/model");
	assert.equal(records[0].input.systemPrompt.includes("Read-only canonical role."), true);
	assert.equal(records[0].disposed, true);
});

test("creates a fresh session and reprojects canonical resources for every call", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const records: SessionRecord[] = [];
	const factory = fakeSessionFactory("success", records);

	await executeSWEForgeTask(taskOptions(root, project, factory));
	await writeFile(join(root, ".swe-forge", "agents", "reader.md"), "# Reader\n\nUpdated role loaded on the next call.\n");
	await executeSWEForgeTask(taskOptions(root, project, factory));

	assert.equal(records.length, 2);
	assert.notEqual(records[0].session, records[1].session);
	assert.match(records[0].input.systemPrompt, /Read-only canonical role\./u);
	assert.match(records[1].input.systemPrompt, /Updated role loaded on the next call\./u);
	assert.deepEqual(records[0].input.tools, READ_ONLY_TOOLS);
	assert.deepEqual(records[1].input.tools, READ_ONLY_TOOLS);
});

test("passes explicit model and thinking configuration without parent-setting fallback", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const records: SessionRecord[] = [];
	const factory = fakeSessionFactory("success", records);

	await executeSWEForgeTask(taskOptions(root, project, factory, { thinkingLevel: "high" }));
	await executeSWEForgeTask(taskOptions(root, project, factory, { thinkingLevel: undefined }));

	assert.equal(records[0].input.model, "fixture/model");
	assert.equal(records[0].input.thinkingLevel, "high");
	assert.equal(records[1].input.thinkingLevel, "medium");
});

test("uses only the settled final assistant message and ignores intermediate output", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const records: SessionRecord[] = [];
	const result = await executeSWEForgeTask(taskOptions(root, project, fakeSessionFactory("success", records)));

	assert.equal(result.output, RESULT_OUTPUT);
	assert.doesNotMatch(result.output, /intermediate/u);
	assert.equal(result.runtime.text, RESULT_OUTPUT);
});

test("runs the exact writable profile", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const records: SessionRecord[] = [];
	const result = await executeSWEForgeTask(
		taskOptions(root, project, fakeSessionFactory("success", records), {
			role: "writer",
			profile: "WRITABLE",
		}),
	);

	assert.equal(result.runtime.status, "completed");
	assert.deepEqual(result.runtime.tools, WRITABLE_TOOLS);
	assert.deepEqual(records[0].input.tools, WRITABLE_TOOLS);
});

test("serializes writers and releases the checkout after cancellation", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const firstRecords: SessionRecord[] = [];
	const secondRecords: SessionRecord[] = [];
	const controller = new AbortController();
	const first = executeSWEForgeTask(
		taskOptions(root, project, fakeSessionFactory("hang", firstRecords), {
			role: "writer",
			profile: "WRITABLE",
			signal: controller.signal,
		}),
	);
	await waitFor(() => firstRecords.length === 1);
	const second = executeSWEForgeTask(
		taskOptions(root, project, fakeSessionFactory("success", secondRecords), {
			role: "writer",
			profile: "WRITABLE",
		}),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(firstRecords.length, 1);
	assert.equal(secondRecords.length, 0);

	controller.abort();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.runtime.status, "aborted");
	assert.equal(firstRecords[0].aborted, true);
	assert.equal(firstRecords[0].disposed, true);
	assert.equal(secondResult.runtime.status, "completed");
	assert.equal(secondRecords.length, 1);
	assert.equal(secondRecords[0].disposed, true);
});

test("fails closed when final output exceeds the result bound", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const result = await executeSWEForgeTask(taskOptions(root, project, fakeSessionFactory("oversized", [])));

	assert.equal(result.output, "");
	assert.equal(result.runtime.status, "failed");
	assert.equal(result.runtime.outputTruncated, true);
	assert.match(result.runtime.errorMessage ?? "", /exceeded the 65536-byte limit/u);
	assert.equal(result.validation, undefined);
});

test("returns failed and aborted session states without canonical output", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const failed = await executeSWEForgeTask(taskOptions(root, project, fakeSessionFactory("error", [])));
	const missing = await executeSWEForgeTask(taskOptions(root, project, fakeSessionFactory("no-result", [])));

	assert.equal(failed.runtime.status, "failed");
	assert.equal(failed.output, "");
	assert.match(failed.runtime.errorMessage ?? "", /provider failed/u);
	assert.equal(missing.runtime.status, "failed");
	assert.match(missing.runtime.errorMessage ?? "", /canonical assistant result/u);
});

test("attaches runtime diagnostics without leaking model content on validation failure", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();

	await assert.rejects(
		executeSWEForgeTask(taskOptions(root, project, fakeSessionFactory("malformed", []))),
		(error: unknown) =>
			error instanceof SWEForgeRuntimeError &&
			error.code === "MISSING_OUTPUT_STRUCTURE" &&
			error.details &&
			(error.details.runtime as { status: string; text?: string; assistantMessage?: unknown }).status === "completed" &&
			(error.details.runtime as { text?: string }).text === undefined &&
			(error.details.runtime as { assistantMessage?: unknown }).assistantMessage === undefined,
	);
});

test("normalizes a symlinked cwd before acquiring the checkout lease", async () => {
	if (process.platform === "win32") return;
	const root = await createCanonicalRoot();
	const project = await createProject();
	const alias = `${project}-alias`;
	await symlink(project, alias, "dir");
	temporaryPaths.push(alias);
	const records: SessionRecord[] = [];
	const result = await executeSWEForgeTask(taskOptions(root, alias, fakeSessionFactory("success", records)));

	assert.equal(result.runtime.cwd, await realpath(project));
});

test("keeps the closed profiles and denylist immutable", () => {
	assert.throws(() => (READ_ONLY_TOOLS as unknown as string[]).push("bash"), TypeError);
	assert.throws(() => (WRITABLE_TOOLS as unknown as string[]).splice(0, 1), TypeError);
	assert.throws(() => (DELEGATION_TOOL_NAMES as unknown as string[]).push("nested_delegate"), TypeError);
	assert.deepEqual(getToolsForProfile("READ_ONLY"), ["read", "grep", "find", "ls"]);
	assert.deepEqual(getToolsForProfile("WRITABLE"), ["read", "grep", "find", "ls", "edit", "write", "bash"]);
	assert.equal(PI_COMPATIBILITY_POLICY.runtime, "in_process_agent_session");
});

test("fails before session creation when model or profile input is invalid", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const records: SessionRecord[] = [];
	await assert.rejects(
		executeSWEForgeTask({
			...taskOptions(root, project, fakeSessionFactory("success", records)),
			model: undefined,
		}),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "MISSING_MODEL",
	);
	assert.equal(records.length, 0);

	await assert.rejects(
		runChildAgent({
			task: "test",
			profile: "OTHER" as "READ_ONLY",
			sessionFactory: fakeSessionFactory("success", records),
		}),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "INVALID_TOOL_PROFILE",
	);
});

test("uses the SDK runtime and fails clearly for a model absent from its catalog", async () => {
	const project = await createProject();
	const result = await runChildAgent({
		task: "test",
		profile: "READ_ONLY",
		cwd: project,
		model: "fixture/model",
	});

	assert.equal(result.status, "failed");
	assert.match(result.errorMessage ?? "", /not available in the SDK catalog/u);
});

test("rejects a malformed canonical task before creating a session", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const records: SessionRecord[] = [];
	await assert.rejects(
		executeSWEForgeTask({
			...taskOptions(root, project, fakeSessionFactory("success", records)),
			taskContract: "OBJECTIVE: missing task id\n",
		}),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "MISSING_TASK_ID",
	);
	assert.equal(records.length, 0);
});

