import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	executeSWEForgeTask,
	DELEGATION_TOOL_NAMES,
	READ_ONLY_TOOLS,
	runChildAgent,
	getToolsForProfile,
	isSupportedPiVersion,
	WRITABLE_TOOLS,
} from "../src/runtime.js";
import { SWE_FORGE_ROOT_ENV } from "../src/discovery.js";
import { MAX_WORKER_RESULT_BYTES, SWEForgeRuntimeError } from "../src/projection.js";
import { copyFakeSWEForgeInstallation } from "./fixtures.js";

const temporaryPaths: string[] = [];
let fixturePath: string;

const CANONICAL_TASK_CONTRACT = "# Task Contract\n\ntask_id: task-123\nobjective: bounded fixture task\n";
const WORKER_BRIEFING = `worker_briefing:
  schema: worker-brief/v1
  task_id: task-123
  worker:
    role: reader
    mode: delegated_worker
    depth: 1
    recursive_delegation: false
  objective: bounded fixture task
  permissions:
    write_access: read-only
    topology: SUBAGENTS
    write_isolation: SHARED
`;
const WRITABLE_WORKER_BRIEFING = WORKER_BRIEFING.replace("write_access: read-only", "write_access: read-write");
const RESULT_OUTPUT = "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: fixture complete\nVALIDATION: fixture passed\n";
const REVIEW_OUTPUT = "STATUS: PASS\nTASK_ID: task-123\nREVIEW_FOCUS: fixture review\nFINDINGS: []\n";

const FIXTURE_SOURCE = String.raw`import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const promptIndex = args.indexOf("--append-system-prompt");
const promptPath = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const recordPath = process.env.SWE_FORGE_FIXTURE_RECORD;
const probeRecordPath = process.env.SWE_FORGE_FIXTURE_PROBE_RECORD;
if (args.includes("--version")) {
  const versionFile = process.env.SWE_FORGE_FIXTURE_VERSION_FILE;
  const version = versionFile ? readFileSync(versionFile, "utf8").trim() : process.env.SWE_FORGE_FIXTURE_VERSION ?? "0.84.2";
  if (probeRecordPath) appendFileSync(probeRecordPath, "probe\n");
  const probeDelayMs = Number(process.env.SWE_FORGE_FIXTURE_PROBE_DELAY_MS ?? "0");
  if (probeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, probeDelayMs));
  process.stdout.write(version + "\n");
  process.exit(0);
}
const record = {
  args,
  cwd: process.cwd(),
  promptPath,
  prompt: promptPath && existsSync(promptPath) ? readFileSync(promptPath, "utf8") : undefined,
};
if (recordPath) writeFileSync(recordPath, JSON.stringify(record));

const mode = process.env.SWE_FORGE_FIXTURE_MODE ?? "success";
if (mode === "hang") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  process.stderr.write("fixture child failed\n");
  process.exit(7);
} else if (mode === "no-result") {
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
} else {
  if (mode === "noise") process.stdout.write("not-json\n");
  if (mode === "invalid-utf8") process.stdout.write(Buffer.from([123, 34, 116, 121, 112, 101, 34, 58, 34, 110, 111, 105, 115, 101, 34, 44, 34, 120, 34, 58, 34, 255, 34, 125, 10]));
  const sizePrefix = "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: ";
  const sizeSuffix = "\nVALIDATION: fixture passed\n";
  const requestedBytes = Number(process.env.SWE_FORGE_FIXTURE_RESULT_BYTES ?? "0");
  const sizedOutput = sizePrefix + "x".repeat(Math.max(0, requestedBytes - Buffer.byteLength(sizePrefix + sizeSuffix))) + sizeSuffix;
  const output = mode === "review" ? ${JSON.stringify(REVIEW_OUTPUT)} : mode === "malformed" ? "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: incomplete\n" : mode === "truncated" ? "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: " + "x".repeat(300000) + "\nVALIDATION: fixture passed\n" : mode === "sized" ? sizedOutput : ${JSON.stringify(RESULT_OUTPUT)};
  const usage = mode === "no-usage" ? undefined : { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 23, cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.02, total: 0.35 } };
  const intermediate = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "intermediate" }], stopReason: "toolUse" } };
  const finalMessage = { role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop", ...(usage ? { usage } : {}) };
  const final = { type: "message_end", message: finalMessage };
  const conflicting = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STATUS: BLOCKED\nTASK_ID: task-123\nSUMMARY: conflicting\nVALIDATION: fixture conflict\n" }], stopReason: "stop" } };
  const ended = { type: "agent_end", messages: [final.message] };
  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn_start" }) + "\n");
  process.stdout.write(JSON.stringify({ type: "message_update", usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ignored" } }) + "\n");
  process.stdout.write(JSON.stringify(intermediate) + "\n");
  if (mode === "conflicting") process.stdout.write(JSON.stringify(conflicting) + "\n");
  process.stdout.write(JSON.stringify(final) + "\n");
  process.stdout.write(JSON.stringify(ended) + "\n");
}`;

async function createCanonicalRoot(): Promise<string> {
	const root = await copyFakeSWEForgeInstallation();
	temporaryPaths.push(root);
	await Promise.all([
		writeFile(join(root, ".swe-forge", "agents", "reader.md"), "# Reader\n\nRead-only canonical role.\n"),
		writeFile(join(root, ".swe-forge", "agents", "writer.md"), "# Writer\n\nWritable canonical role.\n"),
		writeFile(join(root, ".swe-forge", "contracts", "task.md"), CANONICAL_TASK_CONTRACT),
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

async function recordPath(): Promise<string> {
	const record = await mkdtemp(join(tmpdir(), "swe-forge-runtime-record-"));
	temporaryPaths.push(record);
	return join(record, "child.json");
}

async function waitForRecord(path: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`fixture did not write ${path}`);
}

async function readRecord(path: string): Promise<{ args: string[]; cwd: string; promptPath?: string; prompt?: string }> {
	return JSON.parse(await readFile(path, "utf8")) as {
		args: string[];
		cwd: string;
		promptPath?: string;
		prompt?: string;
	};
}

async function readProbeCount(path: string): Promise<number> {
	try {
		return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

function optionValue(args: readonly string[], option: string): string | undefined {
	const index = args.indexOf(option);
	return index >= 0 ? args[index + 1] : undefined;
}

function childOptions(
	root: string,
	project: string,
	record: string,
	mode: string,
	profile: "READ_ONLY" | "WRITABLE",
	model = "fixture/model",
	extraEnv: NodeJS.ProcessEnv = {},
	piCommandArgs: readonly string[] = [fixturePath],
) {
	return {
		role: profile === "READ_ONLY" ? "reader" : "writer",
		workerBriefing: profile === "READ_ONLY" ? WORKER_BRIEFING : WRITABLE_WORKER_BRIEFING,
		expectedOutputContract: "result" as const,
		profile,
		cwd: project,
		model,
		discovery: discovery(root),
		piCommand: process.execPath,
		piCommandArgs,
		env: {
			SWE_FORGE_FIXTURE_RECORD: record,
			SWE_FORGE_FIXTURE_MODE: mode,
			...extraEnv,
		},
	};
}

before(async () => {
	fixturePath = join(await mkdtemp(join(tmpdir(), "swe-forge-runtime-fixture-")), "child.mjs");
	temporaryPaths.push(dirname(fixturePath));
	await writeFile(fixturePath, FIXTURE_SOURCE, "utf8");
});

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	// The fixture is recreated for the next test because afterEach also removes
	// the directory that contains it.
	fixturePath = join(await mkdtemp(join(tmpdir(), "swe-forge-runtime-fixture-")), "child.mjs");
	temporaryPaths.push(dirname(fixturePath));
	await writeFile(fixturePath, FIXTURE_SOURCE, "utf8");
});

after(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("runs a read-only role with only the READ_ONLY profile and removes prompt material", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "success", "READ_ONLY"));
	const record = await readRecord(recordPathValue);

	assert.equal(result.output, RESULT_OUTPUT);
	assert.equal(result.validation?.status, "DONE");
	assert.equal(result.runtime.status, "completed");
	assert.equal(result.runtime.profile, "READ_ONLY");
	assert.deepEqual(result.runtime.tools, READ_ONLY_TOOLS);
	assert.equal(result.runtime.cleanup, "complete");
	assert.ok((result.runtime.diagnostics?.compatibilityCheckDurationMs ?? -1) >= 0);
	assert.ok((result.runtime.diagnostics?.queueWaitDurationMs ?? -1) >= 0);
	assert.ok((result.runtime.diagnostics?.childStartupDurationMs ?? -1) >= 0);
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
	assert.equal(record.cwd, await realpath(project));
	assert.equal(optionValue(record.args, "--model"), "fixture/model");
	assert.equal(optionValue(record.args, "--tools"), READ_ONLY_TOOLS.join(","));
	assert.equal(record.args.includes("bash"), false);
	assert.equal(record.args.includes("--no-extensions"), true);
	assert.equal(record.args.includes("--no-skills"), true);
	assert.equal(record.args.includes("--no-prompt-templates"), true);
	assert.equal(record.args.includes("--no-themes"), true);
	assert.equal(record.args.includes("--no-context-files"), true);
	assert.equal(record.args.includes("--no-session"), true);
	assert.equal(record.args.includes("--no-approve"), true);
	assert.deepEqual(optionValue(record.args, "--exclude-tools")?.split(","), ["subagent", "swe_forge_subagent"]);
	assert.match(record.prompt ?? "", /Read-only canonical role\./u);
	assert.match(record.prompt ?? "", /task_id: task-123/u);
	assert.match(record.prompt ?? "", /=== WORKER BRIEFING ===[\s\S]*worker_briefing:/u);
	assert.doesNotMatch(record.prompt ?? "", /CANONICAL TASK CONTRACT|The task contract is authoritative/u);
	assert.match(record.prompt ?? "", /EXPECTED CANONICAL RESULT CONTRACT/u);
	assert.ok(record.promptPath);
	await assert.rejects(access(record.promptPath));
});

test("caches one successful Pi compatibility probe for repeated invocation configuration", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const probePath = await recordPath();
	const options = childOptions(root, project, recordPathValue, "success", "READ_ONLY", "fixture/model", {
		SWE_FORGE_FIXTURE_PROBE_RECORD: probePath,
	});

	const first = await executeSWEForgeTask(options);
	const second = await executeSWEForgeTask(options);

	assert.equal(first.runtime.status, "completed");
	assert.equal(second.runtime.status, "completed");
	assert.ok((first.runtime.diagnostics?.compatibilityCheckDurationMs ?? -1) >= 0);
	assert.equal(second.runtime.diagnostics?.compatibilityCheckDurationMs, undefined);
	assert.equal(await readProbeCount(probePath), 1);
});

test("coalesces concurrent compatibility probes for read-only workers", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const probePath = await recordPath();
	const options = childOptions(root, project, recordPathValue, "success", "READ_ONLY", "fixture/model", {
		SWE_FORGE_FIXTURE_PROBE_RECORD: probePath,
	});

	const [first, second] = await Promise.all([executeSWEForgeTask(options), executeSWEForgeTask(options)]);

	assert.equal(first.runtime.status, "completed");
	assert.equal(second.runtime.status, "completed");
	assert.equal(await readProbeCount(probePath), 1);
});

test("aborting one waiter does not abort another shared compatibility probe", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const probePath = await recordPath();
	const options = childOptions(root, project, recordPathValue, "success", "READ_ONLY", "fixture/model", {
		SWE_FORGE_FIXTURE_PROBE_RECORD: probePath,
		SWE_FORGE_FIXTURE_PROBE_DELAY_MS: "500",
	});
	const controller = new AbortController();
	const first = executeSWEForgeTask({ ...options, signal: controller.signal });
	await waitForRecord(probePath);
	const second = executeSWEForgeTask(options);
	await new Promise((resolve) => setTimeout(resolve, 100));
	controller.abort();

	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.runtime.status, "aborted");
	assert.equal(secondResult.runtime.status, "completed");
	assert.equal(await readProbeCount(probePath), 1);
});

test("does not cache an unsupported Pi version failure", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const probePath = await recordPath();
	const versionDirectory = await mkdtemp(join(tmpdir(), "swe-forge-runtime-version-"));
	temporaryPaths.push(versionDirectory);
	const versionPath = join(versionDirectory, "version.txt");
	await writeFile(versionPath, "0.85.0\n", "utf8");
	const options = childOptions(root, project, recordPathValue, "success", "READ_ONLY", "fixture/model", {
		SWE_FORGE_FIXTURE_PROBE_RECORD: probePath,
		SWE_FORGE_FIXTURE_VERSION_FILE: versionPath,
	});

	const unsupported = await executeSWEForgeTask(options);
	assert.equal(unsupported.runtime.status, "failed");
	assert.match(unsupported.runtime.errorMessage ?? "", /Unsupported Pi version/u);
	await assert.rejects(access(recordPathValue));

	await writeFile(versionPath, "0.84.2\n", "utf8");
	const supported = await executeSWEForgeTask(options);
	assert.equal(supported.runtime.status, "completed");
	assert.equal(await readProbeCount(probePath), 2);
});

test("executes successfully through the minimum supported Pi version probe", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const probePath = await recordPath();
	const result = await executeSWEForgeTask(
		childOptions(root, project, recordPathValue, "success", "READ_ONLY", "fixture/model", {
			SWE_FORGE_FIXTURE_PROBE_RECORD: probePath,
			SWE_FORGE_FIXTURE_VERSION: "0.84.1",
		}),
	);

	assert.equal(result.runtime.status, "completed");
	assert.equal(result.runtime.piVersion, "0.84.1");
	assert.equal(await readProbeCount(probePath), 1);
});

test("rechecks when the Pi invocation configuration changes", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const probePath = await recordPath();
	const options = childOptions(root, project, recordPathValue, "success", "READ_ONLY", "fixture/model", {
		SWE_FORGE_FIXTURE_PROBE_RECORD: probePath,
	});

	await executeSWEForgeTask(options);
	await executeSWEForgeTask(
		childOptions(
			root,
			project,
			recordPathValue,
			"success",
			"READ_ONLY",
			"fixture/model",
			{ SWE_FORGE_FIXTURE_PROBE_RECORD: probePath },
			[fixturePath, "alternate-invocation"],
		),
	);

	assert.equal(await readProbeCount(probePath), 2);
});

test("omits usage diagnostics when the final assistant message has no usage", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "no-usage", "READ_ONLY"));

	assert.equal(result.runtime.status, "completed");
	assert.equal(result.runtime.diagnostics?.usage, undefined);
});

test("normalizes a symlinked cwd before launching the child", async () => {
	if (process.platform === "win32") return;
	const root = await createCanonicalRoot();
	const project = await createProject();
	const alias = `${project}-alias`;
	await symlink(project, alias, "dir");
	temporaryPaths.push(alias);
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask({
		...childOptions(root, alias, recordPathValue, "success", "READ_ONLY"),
	});
	const record = await readRecord(recordPathValue);

	assert.equal(record.cwd, await realpath(project));
	assert.equal(result.runtime.cwd, await realpath(project));
});

test("runs a writable role with the exact WRITABLE profile", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "success", "WRITABLE"));
	const record = await readRecord(recordPathValue);

	assert.equal(result.runtime.profile, "WRITABLE");
	assert.deepEqual(result.runtime.tools, WRITABLE_TOOLS);
	assert.equal(optionValue(record.args, "--tools"), WRITABLE_TOOLS.join(","));
	assert.equal(result.runtime.status, "completed");
	assert.equal(result.runtime.cleanup, "complete");
});

test("serializes writable child runtimes in the same checkout", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const firstRecord = await recordPath();
	const secondRecord = await recordPath();
	const controller = new AbortController();
	const first = executeSWEForgeTask({
		...childOptions(root, project, firstRecord, "hang", "WRITABLE"),
		signal: controller.signal,
	});
	await waitForRecord(firstRecord);

	const second = executeSWEForgeTask(childOptions(root, project, secondRecord, "success", "WRITABLE"));
	await assert.rejects(access(secondRecord));

	controller.abort();
	const firstResult = await first;
	const secondResult = await second;
	assert.equal(firstResult.runtime.status, "aborted");
	assert.equal(secondResult.runtime.status, "completed");
	await access(secondRecord);
});

test("validates the canonical review contract as a separate expected output", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask({
		...childOptions(root, project, recordPathValue, "review", "READ_ONLY"),
		expectedOutputContract: "review",
	});

	assert.equal(result.output, REVIEW_OUTPUT);
	assert.equal(result.validation?.contract, "review");
	assert.equal(result.validation?.status, "PASS");
});

test("does not load canonical task.md into the per-launch prompt path", async () => {
	const root = await createCanonicalRoot();
	await rm(join(root, ".swe-forge", "contracts", "task.md"));
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "success", "READ_ONLY"));

	assert.equal(result.runtime.status, "completed");
	const record = await readRecord(recordPathValue);
	assert.match(record.prompt ?? "", /=== WORKER BRIEFING ===/u);
	assert.doesNotMatch(record.prompt ?? "", /CANONICAL TASK CONTRACT|Task Contract/u);
});

test("loads the canonical role and output contract dynamically for each invocation", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const firstRecord = await recordPath();
	await executeSWEForgeTask(childOptions(root, project, firstRecord, "success", "READ_ONLY"));
	await writeFile(join(root, ".swe-forge", "agents", "reader.md"), "# Reader\n\nUpdated role loaded on the next call.\n");
	const secondRecord = await recordPath();
	await executeSWEForgeTask(childOptions(root, project, secondRecord, "success", "READ_ONLY"));

	assert.match((await readRecord(firstRecord)).prompt ?? "", /Read-only canonical role\./u);
	assert.match((await readRecord(secondRecord)).prompt ?? "", /Updated role loaded on the next call\./u);
});

test("rejects conflicting canonical worker results", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "conflicting", "READ_ONLY"));

	assert.equal(result.runtime.status, "failed");
	assert.match(result.runtime.eventStreamError ?? "", /conflicting canonical assistant results/u);
	assert.equal(result.validation, undefined);
});

test("rejects a malformed worker result and still cleans up the prompt", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();

	await assert.rejects(
		executeSWEForgeTask(childOptions(root, project, recordPathValue, "malformed", "READ_ONLY")),
		(error: unknown) =>
			error instanceof SWEForgeRuntimeError &&
			error.code === "MISSING_OUTPUT_STRUCTURE" &&
			error.details &&
			(error.details.runtime as { status: string; text?: string; assistantMessage?: unknown }).status === "completed" &&
			error.details.output === undefined &&
			(error.details.runtime as { text?: string }).text === undefined &&
			(error.details.runtime as { assistantMessage?: unknown }).assistantMessage === undefined,
	);
	const record = await readRecord(recordPathValue);
	assert.ok(record.promptPath);
	await assert.rejects(access(record.promptPath));
});

test("returns child process errors as failed runtime metadata", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "error", "READ_ONLY"));

	assert.equal(result.runtime.status, "failed");
	assert.match(result.runtime.stderr, /fixture child failed/u);
	assert.equal(result.validation, undefined);
	assert.equal(result.runtime.cleanup, "complete");
});

test("fails clearly when a worker exits without a canonical result", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "no-result", "READ_ONLY"));

	assert.equal(result.runtime.status, "failed");
	assert.match(result.runtime.errorMessage ?? "", /canonical assistant result/u);
	assert.equal(result.validation, undefined);
});

test("fails closed on contaminated JSON output", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "noise", "READ_ONLY"));

	assert.equal(result.runtime.status, "failed");
	assert.match(result.runtime.errorMessage ?? "", /non-JSON event line/u);
	assert.equal(result.validation, undefined);
});

test("fails closed on invalid UTF-8 event data", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "invalid-utf8", "READ_ONLY"));

	assert.equal(result.runtime.status, "failed");
	assert.match(result.runtime.errorMessage ?? "", /invalid UTF-8/u);
	assert.equal(result.validation, undefined);
});

test("accepts a comfortably bounded worker result", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(
		childOptions(root, project, recordPathValue, "sized", "READ_ONLY", "fixture/model", {
			SWE_FORGE_FIXTURE_RESULT_BYTES: "1024",
		}),
	);

	assert.equal(result.runtime.status, "completed");
	assert.equal(Buffer.byteLength(result.output, "utf8"), 1024);
	assert.equal(result.validation?.status, "DONE");
});

test("accepts a worker result exactly at the named boundary", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(
		childOptions(root, project, recordPathValue, "sized", "READ_ONLY", "fixture/model", {
			SWE_FORGE_FIXTURE_RESULT_BYTES: String(MAX_WORKER_RESULT_BYTES),
		}),
	);

	assert.equal(result.runtime.status, "completed");
	assert.equal(Buffer.byteLength(result.output, "utf8"), MAX_WORKER_RESULT_BYTES);
});

test("fails closed without model-visible partial content above the result boundary", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(
		childOptions(root, project, recordPathValue, "sized", "READ_ONLY", "fixture/model", {
			SWE_FORGE_FIXTURE_RESULT_BYTES: String(MAX_WORKER_RESULT_BYTES + 1),
		}),
	);

	assert.equal(result.output, "");
	assert.equal(result.runtime.status, "failed");
	assert.equal(result.runtime.outputTruncated, true);
	assert.match(result.runtime.errorMessage ?? "", /exceeded the 65536-byte limit/u);
	assert.equal(result.validation, undefined);
});

test("fails closed when model output is truncated", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "truncated", "READ_ONLY"));

	assert.equal(result.runtime.status, "failed");
	assert.equal(result.runtime.outputTruncated, true);
	assert.match(result.runtime.errorMessage ?? "", /exceeded|truncated/u);
	assert.equal(result.validation, undefined);
});

test("propagates cancellation and removes temporary prompt material", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const controller = new AbortController();
	const promise = executeSWEForgeTask({
		...childOptions(root, project, recordPathValue, "hang", "WRITABLE"),
		signal: controller.signal,
	});
	await waitForRecord(recordPathValue);
	const record = await readRecord(recordPathValue);
	controller.abort();
	const result = await promise;

	assert.equal(result.runtime.status, "aborted");
	assert.equal(result.validation, undefined);
	assert.ok(record.promptPath);
	await assert.rejects(access(record.promptPath));
});

test("recognizes only the tested Pi compatibility line", () => {
	assert.equal(isSupportedPiVersion("0.84.1"), true);
	assert.equal(isSupportedPiVersion("0.84.2"), true);
	assert.equal(isSupportedPiVersion("0.85.0"), false);
	assert.equal(isSupportedPiVersion("0.84.1-beta.1"), false);
	assert.equal(isSupportedPiVersion("not-a-version"), false);
});

test("keeps the closed child profiles and delegation denylist immutable", () => {
	assert.throws(() => (READ_ONLY_TOOLS as unknown as string[]).push("bash"), TypeError);
	assert.throws(() => (WRITABLE_TOOLS as unknown as string[]).splice(0, 1), TypeError);
	assert.throws(() => (DELEGATION_TOOL_NAMES as unknown as string[]).push("nested_delegate"), TypeError);
	assert.deepEqual(getToolsForProfile("READ_ONLY"), ["read", "grep", "find", "ls"]);
	assert.deepEqual(getToolsForProfile("WRITABLE"), ["read", "grep", "find", "ls", "edit", "write", "bash"]);
});

test("fails before launch when no explicit model is supplied", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	await assert.rejects(
		executeSWEForgeTask({
			...childOptions(root, project, recordPathValue, "success", "READ_ONLY"),
			model: undefined,
		}),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "MISSING_MODEL",
	);
	await assert.rejects(access(recordPathValue));
});

test("fails closed for an unknown capability profile", async () => {
	await assert.rejects(
		runChildAgent({
			task: "test",
			profile: "OTHER" as "READ_ONLY",
			piCommand: process.execPath,
			piCommandArgs: [fixturePath],
		}),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "INVALID_TOOL_PROFILE",
	);
});

test("reports a missing Pi runtime as a failed child result", async () => {
	const result = await runChildAgent({
		task: "test",
		profile: "READ_ONLY",
		piCommand: join(tmpdir(), "missing-pi-executable"),
	});

	assert.equal(result.status, "failed");
	assert.match(result.errorMessage ?? "", /missing-pi-executable|ENOENT/u);
});
