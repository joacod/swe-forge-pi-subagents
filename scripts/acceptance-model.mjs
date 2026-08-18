function nonEmptyTrimmed(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the model used by real acceptance scenarios without selecting a
 * model that is unrelated to the active Pi Bash session.
 */
export function resolveAcceptanceModel(env = process.env) {
	const explicit = nonEmptyTrimmed(env.SWE_FORGE_ACCEPTANCE_MODEL);
	if (explicit) return explicit;

	const provider = nonEmptyTrimmed(env.PI_PROVIDER);
	const model = nonEmptyTrimmed(env.PI_MODEL);
	return provider && model ? `${provider}/${model}` : undefined;
}
