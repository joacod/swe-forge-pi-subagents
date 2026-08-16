import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	discoverSWEForgeInstallation,
	SWE_FORGE_ROOT_ENV,
	SWEForgeInstallationError,
} from "../src/discovery.js";
import { FAKE_SWE_FORGE_FIXTURE, copyFakeSWEForgeInstallation } from "./fixtures.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function populateInstallation(root: string, version = "0.1.0-alpha.1\n"): Promise<void> {
	await mkdir(root, { recursive: true });
	await cp(FAKE_SWE_FORGE_FIXTURE, root, { recursive: true });
	await writeFile(join(root, "VERSION"), version);
}

async function createInstallation(version = "0.1.0-alpha.1\n"): Promise<string> {
	const root = await copyFakeSWEForgeInstallation();
	temporaryRoots.push(root);
	await writeFile(join(root, "VERSION"), version);
	return root;
}

function override(root: string): { env: Record<string, string> } {
	return { env: { [SWE_FORGE_ROOT_ENV]: root } };
}

test("discovers a valid canonical installation", async () => {
	const root = await createInstallation();
	const installation = await discoverSWEForgeInstallation(override(root));
	const normalizedRoot = await realpath(root);

	assert.equal(installation.root, normalizedRoot);
	assert.equal(installation.version, "0.1.0-alpha.1");
	assert.equal(installation.paths.canonical, join(normalizedRoot, ".swe-forge"));
});

test("discovers the standard Pi support path", async () => {
	const home = await mkdtemp(join(tmpdir(), "swe-forge-home-"));
	temporaryRoots.push(home);
	const root = join(home, ".pi", "agent", "swe-forge");
	await populateInstallation(root, "0.1.1\n");

	const installation = await discoverSWEForgeInstallation({ env: {}, homeDirectory: home });

	assert.equal(installation.root, await realpath(root));
	assert.equal(installation.version, "0.1.1");
});

test("reports a missing installation with a typed error", async () => {
	const parent = await mkdtemp(join(tmpdir(), "swe-forge-missing-"));
	temporaryRoots.push(parent);
	const missingRoot = join(parent, "not-installed");

	await assert.rejects(
		discoverSWEForgeInstallation(override(missingRoot)),
		(error: unknown) =>
			error instanceof SWEForgeInstallationError &&
				error.code === "NOT_INSTALLED" &&
				error.root === missingRoot,
	);
});

test("reports partial and corrupt installations", async () => {
	const root = await mkdtemp(join(tmpdir(), "swe-forge-partial-"));
	temporaryRoots.push(root);
	await writeFile(join(root, "SWE-FORGE.md"), "canonical workflow\n");
	await writeFile(join(root, "AGENTS.md"), "instructions\n");
	await writeFile(join(root, ".swe-forge"), "not a directory\n");
	await writeFile(join(root, "VERSION"), "\n");

	await assert.rejects(
		discoverSWEForgeInstallation(override(root)),
		(error: unknown) =>
			error instanceof SWEForgeInstallationError &&
				error.code === "INCOMPLETE" &&
				error.invalid.some((entry) => entry.startsWith(".swe-forge")) &&
				error.invalid.some((entry) => entry.startsWith("VERSION")),
	);
});

test("uses the explicit override instead of the standard location", async () => {
	const root = await createInstallation("0.1.0\n");
	const installation = await discoverSWEForgeInstallation({
		env: { [SWE_FORGE_ROOT_ENV]: root },
		homeDirectory: join(root, "no-default-installation"),
	});

	assert.equal(installation.root, await realpath(root));
	assert.equal(installation.version, "0.1.0");
});

test("does not fall back when an explicit override is missing", async () => {
	const home = await mkdtemp(join(tmpdir(), "swe-forge-override-home-"));
	temporaryRoots.push(home);
	const missingRoot = join(home, "override-is-missing");

	await assert.rejects(
		discoverSWEForgeInstallation({
			env: { [SWE_FORGE_ROOT_ENV]: missingRoot },
			homeDirectory: home,
		}),
		(error: unknown) => error instanceof SWEForgeInstallationError && error.code === "NOT_INSTALLED",
	);
});

test("normalizes the override path before validating it", async () => {
	const root = await createInstallation();
	const spelling = `${root}/nested/../`;
	const installation = await discoverSWEForgeInstallation(override(spelling));

	assert.equal(installation.root, await realpath(root));
});

test("loads the detected version from the first VERSION line", async () => {
	const root = await createInstallation("0.1.0-alpha.1\nrelease metadata is ignored\n");
	const installation = await discoverSWEForgeInstallation(override(root));

	assert.equal(installation.version, "0.1.0-alpha.1");
});

test("rejects invalid and unsupported SWE-Forge versions instead of guessing", async () => {
	const invalid = await createInstallation("not-a-version\n");
	await assert.rejects(
		discoverSWEForgeInstallation(override(invalid)),
		(error: unknown) => error instanceof SWEForgeInstallationError && error.code === "INVALID_VERSION",
	);

	const unsupported = await createInstallation("0.2.0\n");
	await assert.rejects(
		discoverSWEForgeInstallation(override(unsupported)),
		(error: unknown) =>
			error instanceof SWEForgeInstallationError &&
				error.code === "UNSUPPORTED_VERSION" &&
				error.version === "0.2.0",
	);
});

test("accepts a BOM-prefixed semantic version", async () => {
	const root = await createInstallation("\uFEFF0.1.2\n");
	const installation = await discoverSWEForgeInstallation(override(root));
	assert.equal(installation.version, "0.1.2");
});

test("preserves symlinked support-root entries while validating their targets", async () => {
	if (process.platform === "win32") return;
	const root = await createInstallation();
	const target = join(root, ".swe-forge", "agents", "reader.md");
	const linked = join(root, ".swe-forge", "agents", "linked-reader.md");
	await symlink(target, linked);

	const installation = await discoverSWEForgeInstallation(override(root));
	assert.equal(installation.root, await realpath(root));
});
