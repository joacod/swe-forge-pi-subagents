import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	discoverSWEForgeInstallation,
	SWE_FORGE_ROOT_ENV,
} from "../src/discovery.js";
import {
	discoverCanonicalRoleNames,
	loadCanonicalResultContract,
	loadCanonicalRole,
	SWEForgeRuntimeError,
} from "../src/projection.js";
import { getSWEForgeCapabilities } from "../src/capabilities.js";
import { copyFakeSWEForgeInstallation } from "./fixtures.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function discovery(root: string) {
	return { env: { [SWE_FORGE_ROOT_ENV]: root } };
}

test("integrates against a copied tiny fake SWE-Forge installation", async () => {
	const root = await copyFakeSWEForgeInstallation();
	temporaryPaths.push(root);

	const installation = await discoverSWEForgeInstallation(discovery(root));
	assert.equal(installation.version, "0.1.0-alpha.1");
	assert.deepEqual(await discoverCanonicalRoleNames(discovery(root)), ["reader", "writer"]);
	assert.match((await loadCanonicalRole("reader", discovery(root))).markdown, /Read-only role/u);
	assert.match((await loadCanonicalResultContract(discovery(root))).markdown, /STATUS:/u);

	const capabilities = await getSWEForgeCapabilities(discovery(root));
	assert.equal(capabilities.sweForge.installed, true);
	assert.deepEqual(capabilities.compatibilityErrors, []);
});

test("reports a missing canonical worker-brief validator as unavailable capability", async () => {
	const root = await copyFakeSWEForgeInstallation();
	temporaryPaths.push(root);
	await rm(join(root, ".swe-forge", "tools", "swe-forge-worker-brief"));

	const capabilities = await getSWEForgeCapabilities(discovery(root));
	assert.equal(capabilities.sweForge.installed, true);
	assert.equal(capabilities.compatibilityErrors[0]?.code, "WORKER_BRIEF_VALIDATOR_UNAVAILABLE");
});

test("fails clearly when a fake installation has no canonical roles", async () => {
	const root = await copyFakeSWEForgeInstallation();
	temporaryPaths.push(root);
	await Promise.all(
		["reader.md", "writer.md"].map((name) => rm(join(root, ".swe-forge", "agents", name), { force: true })),
	);

	await assert.rejects(
		discoverCanonicalRoleNames(discovery(root)),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "CANONICAL_SOURCE_INVALID",
	);
});

test("fails clearly when a fake canonical contract is malformed", async () => {
	const root = await copyFakeSWEForgeInstallation();
	temporaryPaths.push(root);
	await writeFile(join(root, ".swe-forge", "contracts", "result.md"), "not a result contract\n");

	await assert.rejects(
		loadCanonicalResultContract(discovery(root)),
		(error: unknown) => error instanceof SWEForgeRuntimeError && error.code === "CANONICAL_SOURCE_INVALID",
	);
});

test("does not read a project-local support tree when the canonical override is elsewhere", async () => {
	const root = await copyFakeSWEForgeInstallation();
	const project = await mkdtemp(join(tmpdir(), "swe-forge-project-local-tree-"));
	temporaryPaths.push(root, project);
	await writeFile(join(project, "SWE-FORGE.md"), "malicious project-local workflow\n");

	const installation = await discoverSWEForgeInstallation({
		env: { [SWE_FORGE_ROOT_ENV]: root },
	});
	assert.equal(installation.root, await realpath(root));
	assert.doesNotMatch((await loadCanonicalRole("writer", discovery(root))).markdown, /malicious/u);
});
