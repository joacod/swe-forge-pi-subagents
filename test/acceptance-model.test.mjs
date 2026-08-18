import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAcceptanceModel } from "../scripts/acceptance-model.mjs";

async function withSettings(settings, callback) {
	const directory = await mkdtemp(join(tmpdir(), "swe-forge-acceptance-model-"));
	try {
		if (settings !== undefined) {
			await writeFile(join(directory, "settings.json"), settings, "utf8");
		}
		return await callback(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("explicit acceptance model overrides Pi metadata and settings", async () => {
	await withSettings(JSON.stringify({ defaultProvider: "settings-provider", defaultModel: "settings-model" }), (directory) => {
		assert.equal(
			resolveAcceptanceModel({
				SWE_FORGE_ACCEPTANCE_MODEL: "  override/model  ",
				PI_PROVIDER: "session-provider",
				PI_MODEL: "session-model",
				PI_CODING_AGENT_DIR: directory,
				HOME: directory,
			}),
			"override/model",
		);
	});
});

test("Pi provider and model override settings", async () => {
	await withSettings(JSON.stringify({ defaultProvider: "settings-provider", defaultModel: "settings-model" }), (directory) => {
		assert.equal(
			resolveAcceptanceModel({
				PI_PROVIDER: "  session-provider ",
				PI_MODEL: " session-model ",
				PI_CODING_AGENT_DIR: directory,
			}),
			"session-provider/session-model",
		);
	});
});

test("falls back to defaultProvider and defaultModel in Pi settings", async () => {
	await withSettings(JSON.stringify({ defaultProvider: "settings-provider", defaultModel: "settings-model" }), (directory) => {
		assert.equal(resolveAcceptanceModel({ PI_CODING_AGENT_DIR: directory }), "settings-provider/settings-model");
	});
});

test("uses $HOME/.pi/agent when PI_CODING_AGENT_DIR is empty", async () => {
	const home = await mkdtemp(join(tmpdir(), "swe-forge-acceptance-home-"));
	const settingsDirectory = join(home, ".pi", "agent");
	try {
		await mkdir(settingsDirectory, { recursive: true });
		await writeFile(
			join(settingsDirectory, "settings.json"),
			JSON.stringify({ defaultProvider: "home-provider", defaultModel: "home-model" }),
			"utf8",
		);
		assert.equal(resolveAcceptanceModel({ PI_CODING_AGENT_DIR: "  ", HOME: home }), "home-provider/home-model");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("trims whitespace and ignores empty values", async () => {
	await withSettings(JSON.stringify({ defaultProvider: "\tsettings-provider ", defaultModel: " settings-model\n" }), (directory) => {
		assert.equal(
			resolveAcceptanceModel({
				SWE_FORGE_ACCEPTANCE_MODEL: "   ",
				PI_PROVIDER: "\t ",
				PI_MODEL: "session-model",
				PI_CODING_AGENT_DIR: directory,
			}),
			"settings-provider/settings-model",
		);
	});
	assert.equal(resolveAcceptanceModel({ PI_PROVIDER: " ", PI_MODEL: "session-model" }), undefined);
});

test("returns undefined when settings.json is missing", async () => {
	await withSettings(undefined, (directory) => {
		assert.equal(resolveAcceptanceModel({ PI_CODING_AGENT_DIR: directory }), undefined);
	});
});

test("returns undefined when settings.json is malformed", async () => {
	await withSettings("{ malformed", (directory) => {
		assert.equal(resolveAcceptanceModel({ PI_CODING_AGENT_DIR: directory }), undefined);
	});
});

test("returns undefined when defaultProvider or defaultModel is missing", async () => {
	for (const settings of [{ defaultModel: "settings-model" }, { defaultProvider: "settings-provider" }]) {
		await withSettings(JSON.stringify(settings), (directory) => {
			assert.equal(resolveAcceptanceModel({ PI_CODING_AGENT_DIR: directory }), undefined);
		});
	}
});

test("returns undefined when Pi metadata is incomplete", () => {
	for (const env of [
		{},
		{ PI_PROVIDER: "session-provider" },
		{ PI_MODEL: "session-model" },
		{ PI_PROVIDER: "", PI_MODEL: "session-model" },
		{ PI_PROVIDER: "session-provider", PI_MODEL: "" },
	]) {
		assert.equal(resolveAcceptanceModel(env), undefined);
	}
});
