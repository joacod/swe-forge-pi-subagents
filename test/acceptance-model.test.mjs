import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAcceptanceModel } from "../scripts/acceptance-model.mjs";

test("explicit acceptance model wins over Pi session metadata", () => {
	assert.equal(
		resolveAcceptanceModel({
			SWE_FORGE_ACCEPTANCE_MODEL: "  override/model  ",
			PI_PROVIDER: "active-provider",
			PI_MODEL: "active-model",
		}),
		"override/model",
	);
});

test("falls back to the active Pi provider and model", () => {
	assert.equal(
		resolveAcceptanceModel({ PI_PROVIDER: "  active-provider ", PI_MODEL: " active-model " }),
		"active-provider/active-model",
	);
});

test("returns undefined when Pi metadata is missing or incomplete", () => {
	for (const env of [
		{},
		{ PI_PROVIDER: "active-provider" },
		{ PI_MODEL: "active-model" },
		{ PI_PROVIDER: "", PI_MODEL: "active-model" },
		{ PI_PROVIDER: "active-provider", PI_MODEL: "" },
	]) {
		assert.equal(resolveAcceptanceModel(env), undefined);
	}
});

test("ignores whitespace-only values and lets a valid fallback through", () => {
	assert.equal(
		resolveAcceptanceModel({
			SWE_FORGE_ACCEPTANCE_MODEL: "   ",
			PI_PROVIDER: "\tactive-provider\n",
			PI_MODEL: "  active-model  ",
		}),
		"active-provider/active-model",
	);
	assert.equal(resolveAcceptanceModel({ PI_PROVIDER: " \t", PI_MODEL: "active-model" }), undefined);
});
