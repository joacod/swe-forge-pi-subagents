import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { tmpdir } from "node:os";
import registerSWEForgeSubagent, { SWE_FORGE_SUBAGENT_TOOL_NAME } from "../src/index.js";
import * as packageEntry from "../src/index.js";
import { SWE_FORGE_ROOT_ENV } from "../src/discovery.js";
import { getSWEForgeCapabilities } from "../src/capabilities.js";
import { executeSWEForgeTask } from "../src/runtime.js";
import { SWEForgeRuntimeError } from "../src/projection.js";
import { copyFakeSWEForgeInstallation } from "./fixtures.js";

const temporaryRoots: string[] = [];
let fixtureDirectory: string;
let fixturePath: string;

const TASK_CONTRACT = "# Task Contract\n\nTASK_ID: task-123\nOBJECTIVE: bounded fixture task\n";
const READ_ONLY_TASK_CONTRACT = `${TASK_CONTRACT}write_access: read-only\n`;
const RESULT_OUTPUT = "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: fixture complete\nVALIDATION: fixture passed\n";

const FIXTURE_SOURCE = String.raw`import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const promptIndex = args.indexOf("--append-system-prompt");
const promptPath = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const recordPath = process.env.SWE_FORGE_FIXTURE_RECORD;
if (recordPath) writeFileSync(recordPath, JSON.stringify({ args, cwd: process.cwd(), promptPath, prompt: promptPath && existsSync(promptPath) ? readFileSync(promptPath, "utf8") : undefined }));

const mode = process.env.SWE_FORGE_FIXTURE_MODE ?? "success";
if (mode === "hang") {
  process.on("SIGTERM", () => process.exit(143));
  setInterval(() => {}, 1000);
} else if (mode === "malformed") {
  const message = { role: "assistant", content: [{ type: "text", text: "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: incomplete\n" }], stopReason: "stop" };
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\n");
} else {
  const message = { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(RESULT_OUTPUT)} }], stopReason: "stop" };
  process.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n");
  process.stdout.write(JSON.stringify({ type: "agent_end", messages: [message] }) + "\n");
}`;

interface RegisteredTool {
	readonly name: string;
	readonly execute: (...args: any[]) => Promise<any>;
}

async function createCanonicalRoot(): Promise<string> {
	const root = await copyFakeSWEForgeInstallation();
	temporaryRoots.push(root);
	await Promise.all([
		writeFile(join(root, ".swe-forge", "agents", "reader.md"), "# Reader\n\nRead-only role.\n"),
		writeFile(join(root, ".swe-forge", "agents", "writer.md"), "# Writer\n\nWritable role.\n"),
		writeFile(join(root, ".swe-forge", "contracts", "task.md"), TASK_CONTRACT),
		writeFile(
			join(root, ".swe-forge", "contracts", "result.md"),
			"STATUS: DONE | BLOCKED | FAILED\nTASK_ID: <task identifier>\nSUMMARY:\nVALIDATION:\n",
		),
		writeFile(
			join(root, ".swe-forge", "contracts", "review.md"),
			"status: PASS | CHANGES_REQUIRED\nreview_focus:\nfindings:\n",
		),
	]);
	return root;
}

function discovery(root: string) {
	return { env: { [SWE_FORGE_ROOT_ENV]: root } };
}

async function createProject(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "swe-forge-extension-project-"));
	temporaryRoots.push(project);
	return project;
}

async function createRecord(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "swe-forge-extension-record-"));
	temporaryRoots.push(directory);
	return join(directory, "child.json");
}

async function waitForFile(path: string): Promise<void> {
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

function registerTool(dependencies: Parameters<typeof registerSWEForgeSubagent>[1] = {}): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		registerTool(definition: RegisteredTool) {
			registered = definition;
		},
	} as unknown as ExtensionAPI;

	registerSWEForgeSubagent(pi, dependencies);
	assert.ok(registered);
	return registered;
}

function context(cwd: string): Record<string, unknown> {
	return {
		cwd,
		model: { provider: "fixture", id: "model" },
		thinkingLevel: "off",
	};
}

function withFixture(root: string, mode: string, record?: string) {
	return {
		executeTask: async (options: Parameters<typeof executeSWEForgeTask>[0]) => {
			const fixtureOptions = {
				...options,
				discovery: discovery(root),
				piCommand: process.execPath,
				piCommandArgs: [fixturePath],
				env: {
					...(record === undefined ? {} : { SWE_FORGE_FIXTURE_RECORD: record }),
					SWE_FORGE_FIXTURE_MODE: mode,
				},
			} as Parameters<typeof executeSWEForgeTask>[0];
			return executeSWEForgeTask(fixtureOptions);
		},
	};
}

before(async () => {
	fixtureDirectory = await mkdtemp(join(tmpdir(), "swe-forge-extension-fixture-"));
	fixturePath = join(fixtureDirectory, "child.mjs");
	await writeFile(fixturePath, FIXTURE_SOURCE, "utf8");
});

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

after(async () => {
	await rm(fixtureDirectory, { recursive: true, force: true });
});

test("keeps generic transport helpers and compatibility aliases out of the package entry point", () => {
	assert.equal("runChildAgent" in packageEntry, false);
	assert.equal("buildChildArgs" in packageEntry, false);
	assert.equal("resolvePiInvocation" in packageEntry, false);
	assert.equal("CheckoutScheduler" in packageEntry, false);
	assert.equal("runSWEForgeTask" in packageEntry, false);
	assert.equal("runSWEForgeSubagent" in packageEntry, false);
	assert.equal("discoverSWEForgeCapabilities" in packageEntry, false);
	assert.equal("workerOutput" in packageEntry, false);
});

test("registers exactly the Forge-specific tool and v1 actions", () => {
	const registered: Array<{ name: string }> = [];
	const pi = {
		registerTool(definition: { name: string }) {
			registered.push({ name: definition.name });
		},
	} as unknown as ExtensionAPI;

	registerSWEForgeSubagent(pi);

	assert.deepEqual(registered, [{ name: SWE_FORGE_SUBAGENT_TOOL_NAME }]);
	assert.notEqual(registered[0]?.name, "subagent");
});

test("returns machine-readable capabilities without workflow or provider decisions", async () => {
	const root = await createCanonicalRoot();
	const tool = registerTool({ getCapabilities: () => getSWEForgeCapabilities(discovery(root)) });
	const result = await tool.execute("capabilities", { action: "capabilities" }, undefined, undefined, context(root));
	const details = result.details as Awaited<ReturnType<typeof getSWEForgeCapabilities>>;

	assert.equal(result.isError, undefined);
	assert.equal(details.protocolVersion, 1);
	assert.equal(details.packageVersion, "0.1.0");
	assert.equal("extensionVersion" in details, false);
	assert.deepEqual(details.pi, {
		compatibilityRange: ">=0.84.1 <0.85.0",
		versionVerification: "before_execution",
	});
	assert.deepEqual(details.isolation, {
		contextIsolation: true,
		processIsolation: true,
		filesystemIsolation: false,
		osSandbox: false,
	});
	assert.deepEqual(details.trust, { workerPermissions: "user_os_permissions", sandbox: false });
	assert.equal(details.sweForge.version, "0.1.0-alpha.1");
	assert.equal(details.sweForge.root, await realpath(root));
	assert.deepEqual(details.roles, ["reader", "writer"]);
	assert.equal(details.readOnlyParallelSupport, true);
	assert.equal(details.writableConcurrencySupport, false);
	assert.equal(details.nestedDelegationSupport, false);
	assert.deepEqual(details.availableProfiles, ["READ_ONLY", "WRITABLE"]);
	assert.deepEqual(details.compatibilityErrors, []);
	assert.equal("provider" in details, false);
	assert.equal("workflow" in details, false);
	assert.deepEqual(JSON.parse(result.content[0].text), details);
	assert.throws(() => ((details as unknown as { packageVersion: string }).packageVersion = "mutated"), TypeError);
	assert.throws(() => (details.roles as unknown as string[]).push("mutated"), TypeError);
	assert.throws(() => (details.availableProfiles as unknown as string[]).push("OTHER"), TypeError);
	assert.throws(() => (details.profileTools.READ_ONLY as unknown as string[]).push("bash"), TypeError);
	assert.throws(() => ((details.pi as unknown as { compatibilityRange: string }).compatibilityRange = "*"), TypeError);
	assert.throws(() => ((details.isolation as unknown as { contextIsolation: boolean }).contextIsolation = false), TypeError);
	assert.throws(() => (details.compatibilityErrors as unknown as unknown[]).push({}), TypeError);
	assert.throws(() => ((details.sweForge as unknown as { installed: boolean }).installed = false), TypeError);

	const future = await getSWEForgeCapabilities(discovery(root));
	assert.equal(future.protocolVersion, 1);
	assert.deepEqual(future.profileTools.READ_ONLY, ["read", "grep", "find", "ls"]);
});

test("runs one valid read-only task with canonical output as primary content", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const tool = registerTool(withFixture(root, "success"));
	const result = await tool.execute(
		"run-read-only",
		{
			action: "run",
			role: "reader",
			taskContract: TASK_CONTRACT,
			expectedOutputContract: "result",
			profile: "READ_ONLY",
		},
		undefined,
		undefined,
		context(project),
	);

	assert.equal(result.content[0].text, RESULT_OUTPUT);
	assert.equal(result.details.runtime.status, "completed");
	assert.equal(result.details.runtime.profile, "READ_ONLY");
	assert.equal(result.details.runtime.text, undefined);
	assert.equal(result.details.runtime.assistantMessage, undefined);
	assert.equal(result.details.output, undefined);
	assert.equal(result.details.validation.status, "DONE");
});

test("runs one valid writable task with the canonical profile", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const tool = registerTool(withFixture(root, "success"));
	const result = await tool.execute(
		"run-writable",
		{
			action: "run",
			role: "writer",
			taskContract: TASK_CONTRACT,
			expectedOutputContract: "result",
			profile: "WRITABLE",
		},
		undefined,
		undefined,
		context(project),
	);

	assert.equal(result.content[0].text, RESULT_OUTPUT);
	assert.equal(result.details.runtime.profile, "WRITABLE");
});

test("rejects a role that is not canonical and reports the available boundary", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const tool = registerTool(withFixture(root, "success"));

	await assert.rejects(
		tool.execute(
			"missing-role",
			{
				action: "run",
				role: "missing",
				taskContract: TASK_CONTRACT,
				expectedOutputContract: "result",
				profile: "READ_ONLY",
			},
			undefined,
			undefined,
			context(project),
		),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "ROLE_NOT_FOUND" && /not discovered/u.test(error.message),
	);
});

test("reports an unavailable Forge installation through capabilities", async () => {
	const missingRoot = join(await mkdtemp(join(tmpdir(), "swe-forge-extension-missing-")), "not-installed");
	temporaryRoots.push(missingRoot.slice(0, missingRoot.lastIndexOf("/")));
	const tool = registerTool({ getCapabilities: () => getSWEForgeCapabilities(discovery(missingRoot)) });
	const result = await tool.execute("missing-forge", { action: "capabilities" }, undefined, undefined, context(process.cwd()));

	assert.equal(result.isError, true);
	assert.equal(result.details.sweForge.installed, false);
	assert.equal(result.details.compatibilityErrors[0].code, "NOT_INSTALLED");
	assert.match(result.details.compatibilityErrors[0].message, /not installed/u);
});

test("fails closed when canonical read-only metadata conflicts with writable access", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const record = await createRecord();
	const tool = registerTool(withFixture(root, "success", record));

	await assert.rejects(
		tool.execute(
			"access-conflict",
			{
				action: "run",
				role: "writer",
				taskContract: READ_ONLY_TASK_CONTRACT,
				expectedOutputContract: "result",
				profile: "WRITABLE",
			},
			undefined,
			undefined,
			context(project),
		),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "ACCESS_CONFLICT" && /requires READ_ONLY/u.test(error.message),
	);
	await assert.rejects(access(record));
});

test("rejects a malformed canonical worker result", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const tool = registerTool(withFixture(root, "malformed"));

	await assert.rejects(
		tool.execute(
			"malformed",
			{
				action: "run",
				role: "reader",
				taskContract: TASK_CONTRACT,
				expectedOutputContract: "result",
				profile: "READ_ONLY",
			},
			undefined,
			undefined,
			context(project),
		),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "MISSING_OUTPUT_STRUCTURE",
	);
});

test("returns cancellation as a failed bounded run and preserves cleanup metadata", async () => {
	const root = await createCanonicalRoot();
	const project = await createProject();
	const record = await createRecord();
	const tool = registerTool(withFixture(root, "hang", record));
	const controller = new AbortController();
	const promise = tool.execute(
		"cancel",
		{
			action: "run",
			role: "writer",
			taskContract: TASK_CONTRACT,
			expectedOutputContract: "result",
			profile: "WRITABLE",
		},
		controller.signal,
		undefined,
		context(project),
	);

	await waitForFile(record);
	controller.abort();
	const result = await promise;

	assert.equal(result.isError, true);
	assert.equal(result.details.runtime.status, "aborted");
	assert.equal(result.details.runtime.cleanup, "complete");
});
