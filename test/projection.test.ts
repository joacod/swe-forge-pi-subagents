import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	MAX_WORKER_RESULT_BYTES,
	SWEForgeRuntimeError,
	composeRuntimePrompt,
	discoverCanonicalRoleNames,
	extractWorkerBriefingTaskIdentifier,
	loadCanonicalResultContract,
	loadCanonicalReviewContract,
	loadCanonicalRole,
	loadCanonicalTaskContract,
	validateCanonicalOutput,
	validateWorkerBriefing,
} from "../src/projection.js";
import { SWE_FORGE_ROOT_ENV } from "../src/discovery.js";
import { copyFakeSWEForgeInstallation } from "./fixtures.js";

const temporaryRoots: string[] = [];

const ROLE_MARKDOWN = "# Implementer\n\nCanonical role content.\n";
const UPDATED_ROLE_MARKDOWN = "# Implementer\n\nUpdated canonical role content.\n";
const CANONICAL_TASK_CONTRACT = "# Task Contract\n\ntask_id: task-123\nobjective: bounded work\n";
const WORKER_BRIEFING = `worker_briefing:
  schema: worker-brief/v1
  task_id: task-123
  worker:
    role: implementer
    mode: delegated_worker
    depth: 1
    recursive_delegation: false
  objective: bounded work
  permissions:
    write_access: read-only
    topology: SUBAGENTS
    write_isolation: SHARED
`;
const WRITABLE_WORKER_BRIEFING = WORKER_BRIEFING.replace("write_access: read-only", "write_access: read-write");
const RESULT_CONTRACT = "# Result Contract\n\nSTATUS: DONE | BLOCKED | FAILED\nSUMMARY:\nVALIDATION:\n";
const REVIEW_CONTRACT = "# Review Contract\n\nstatus: PASS | CHANGES_REQUIRED\nreview_focus:\nfindings:\n";

async function createCanonicalRoot(): Promise<string> {
	const root = await copyFakeSWEForgeInstallation();
	temporaryRoots.push(root);
	await Promise.all([
		writeFile(join(root, ".swe-forge", "agents", "implementer.md"), ROLE_MARKDOWN),
		writeFile(join(root, ".swe-forge", "agents", "reviewer.md"), "# Reviewer\n"),
		writeFile(join(root, ".swe-forge", "agents", "notes.txt"), "not a role\n"),
		writeFile(join(root, ".swe-forge", "contracts", "task.md"), CANONICAL_TASK_CONTRACT),
		writeFile(join(root, ".swe-forge", "contracts", "result.md"), RESULT_CONTRACT),
		writeFile(join(root, ".swe-forge", "contracts", "review.md"), REVIEW_CONTRACT),
	]);
	return root;
}

function discovery(root: string) {
	return { env: { [SWE_FORGE_ROOT_ENV]: root } };
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("discovers only safe canonical role names and ignores non-markdown files", async () => {
	const root = await createCanonicalRoot();
	await writeFile(join(root, ".swe-forge", "agents", "nested.md"), "not a role directory\n");

	assert.deepEqual(await discoverCanonicalRoleNames(discovery(root)), ["implementer", "nested", "reader", "reviewer", "writer"]);
});

test("loads a role by discovered name and rereads canonical markdown on every invocation", async () => {
	const root = await createCanonicalRoot();
	const first = await loadCanonicalRole("implementer", discovery(root));
	assert.equal(first.name, "implementer");
	assert.equal(first.markdown, ROLE_MARKDOWN);
	assert.equal(first.path, join(await realpath(root), ".swe-forge", "agents", "implementer.md"));

	await writeFile(join(root, ".swe-forge", "agents", "implementer.md"), UPDATED_ROLE_MARKDOWN);
	const second = await loadCanonicalRole("implementer", discovery(root));
	assert.equal(second.markdown, UPDATED_ROLE_MARKDOWN);
});

test("rejects traversal and path syntax before resolving a role", async () => {
	const root = await createCanonicalRoot();
	for (const roleName of ["../implementer", "nested/implementer", "..\\implementer", "/tmp/implementer", "C:\\tmp\\implementer", ".."]) {
		await assert.rejects(
			loadCanonicalRole(roleName, discovery(root)),
			(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "INVALID_ROLE_NAME",
		);
	}

	await assert.rejects(
		loadCanonicalRole("implementer.md", discovery(root)),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "ROLE_NOT_FOUND",
	);
	await assert.rejects(
		loadCanonicalRole("not-discovered", discovery(root)),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "ROLE_NOT_FOUND",
	);
});

test("loads the three fixed canonical contracts without translating their markdown", async () => {
	const root = await createCanonicalRoot();
	const task = await loadCanonicalTaskContract(discovery(root));
	const result = await loadCanonicalResultContract(discovery(root));
	const review = await loadCanonicalReviewContract(discovery(root));

	assert.equal(task.name, "task");
	assert.equal(task.markdown, CANONICAL_TASK_CONTRACT);
	assert.equal(result.name, "result");
	assert.equal(result.markdown, RESULT_CONTRACT);
	assert.equal(review.name, "review");
	assert.equal(review.markdown, REVIEW_CONTRACT);
});

test("composes the root-rendered worker briefing and concise runtime guardrails", async () => {
	const root = await createCanonicalRoot();
	const suppliedBriefing = WORKER_BRIEFING.replace("bounded work", "supplied bounded work");
	const prompt = await composeRuntimePrompt({
		role: "implementer",
		workerBriefing: suppliedBriefing,
		expectedOutputContract: "result",
		discovery: discovery(root),
	});

	assert.match(prompt, /=== CANONICAL ROLE ===[\s\S]*Canonical role content\./u);
	assert.match(prompt, /=== WORKER BRIEFING ===[\s\S]*supplied bounded work/u);
	assert.match(prompt, /=== EXPECTED CANONICAL RESULT CONTRACT ===[\s\S]*STATUS: DONE \| BLOCKED \| FAILED/u);
	for (const guardrail of [
		"The worker briefing is the authoritative root-rendered projection for this launch.",
		"Stay inside its scope and permissions.",
		"Do not infer or reconstruct omitted root-owned state.",
		"Do not perform delivery or integration actions.",
		"Do not delegate further.",
		"Return only the required canonical result output.",
	]) {
		assert.match(prompt, new RegExp(guardrail.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "u"));
	}
	assert.doesNotMatch(prompt, /CANONICAL TASK CONTRACT|The task contract is authoritative|create a PR|commit|push|merge/u);
});

test("composing an empty worker briefing is an explicit blocked runtime error", async () => {
	const root = await createCanonicalRoot();
	await assert.rejects(
		validateWorkerBriefing("\n\t"),
		(error: unknown) =>
			error instanceof SWEForgeRuntimeError &&
				error.code === "EMPTY_WORKER_BRIEFING" &&
				error.status === "BLOCKED",
	);
	await assert.rejects(
		composeRuntimePrompt({
			role: "implementer",
			workerBriefing: "",
			expectedOutputContract: "result",
			discovery: discovery(root),
		}),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "EMPTY_WORKER_BRIEFING",
	);
});

test("delegates structural validation before applying adapter-specific checks", async () => {
	const root = await createCanonicalRoot();
	assert.equal(extractWorkerBriefingTaskIdentifier(WORKER_BRIEFING), "task-123");
	assert.equal(extractWorkerBriefingTaskIdentifier("objective: no id\n"), undefined);
	assert.deepEqual(await validateWorkerBriefing(WORKER_BRIEFING, { discovery: discovery(root), expectedWriteAccess: "READ_ONLY" }), {
		valid: true,
		taskId: "task-123",
		writeAccess: "READ_ONLY",
		topology: "SUBAGENTS",
		writeIsolation: "SHARED",
	});
	assert.equal(
		(await validateWorkerBriefing(WRITABLE_WORKER_BRIEFING, {
			discovery: discovery(root),
			expectedWriteAccess: "WRITABLE",
		})).writeAccess,
		"WRITABLE",
	);

	await assert.rejects(
		validateWorkerBriefing(`${WORKER_BRIEFING}\nCANONICAL_REJECT`, { discovery: discovery(root) }),
		(error: unknown) =>
			error instanceof SWEForgeRuntimeError &&
				error.code === "INVALID_WORKER_BRIEFING" &&
				error.status === "BLOCKED" &&
				/fixture canonical validator rejected/u.test(error.message),
	);
});

test("reports an unavailable canonical worker-brief validator", async () => {
	const root = await createCanonicalRoot();
	await rm(join(root, ".swe-forge", "tools", "swe-forge-worker-brief"));

	await assert.rejects(
		validateWorkerBriefing(WORKER_BRIEFING, { discovery: discovery(root) }),
		(error: unknown) =>
			error instanceof SWEForgeRuntimeError &&
				error.code === "WORKER_BRIEF_VALIDATOR_UNAVAILABLE" &&
				error.status === "FAILED",
	);
});

test("keeps profile, topology, isolation, and task identity checks in the adapter", async () => {
	const root = await createCanonicalRoot();
	await assert.rejects(
		validateWorkerBriefing(WORKER_BRIEFING, { discovery: discovery(root), expectedWriteAccess: "WRITABLE" }),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "ACCESS_CONFLICT",
	);
	await assert.rejects(
		validateWorkerBriefing(WORKER_BRIEFING.replace("topology: SUBAGENTS", "topology: SOLO"), { discovery: discovery(root) }),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "INVALID_WORKER_BRIEFING",
	);
	await assert.rejects(
		validateWorkerBriefing(WORKER_BRIEFING.replace("write_isolation: SHARED", "write_isolation: WORKTREE"), { discovery: discovery(root) }),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "INVALID_WORKER_BRIEFING",
	);
	await assert.rejects(
		validateWorkerBriefing(WORKER_BRIEFING.replace("  task_id: task-123", "  task_id: <assigned task identifier>"), { discovery: discovery(root) }),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "MISSING_TASK_ID",
	);
});

test("uses the assigned worker task path instead of completed dependency task IDs", async () => {
	const briefing = `worker_briefing:
  schema: worker-brief/v1
  task_id: implementation-B
  worker:
    role: reader
    mode: delegated_worker
    depth: 1
    recursive_delegation: false
  objective: inspect implementation dependencies
  dependencies:
    completed:
      - task_id: discovery-A
        dependency_digest:
          relevant_facts:
            - interface X is canonical
  permissions:
    write_access: read-only
    topology: SUBAGENTS
    write_isolation: SHARED
`;

	assert.equal(extractWorkerBriefingTaskIdentifier(briefing), "implementation-B");
	const root = await createCanonicalRoot();
	assert.deepEqual(await validateWorkerBriefing(briefing, { discovery: discovery(root), expectedWriteAccess: "READ_ONLY" }), {
		valid: true,
		taskId: "implementation-B",
		writeAccess: "READ_ONLY",
		topology: "SUBAGENTS",
		writeIsolation: "SHARED",
	});
});

test("rejects a worker briefing above the bounded input limit", async () => {
	const oversized = WORKER_BRIEFING + "x".repeat(512 * 1024);
	await assert.rejects(
		validateWorkerBriefing(oversized),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "WORKER_BRIEFING_TOO_LARGE",
	);
});

test("validates result status, structure, and delegated TASK_ID", () => {
	const output = "STATUS: DONE\nTASK_ID: task-123\nSUMMARY:\nVALIDATION:\n";
	assert.deepEqual(validateCanonicalOutput(output, "result", { taskId: "task-123" }), {
		valid: true,
		status: "DONE",
		contract: "result",
		taskId: "task-123",
		structure: "recognizable",
	});

	const blocked = validateCanonicalOutput(
		"STATUS: BLOCKED\nTASK_ID: task-123\nSUMMARY:\nVALIDATION:\n",
		"result",
		{ taskId: "task-123" },
	);
	assert.equal(blocked.status, "BLOCKED");
	assert.equal(blocked.valid, true);
});

test("blocks malformed output instead of treating it as a successful result", () => {
	const cases: Array<{ output: string; code: string }> = [
		{ output: "TASK_ID: task-123\nSUMMARY:\nVALIDATION:\n", code: "MISSING_STATUS" },
		{ output: "STATUS: DONE | BLOCKED | FAILED\nTASK_ID: task-123\nSUMMARY:\nVALIDATION:\n", code: "INVALID_STATUS" },
		{ output: "STATUS: DONE\nTASK_ID: task-123\n", code: "MISSING_OUTPUT_STRUCTURE" },
		{ output: "STATUS: DONE\nTASK_ID: other\nSUMMARY:\nVALIDATION:\n", code: "TASK_ID_MISMATCH" },
		{ output: "STATUS: DONE\nSUMMARY:\nVALIDATION:\n", code: "MISSING_TASK_ID" },
	];

	for (const testCase of cases) {
		assert.throws(
			() => validateCanonicalOutput(testCase.output, "result", { taskId: "task-123" }),
			(error: unknown) =>
				error instanceof SWEForgeRuntimeError &&
				error.code === testCase.code &&
				error.status === "BLOCKED",
		);
	}
});

test("recognizes the current SWE-Forge result contract shape", () => {
	const output = "RESULT_PROFILE: READ_ONLY\nSTATUS: DONE\nTASK_ID: task-123\nFINDINGS:\n- current contract\nEVIDENCE:\n- projection.test.ts\n";

	assert.deepEqual(validateCanonicalOutput(output, "result", { taskId: "task-123" }), {
		valid: true,
		status: "DONE",
		contract: "result",
		taskId: "task-123",
		structure: "recognizable",
	});
});

test("rejects canonical output above the model-visible worker result limit", () => {
	const prefix = "STATUS: DONE\nTASK_ID: task-123\nSUMMARY: ";
	const suffix = "\nVALIDATION: fixture passed\n";
	const output = prefix + "x".repeat(MAX_WORKER_RESULT_BYTES - Buffer.byteLength(prefix + suffix) + 1) + suffix;

	assert.throws(
		() => validateCanonicalOutput(output, "result"),
		(error: unknown) =>
			error instanceof SWEForgeRuntimeError &&
				error.code === "OUTPUT_TOO_LARGE" &&
				error.details?.maxBytes === MAX_WORKER_RESULT_BYTES,
	);
});

test("rejects statuses outside the canonical output contract", () => {
	assert.throws(
		() => validateCanonicalOutput("STATUS: UNKNOWN\nTASK_ID: task-123\nSUMMARY:\nVALIDATION:\n", "result"),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "INVALID_STATUS",
	);
});

test("validates the recognizable review contract and optional task identity", () => {
	const review = validateCanonicalOutput(
		"status: PASS\nreview_focus:\nfindings: []\nTASK_ID: task-123\n",
		"review",
		{ taskId: "task-123" },
	);
	assert.equal(review.status, "PASS");
	assert.equal(review.taskId, "task-123");

	assert.throws(
		() => validateCanonicalOutput("status: PASS\nreview_focus:\nfindings: []\nTASK_ID: other\n", "review", { taskId: "task-123" }),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "TASK_ID_MISMATCH",
	);
});
