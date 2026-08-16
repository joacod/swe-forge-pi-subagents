import { realpath, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

/** The only supported development/test override for the canonical root. */
export const SWE_FORGE_ROOT_ENV = "SWE_FORGE_ROOT";

/**
 * The adapter deliberately supports one SWE-Forge compatibility line. The
 * canonical files are loaded live, but a version outside this line is not
 * assumed to have the same role/contract semantics.
 */
export const SWE_FORGE_COMPATIBILITY_POLICY = {
	range: "0.1.x",
	minimumTested: "0.1.0-alpha.1",
	maximumExclusive: "0.2.0",
} as const;

const DEFAULT_SUPPORT_PATH = join(".pi", "agent", "swe-forge");
const REQUIRED_ENTRIES = [
	{ name: "SWE-FORGE.md", kind: "file" },
	{ name: "AGENTS.md", kind: "file" },
	{ name: ".swe-forge", kind: "directory" },
	{ name: "VERSION", kind: "file" },
] as const;

type RequiredEntry = (typeof REQUIRED_ENTRIES)[number];
export type SWEForgeInstallationErrorCode =
	| "NOT_INSTALLED"
	| "INCOMPLETE"
	| "INVALID_PATH"
	| "INVALID_VERSION"
	| "UNSUPPORTED_VERSION";

export interface SWEForgeInstallationErrorOptions {
	readonly root?: string;
	readonly version?: string;
	readonly missing?: readonly string[];
	readonly invalid?: readonly string[];
	readonly cause?: unknown;
}

/** A typed failure from canonical SWE-Forge support-root discovery. */
export class SWEForgeInstallationError extends Error {
	readonly code: SWEForgeInstallationErrorCode;
	readonly root?: string;
	readonly version?: string;
	readonly missing: readonly string[];
	readonly invalid: readonly string[];
	readonly cause?: unknown;

	constructor(code: SWEForgeInstallationErrorCode, message: string, options: SWEForgeInstallationErrorOptions = {}) {
		super(message);
		this.name = "SWEForgeInstallationError";
		this.code = code;
		this.root = options.root;
		this.version = options.version;
		this.missing = options.missing ?? [];
		this.invalid = options.invalid ?? [];
		this.cause = options.cause;
	}
}

/** Backwards-compatible descriptive alias for callers that prefer discovery terminology. */
export { SWEForgeInstallationError as SWEForgeDiscoveryError };

export interface SWEForgeInstallation {
	/** The normalized, real support-root path. */
	readonly root: string;
	/** The first line of the canonical VERSION file. */
	readonly version: string;
	readonly paths: {
		readonly specification: string;
		readonly instructions: string;
		readonly canonical: string;
		readonly version: string;
	};
}

export interface SWEForgeDiscoveryOptions {
	/** Injectable environment for tests; the only supported override is SWE_FORGE_ROOT. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Injectable home directory for tests; not a second user configuration mechanism. */
	readonly homeDirectory?: string;
}

export interface SWEForgeVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease?: string;
	readonly build?: string;
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

/** Parse the strict semantic version format used by the canonical VERSION file. */
export function parseSWEForgeVersion(value: string): SWEForgeVersion | undefined {
	const match = SEMVER_PATTERN.exec(value.trim());
	if (!match) return undefined;
	const prerelease = match[4];
	if (
		prerelease?.split(".").some(
			(identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
		)
	) {
		return undefined;
	}
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		...(match[4] === undefined ? {} : { prerelease: match[4] }),
		...(match[5] === undefined ? {} : { build: match[5] }),
	};
}

/** Return whether a canonical installation is inside the tested compatibility line. */
export function isSupportedSWEForgeVersion(value: string): boolean {
	const version = parseSWEForgeVersion(value);
	return version !== undefined && version.major === 0 && version.minor === 1;
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function normalizeRoot(input: string, baseDirectory: string): string {
	if (input.length === 0 || input.includes("\0")) {
		throw new SWEForgeInstallationError(
			"INVALID_PATH",
			`SWE Forge support root is not a valid filesystem path: ${JSON.stringify(input)}`,
		);
	}

	const normalized = normalize(resolve(baseDirectory, input));
	if (!isAbsolute(normalized)) {
		throw new SWEForgeInstallationError(
			"INVALID_PATH",
			`SWE Forge support root did not resolve to an absolute path: ${JSON.stringify(input)}`,
		);
	}
	return normalized;
}

function entryPath(root: string, entry: RequiredEntry): string {
	return normalize(join(root, entry.name));
}

async function canonicalizeRoot(root: string, configuredByOverride: boolean): Promise<string> {
	try {
		const rootStats = await stat(root);
		if (!rootStats.isDirectory()) {
			throw new SWEForgeInstallationError(
				"INCOMPLETE",
				`SWE Forge support root is not a directory: ${root}`,
				{ root },
			);
		}
		return normalize(await realpath(root));
	} catch (error) {
		if (error instanceof SWEForgeInstallationError) throw error;
		const code = errorCode(error);
		if (code === "ENOENT" || code === "ENOTDIR") {
			const source = configuredByOverride ? `from ${SWE_FORGE_ROOT_ENV}` : "at the standard Pi location";
			throw new SWEForgeInstallationError(
				"NOT_INSTALLED",
				`SWE Forge is not installed ${source}: ${root}`,
				{ root, cause: error },
			);
		}
		throw new SWEForgeInstallationError(
			"INCOMPLETE",
			`SWE Forge support root could not be inspected: ${root}`,
			{ root, cause: error },
		);
	}
}

async function validateEntries(root: string): Promise<{ missing: string[]; invalid: string[] }> {
	const missing: string[] = [];
	const invalid: string[] = [];

	for (const entry of REQUIRED_ENTRIES) {
		const path = entryPath(root, entry);
		try {
			const info = await stat(path);
			const correctType = entry.kind === "file" ? info.isFile() : info.isDirectory();
			if (!correctType) invalid.push(entry.name);
			else if (entry.kind === "file" && entry.name !== "VERSION" && info.size === 0) {
				invalid.push(`${entry.name} (empty)`);
			}
		} catch (error) {
			const code = errorCode(error);
			if (code === "ENOENT" || code === "ENOTDIR") missing.push(entry.name);
			else invalid.push(entry.name);
		}
	}

	return { missing, invalid };
}

/**
 * Locate and validate the installed SWE-Forge support root.
 *
 * By default this reads ~/.pi/agent/swe-forge. For development or tests only,
 * set SWE_FORGE_ROOT to an alternate support root. An invalid override is an
 * error; discovery never falls back to the default or to project-local files.
 */
export async function discoverSWEForgeInstallation(
	options: SWEForgeDiscoveryOptions = {},
): Promise<SWEForgeInstallation> {
	const environment = options.env ?? process.env;
	const override = environment[SWE_FORGE_ROOT_ENV];
	const homeDirectory = options.homeDirectory ?? homedir();
	const baseDirectory = normalizeRoot(homeDirectory, process.cwd());
	const requestedRoot = override === undefined ? join(baseDirectory, DEFAULT_SUPPORT_PATH) : override;
	const normalizedRoot = normalizeRoot(requestedRoot, process.cwd());
	const root = await canonicalizeRoot(normalizedRoot, override !== undefined);
	const { missing, invalid } = await validateEntries(root);

	let version: string | undefined;
	let invalidVersion = false;
	const versionPath = entryPath(root, { name: "VERSION", kind: "file" });
	if (!missing.includes("VERSION") && !invalid.includes("VERSION")) {
		try {
			const contents = await readFile(versionPath, "utf8");
			const candidate = contents.split(/\r?\n/u, 1)[0]?.replace(/^\uFEFF/u, "").trim();
			if (!candidate || candidate.includes("\0") || parseSWEForgeVersion(candidate) === undefined) {
				invalidVersion = true;
			} else {
				version = candidate;
			}
		} catch {
			invalid.push("VERSION (unreadable)");
		}
	}

	if (invalidVersion && (missing.length > 0 || invalid.length > 0)) {
		invalid.push("VERSION (invalid semantic version)");
	}

	if (missing.length > 0 || invalid.length > 0) {
		const problems = [
			missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
			invalid.length > 0 ? `invalid: ${invalid.join(", ")}` : "",
		].filter(Boolean).join("; ");
		throw new SWEForgeInstallationError(
			"INCOMPLETE",
			`SWE Forge installation is incomplete at ${root} (${problems})`,
			{ root, missing, invalid },
		);
	}

	if (invalidVersion) {
		throw new SWEForgeInstallationError(
			"INVALID_VERSION",
			`SWE Forge VERSION is not a strict semantic version at ${versionPath}`,
			{ root, invalid: ["VERSION"] },
		);
	}

	if (!version) {
		throw new SWEForgeInstallationError(
			"INCOMPLETE",
			`SWE Forge VERSION could not be loaded at ${versionPath}`,
			{ root, invalid: ["VERSION"] },
		);
	}

	if (!isSupportedSWEForgeVersion(version)) {
		throw new SWEForgeInstallationError(
			"UNSUPPORTED_VERSION",
			`SWE Forge version ${version} is outside the supported compatibility line ${SWE_FORGE_COMPATIBILITY_POLICY.range}; refusing to guess canonical semantics.`,
			{ root, version },
		);
	}

	return {
		root,
		version,
		paths: {
			specification: entryPath(root, { name: "SWE-FORGE.md", kind: "file" }),
			instructions: entryPath(root, { name: "AGENTS.md", kind: "file" }),
			canonical: entryPath(root, { name: ".swe-forge", kind: "directory" }),
			version: versionPath,
		},
	};
}

/** Alias emphasizing that the result is a validated root record, not a copy. */
export const discoverSWEForgeRoot = discoverSWEForgeInstallation;

export function isSWEForgeInstallationError(error: unknown): error is SWEForgeInstallationError {
	return error instanceof SWEForgeInstallationError;
}
