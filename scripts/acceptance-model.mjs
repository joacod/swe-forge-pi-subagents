import { readFileSync } from "node:fs";
import { join } from "node:path";

function nonEmptyTrimmed(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function modelFromPiSettings(env) {
	const configuredDirectory = nonEmptyTrimmed(env.PI_CODING_AGENT_DIR);
	const home = nonEmptyTrimmed(env.HOME);
	const settingsDirectory = configuredDirectory ?? (home ? join(home, ".pi", "agent") : undefined);
	if (!settingsDirectory) return undefined;

	try {
		const settings = JSON.parse(readFileSync(join(settingsDirectory, "settings.json"), "utf8"));
		if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;

		const provider = nonEmptyTrimmed(settings.defaultProvider);
		const model = nonEmptyTrimmed(settings.defaultModel);
		return provider && model ? `${provider}/${model}` : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the model used by real acceptance scenarios in priority order:
 * explicit acceptance configuration, Pi session metadata, then Pi settings.
 */
export function resolveAcceptanceModel(env = process.env) {
	const environment = env ?? {};
	const explicit = nonEmptyTrimmed(environment.SWE_FORGE_ACCEPTANCE_MODEL);
	if (explicit) return explicit;

	const provider = nonEmptyTrimmed(environment.PI_PROVIDER);
	const model = nonEmptyTrimmed(environment.PI_MODEL);
	if (provider && model) return `${provider}/${model}`;

	return modelFromPiSettings(environment);
}
