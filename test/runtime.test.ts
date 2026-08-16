import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	executeSWEForgeTask,
	READ_ONLY_TOOLS,
	runChildAgent,
	isSupportedPiVersion,
	WRITABLE_TOOLS,
} from "../src/runtime.js";
import { SWE_FORGE_ROOT_ENV } from "../src/discovery.js";
import { SWEForgeRuntimeError } from "../src/projection.js";
import { copyFakeSWEForgeInstallation } from "./fixtures.js";

const temporaryPaths: string[] = [];
let fixturePath: string;

const TASK_CONTRACT = "# Task Contract\n\nTASK_ID: task-123\nOBJECTIVE: bounded fixture task\n";
const RESULT_OUTPUT = "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: fixture complete\nVALIDATION: fixture passed\n";
const REVIEW_OUTPUT = "STATUS: PASS\nTASK_ID: task-123\nREVIEW_FOCUS: fixture review\nFINDINGS: []\n";

const FIXTURE_SOURCE = String.raw`import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const promptIndex = args.indexOf("--append-system-prompt");
const promptPath = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const recordPath = process.env.SWE_FORGE_FIXTURE_RECORD;
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
  const output = mode === "review" ? ${JSON.stringify(REVIEW_OUTPUT)} : mode === "malformed" ? "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: incomplete\n" : mode === "truncated" ? "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: " + "x".repeat(300000) + "\nVALIDATION: fixture passed\n" : ${JSON.stringify(RESULT_OUTPUT)};
  const intermediate = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "intermediate" }], stopReason: "toolUse" } };
  const final = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop" } };
  const ended = { type: "agent_end", messages: [final.message] };
  process.stdout.write(JSON.stringify(intermediate) + "\n");
  process.stdout.write(JSON.stringify(final) + "\n");
  process.stdout.write(JSON.stringify(ended) + "\n");
}`;

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
) {
	return {
		roleName: profile === "READ_ONLY" ? "reader" : "writer",
		taskContract: TASK_CONTRACT,
		expectedOutputContract: "result" as const,
		profile,
		cwd: project,
		model,
		discovery: discovery(root),
		piCommand: process.execPath,
		piCommandArgs: [fixturePath],
		env: {
			SWE_FORGE_FIXTURE_RECORD: record,
			SWE_FORGE_FIXTURE_MODE: mode,
		},
	};
}

before(async () => {
	fixturePath = join(await mkdtemp(join(tmpdir(), "swe-forge-runtime-fixture-")), "child.mjs");
	temporaryPaths.push(fixturePath.slice(0, fixturePath.lastIndexOf("/")));
	await writeFile(fixturePath, FIXTURE_SOURCE, "utf8");
});

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
	// The fixture is recreated for the next test because afterEach also removes
	// the directory that contains it.
	fixturePath = join(await mkdtemp(join(tmpdir(), "swe-forge-runtime-fixture-")), "child.mjs");
	temporaryPaths.push(fixturePath.slice(0, fixturePath.lastIndexOf("/")));
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
	assert.equal(result.workerOutput, RESULT_OUTPUT);
	assert.equal(result.validation?.status, "DONE");
	assert.equal(result.runtime.status, "completed");
	assert.equal(result.runtime.profile, "READ_ONLY");
	assert.deepEqual(result.runtime.tools, READ_ONLY_TOOLS);
	assert.equal(result.runtime.cleanup, "complete");
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
	assert.match(record.prompt ?? "", /TASK_ID: task-123/u);
	assert.match(record.prompt ?? "", /EXPECTED CANONICAL RESULT CONTRACT/u);
	assert.ok(record.promptPath);
	await assert.rejects(access(record.promptPath));
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
				(error.details.runtime as { status: string }).status === "completed",
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

test("fails closed when model output is truncated", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const recordPathValue = await recordPath();
	const result = await executeSWEForgeTask(childOptions(root, project, recordPathValue, "truncated", "READ_ONLY"));

	assert.equal(result.runtime.status, "failed");
	assert.equal(result.runtime.outputTruncated, true);
	assert.match(result.runtime.errorMessage ?? "", /truncated/u);
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
