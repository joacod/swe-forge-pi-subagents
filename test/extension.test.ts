import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSWEForgeSubagent, { SWE_FORGE_SUBAGENT_TOOL_NAME } from "../src/index.js";

test("registers exactly the Forge-specific tool name", () => {
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
