import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	discoverSWEForgeInstallation,
	isSWEForgeInstallationError,
	type SWEForgeDiscoveryOptions,
} from "./discovery.js";
import { discoverCanonicalRoleNames, isSWEForgeRuntimeError } from "./projection.js";
import {
	CHILD_TOOL_PROFILES,
	type BuiltinTool,
	type ChildToolProfile,
} from "./runtime.js";

/** Fallback used only when a package manifest is unavailable in a test build. */
export const SWE_FORGE_SUBAGENT_PACKAGE_VERSION = "0.1.0";

export interface SWEForgeCompatibilityError {
	readonly code: string;
	readonly message: string;
}

export interface SWEForgeCapabilities {
	readonly extensionVersion: string;
	readonly packageVersion: string;
	readonly sweForge: {
		readonly installed: boolean;
		readonly version?: string;
		readonly root?: string;
	};
	readonly roles: readonly string[];
	readonly readOnlyParallelSupport: true;
	readonly writableConcurrencySupport: false;
	readonly nestedDelegationSupport: false;
	readonly availableProfiles: readonly ChildToolProfile[];
	readonly profileTools: Readonly<Record<ChildToolProfile, readonly BuiltinTool[]>>;
	readonly compatibilityErrors: readonly SWEForgeCompatibilityError[];
}

function compatibilityError(error: unknown): SWEForgeCompatibilityError {
	if (isSWEForgeInstallationError(error) || isSWEForgeRuntimeError(error)) {
		return { code: error.code, message: error.message };
	}
	return {
		code: "UNKNOWN_COMPATIBILITY_ERROR",
		message: error instanceof Error ? error.message : String(error),
	};
}

async function readPackageVersion(): Promise<string> {
	const modulePath = fileURLToPath(import.meta.url);
	const candidates = [
		join(dirname(modulePath), "..", "package.json"),
		join(dirname(modulePath), "..", "..", "package.json"),
	];

	for (const path of candidates) {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"version" in parsed &&
				typeof parsed.version === "string" &&
				parsed.version.length > 0
			) {
				return parsed.version;
			}
		} catch {
			// Compiled test output may not copy the package manifest. Continue to the
			// next location and use the package's declared fallback below.
		}
	}
	return SWE_FORGE_SUBAGENT_PACKAGE_VERSION;
}

function profileTools(): Readonly<Record<ChildToolProfile, readonly BuiltinTool[]>> {
	return {
		READ_ONLY: [...CHILD_TOOL_PROFILES.READ_ONLY],
		WRITABLE: [...CHILD_TOOL_PROFILES.WRITABLE],
	};
}

/**
 * Report only observed runtime capabilities. This is a capability probe, not
 * a topology, provider, or workflow decision.
 */
export async function getSWEForgeCapabilities(
	discovery: SWEForgeDiscoveryOptions = {},
): Promise<SWEForgeCapabilities> {
	const packageVersion = await readPackageVersion();
	const profiles = profileTools();
	const base = {
		extensionVersion: packageVersion,
		packageVersion,
		roles: [] as readonly string[],
		readOnlyParallelSupport: true as const,
		writableConcurrencySupport: false as const,
		nestedDelegationSupport: false as const,
		availableProfiles: ["READ_ONLY", "WRITABLE"] as const,
		profileTools: profiles,
	};

	let installation;
	try {
		installation = await discoverSWEForgeInstallation(discovery);
	} catch (error) {
		const installationError = isSWEForgeInstallationError(error) ? error : undefined;
		return {
			...base,
			sweForge: {
				installed: false,
				...(installationError?.root === undefined ? {} : { root: installationError.root }),
			},
			compatibilityErrors: [compatibilityError(error)],
		};
	}

	let roles: readonly string[] = [];
	const compatibilityErrors: SWEForgeCompatibilityError[] = [];
	try {
		roles = await discoverCanonicalRoleNames(discovery);
	} catch (error) {
		compatibilityErrors.push(compatibilityError(error));
	}

	return {
		...base,
		roles,
		sweForge: {
			installed: true,
			version: installation.version,
			root: installation.root,
		},
		compatibilityErrors,
	};
}

/** Compatibility-friendly alias for callers that use discovery terminology. */
export const discoverSWEForgeCapabilities = getSWEForgeCapabilities;
