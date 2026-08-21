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
	PI_COMPATIBILITY_POLICY,
	type BuiltinTool,
	type ChildToolProfile,
} from "./runtime.js";

/** The wire protocol version negotiated independently from the package version. */
export const SWE_FORGE_SUBAGENT_PROTOCOL_VERSION = 1 as const;

/**
 * Execution semantics advertised to the SWE-Forge adapter.
 *
 * These values describe context/process separation only. The child still uses
 * the caller's checkout, host process, and OS permissions; this is not a
 * filesystem or OS sandbox.
 */
export const SWE_FORGE_SUBAGENT_ISOLATION = Object.freeze({
	contextIsolation: true,
	processIsolation: false,
	filesystemIsolation: false,
	osSandbox: false,
} as const);

/** The trust boundary for writable child execution. */
export const SWE_FORGE_SUBAGENT_TRUST = Object.freeze({
	workerPermissions: "user_os_permissions",
	sandbox: false,
} as const);

/** Pi compatibility metadata for the public in-process AgentSession SDK. */
export const SWE_FORGE_SUBAGENT_PI = Object.freeze({
	compatibilityRange: PI_COMPATIBILITY_POLICY.range,
	runtime: PI_COMPATIBILITY_POLICY.runtime,
	versionVerification: PI_COMPATIBILITY_POLICY.verification,
} as const);

const AVAILABLE_PROFILES = Object.freeze(["READ_ONLY", "WRITABLE"] as const);

/** Fallback used only when a package manifest is unavailable in a test build. */
export const SWE_FORGE_SUBAGENT_PACKAGE_VERSION = "0.1.0";

export interface SWEForgeCompatibilityError {
	readonly code: string;
	readonly message: string;
}

export interface SWEForgeCapabilities {
	readonly protocolVersion: typeof SWE_FORGE_SUBAGENT_PROTOCOL_VERSION;
	readonly packageVersion: string;
	readonly pi: typeof SWE_FORGE_SUBAGENT_PI;
	readonly isolation: typeof SWE_FORGE_SUBAGENT_ISOLATION;
	readonly trust: typeof SWE_FORGE_SUBAGENT_TRUST;
	readonly sweForge: {
		readonly installed: boolean;
		readonly version?: string;
		readonly root?: string;
	};
	readonly roles: readonly string[];
	readonly readOnlyParallelSupport: true;
	readonly writableConcurrencySupport: false;
	readonly nestedDelegationSupport: false;
	readonly availableProfiles: typeof AVAILABLE_PROFILES;
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
	return Object.freeze({
		READ_ONLY: CHILD_TOOL_PROFILES.READ_ONLY,
		WRITABLE: CHILD_TOOL_PROFILES.WRITABLE,
	});
}

function freezeErrors(errors: readonly SWEForgeCompatibilityError[]): readonly SWEForgeCompatibilityError[] {
	return Object.freeze(errors.map((error) => Object.freeze({ ...error })));
}

function capabilityResult(
	base: Omit<SWEForgeCapabilities, "sweForge" | "roles" | "compatibilityErrors">,
	sweForge: SWEForgeCapabilities["sweForge"],
	roles: readonly string[],
	errors: readonly SWEForgeCompatibilityError[],
): SWEForgeCapabilities {
	return Object.freeze({
		...base,
		sweForge: Object.freeze({ ...sweForge }),
		roles: Object.freeze([...roles]),
		compatibilityErrors: freezeErrors(errors),
	});
}

function baseCapabilities(packageVersion: string) {
	return {
		protocolVersion: SWE_FORGE_SUBAGENT_PROTOCOL_VERSION,
		packageVersion,
		pi: SWE_FORGE_SUBAGENT_PI,
		isolation: SWE_FORGE_SUBAGENT_ISOLATION,
		trust: SWE_FORGE_SUBAGENT_TRUST,
		readOnlyParallelSupport: true as const,
		writableConcurrencySupport: false as const,
		nestedDelegationSupport: false as const,
		availableProfiles: AVAILABLE_PROFILES,
		profileTools: profileTools(),
	};
}

/**
 * Report only observed runtime capabilities. This is a capability probe, not
 * a topology, provider, or workflow decision. The package imports the public
 * AgentSession SDK directly; the declared compatibility line is not a CLI
 * subprocess probe.
 */
export async function getSWEForgeCapabilities(
	discovery: SWEForgeDiscoveryOptions = {},
): Promise<SWEForgeCapabilities> {
	const packageVersion = await readPackageVersion();
	const base = baseCapabilities(packageVersion);

	let installation;
	try {
		installation = await discoverSWEForgeInstallation(discovery);
	} catch (error) {
		const installationError = isSWEForgeInstallationError(error) ? error : undefined;
		return capabilityResult(
			base,
			{
				installed: false,
				...(installationError?.root === undefined ? {} : { root: installationError.root }),
			},
			[],
			[compatibilityError(error)],
		);
	}

	let roles: readonly string[] = [];
	const compatibilityErrors: SWEForgeCompatibilityError[] = [];
	try {
		roles = await discoverCanonicalRoleNames(discovery);
	} catch (error) {
		compatibilityErrors.push(compatibilityError(error));
	}

	return capabilityResult(
		base,
		{
			installed: true,
			version: installation.version,
			root: installation.root,
		},
		roles,
		compatibilityErrors,
	);
}
