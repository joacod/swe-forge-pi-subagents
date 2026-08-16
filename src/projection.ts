import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, posix, win32 } from "node:path";
import { discoverSWEForgeInstallation } from "./discovery.js";
import type { SWEForgeDiscoveryOptions, SWEForgeInstallation } from "./discovery.js";

const ROLE_DIRECTORY_NAME = "agents";
const ROLE_FILE_SUFFIX = ".md";

const CANONICAL_CONTRACT_NAMES = ["task", "result", "review"] as const;
const EXPECTED_OUTPUT_CONTRACT_NAMES = ["result", "review"] as const;

const CONTRACT_FILE_NAMES: Record<CanonicalContractName, string> = {
	task: "task.md",
	result: "result.md",
	review: "review.md",
};

/** Names of canonical contract files supported by the runtime projection. */
export type CanonicalContractName = (typeof CANONICAL_CONTRACT_NAMES)[number];

/** The output contract a delegated runtime is expected to return. */
export type ExpectedOutputContract = (typeof EXPECTED_OUTPUT_CONTRACT_NAMES)[number];

export type SWEForgeRuntimeErrorStatus = "BLOCKED" | "FAILED";

export type SWEForgeRuntimeErrorCode =
	| "INVALID_ACTION"
	| "INVALID_ROLE_NAME"
	| "ROLE_NOT_FOUND"
	| "INVALID_CONTRACT_NAME"
	| "CANONICAL_SOURCE_UNAVAILABLE"
	| "EMPTY_TASK_CONTRACT"
	| "MISSING_TASK_ID"
	| "INVALID_EXPECTED_TASK_ID"
	| "INVALID_TASK_ACCESS"
	| "ACCESS_CONFLICT"
	| "EMPTY_OUTPUT"
	| "INVALID_EXPECTED_OUTPUT_CONTRACT"
	| "MISSING_STATUS"
	| "INVALID_STATUS"
	| "MISSING_OUTPUT_STRUCTURE"
	| "TASK_ID_MISMATCH"
	| "INVALID_TOOL_PROFILE"
	| "MISSING_MODEL";

export interface SWEForgeRuntimeErrorOptions {
	readonly status?: SWEForgeRuntimeErrorStatus;
	readonly cause?: unknown;
	readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A failure that must be surfaced to the Forge orchestrator rather than
 * interpreted as a successful child result.
 */
export class SWEForgeRuntimeError extends Error {
	readonly code: SWEForgeRuntimeErrorCode;
	readonly status: SWEForgeRuntimeErrorStatus;
	readonly cause?: unknown;
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(code: SWEForgeRuntimeErrorCode, message: string, options: SWEForgeRuntimeErrorOptions = {}) {
		super(message);
		this.name = "SWEForgeRuntimeError";
		this.code = code;
		this.status = options.status ?? "BLOCKED";
		this.cause = options.cause;
		this.details = options.details;
	}
}

export function isSWEForgeRuntimeError(error: unknown): error is SWEForgeRuntimeError {
	return error instanceof SWEForgeRuntimeError;
}

/** Metadata for one canonical role; `markdown` is returned without translation. */
export interface CanonicalRole {
	readonly name: string;
	readonly markdown: string;
	readonly path: string;
}

/** Metadata for one canonical contract; `markdown` is returned without translation. */
export interface CanonicalContract {
	readonly name: CanonicalContractName;
	readonly markdown: string;
	readonly path: string;
}

export interface RuntimePromptInput {
	/** The canonical role name, not a filesystem path. */
	readonly roleName: string;
	/** Markdown supplied by the caller from the canonical task contract loader. */
	readonly taskContract: string;
	readonly expectedOutputContract: ExpectedOutputContract;
	/** Optional discovery seam for tests and development installations. */
	readonly discovery?: SWEForgeDiscoveryOptions;
}

/** The two access levels understood by the child runtime. */
export type CanonicalWriteAccess = "READ_ONLY" | "WRITABLE";

export interface TaskContractValidation {
	readonly valid: true;
	readonly taskId?: string;
	/** Concrete canonical `write_access` metadata, when the task supplies it. */
	readonly writeAccess?: CanonicalWriteAccess;
}

export interface CanonicalOutputValidation {
	readonly valid: true;
	/** The status emitted by the canonical output, including BLOCKED or FAILED. */
	readonly status: string;
	readonly contract: ExpectedOutputContract;
	readonly taskId?: string;
	readonly structure: "recognizable";
}

export interface CanonicalOutputValidationOptions {
	/** The delegated task identifier to compare with a returned TASK_ID. */
	readonly taskId?: string;
	/** Defaults to true for the canonical result contract and false for review. */
	readonly requireTaskId?: boolean;
}

function isCanonicalContractName(value: unknown): value is CanonicalContractName {
	return typeof value === "string" && (CANONICAL_CONTRACT_NAMES as readonly string[]).includes(value);
}

function isExpectedOutputContract(value: unknown): value is ExpectedOutputContract {
	return (
		typeof value === "string" &&
		(EXPECTED_OUTPUT_CONTRACT_NAMES as readonly string[]).includes(value)
	);
}

function hasRolePathSyntax(roleName: string): boolean {
	return (
		roleName.length === 0 ||
		roleName === "." ||
		roleName === ".." ||
		roleName.includes("\0") ||
		roleName.includes("/") ||
		roleName.includes("\\") ||
		roleName.includes(":") ||
		isAbsolute(roleName) ||
		posix.isAbsolute(roleName) ||
		win32.isAbsolute(roleName) ||
		win32.parse(roleName).root.length > 0
	);
}

function assertSafeRoleName(roleName: string): void {
	if (typeof roleName !== "string" || hasRolePathSyntax(roleName)) {
		throw new SWEForgeRuntimeError(
			"INVALID_ROLE_NAME",
			`Role selection must be a discovered canonical role name, not a path: ${JSON.stringify(roleName)}`,
		);
	}
}

function isSafeDiscoveredRoleName(roleName: string): boolean {
	return !hasRolePathSyntax(roleName);
}

function invalidContractName(contractName: unknown): never {
	throw new SWEForgeRuntimeError(
		"INVALID_CONTRACT_NAME",
		`Unsupported canonical contract: ${JSON.stringify(contractName)}`,
	);
}

function canonicalSourceError(path: string, cause: unknown): SWEForgeRuntimeError {
	return new SWEForgeRuntimeError(
		"CANONICAL_SOURCE_UNAVAILABLE",
		`Canonical SWE-Forge source could not be read: ${path}`,
		{ status: "FAILED", cause, details: { path } },
	);
}

function agentsPath(installation: SWEForgeInstallation): string {
	return join(installation.paths.canonical, ROLE_DIRECTORY_NAME);
}

async function readRoleNamesAt(installation: SWEForgeInstallation): Promise<readonly string[]> {
	const directory = agentsPath(installation);
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		throw canonicalSourceError(directory, error);
	}

	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(ROLE_FILE_SUFFIX))
		.map((entry) => entry.name.slice(0, -ROLE_FILE_SUFFIX.length))
		.filter(isSafeDiscoveredRoleName)
		.sort((left, right) => left.localeCompare(right));
}

async function readCanonicalMarkdown(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		throw canonicalSourceError(path, error);
	}
}

/** Discover the safe role names available in the detected canonical agents directory. */
export async function discoverCanonicalRoleNames(
	options: SWEForgeDiscoveryOptions = {},
): Promise<readonly string[]> {
	const installation = await discoverSWEForgeInstallation(options);
	return readRoleNamesAt(installation);
}

/** Load one discovered canonical role by name. */
export async function loadCanonicalRole(
	roleName: string,
	options: SWEForgeDiscoveryOptions = {},
): Promise<CanonicalRole> {
	assertSafeRoleName(roleName);
	const installation = await discoverSWEForgeInstallation(options);
	const roleNames = await readRoleNamesAt(installation);
	if (!roleNames.includes(roleName)) {
		throw new SWEForgeRuntimeError(
			"ROLE_NOT_FOUND",
			`Canonical role was not discovered: ${roleName}`,
			{ details: { roleName, allowedRoles: roleNames } },
		);
	}

	const path = join(agentsPath(installation), `${roleName}${ROLE_FILE_SUFFIX}`);
	return { name: roleName, markdown: await readCanonicalMarkdown(path), path };
}

/** Load one of the fixed canonical contract files by its enum name. */
export async function loadCanonicalContract(
	contractName: CanonicalContractName,
	options: SWEForgeDiscoveryOptions = {},
): Promise<CanonicalContract> {
	if (!isCanonicalContractName(contractName)) invalidContractName(contractName);
	const installation = await discoverSWEForgeInstallation(options);
	const path = join(installation.paths.canonical, "contracts", CONTRACT_FILE_NAMES[contractName]);
	return { name: contractName, markdown: await readCanonicalMarkdown(path), path };
}

export function loadCanonicalTaskContract(
	options: SWEForgeDiscoveryOptions = {},
): Promise<CanonicalContract> {
	return loadCanonicalContract("task", options);
}

export function loadCanonicalResultContract(
	options: SWEForgeDiscoveryOptions = {},
): Promise<CanonicalContract> {
	return loadCanonicalContract("result", options);
}

export function loadCanonicalReviewContract(
	options: SWEForgeDiscoveryOptions = {},
): Promise<CanonicalContract> {
	return loadCanonicalContract("review", options);
}

export function loadExpectedOutputContract(
	contractName: ExpectedOutputContract,
	options: SWEForgeDiscoveryOptions = {},
): Promise<CanonicalContract> {
	if (!isExpectedOutputContract(contractName)) invalidContractName(contractName);
	return loadCanonicalContract(contractName, options);
}

function ensureTaskContractString(taskContract: unknown): asserts taskContract is string {
	if (typeof taskContract !== "string" || taskContract.trim().length === 0) {
		throw new SWEForgeRuntimeError(
			"EMPTY_TASK_CONTRACT",
			"The canonical task contract must be non-empty.",
		);
	}
}

function fieldPattern(fieldName: string): RegExp {
	return new RegExp(`^\\s*${fieldName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*:\\s*(.*?)\\s*$`, "imu");
}

interface ParsedField {
	readonly present: boolean;
	readonly value?: string;
}

function parsedField(markdown: string, fieldName: string): ParsedField {
	const match = markdown.match(fieldPattern(fieldName));
	if (!match) return { present: false };

	let value = match[1]?.trim() ?? "";
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'")))
	) {
		value = value.slice(1, -1).trim();
	}
	if (value.length === 0 || value === "..." || /^<[^>]+>$/u.test(value)) {
		return { present: true };
	}
	return { present: true, value };
}

/** Identify a task identifier without translating the task contract. */
export function extractTaskIdentifier(markdown: string): string | undefined {
	if (typeof markdown !== "string") return undefined;
	return parsedField(markdown, "TASK_ID").value;
}

function normalizeWriteAccess(value: string): CanonicalWriteAccess | undefined {
	const normalized = value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
	if (["read", "read-only", "readonly", "none"].includes(normalized)) return "READ_ONLY";
	if (["write", "writable", "read-write", "readwrite", "write-access"].includes(normalized)) {
		return "WRITABLE";
	}
	return undefined;
}

/**
 * Read the concrete canonical `write_access` metadata without rewriting the
 * supplied contract. Placeholder values are treated as absent so the runtime
 * remains compatible with reduced task contracts that omit this field.
 */
function extractTaskWriteAccess(markdown: string): CanonicalWriteAccess | undefined {
	const field = parsedField(markdown, "write_access");
	if (!field.value) return undefined;
	const access = normalizeWriteAccess(field.value);
	if (!access) {
		throw new SWEForgeRuntimeError(
			"INVALID_TASK_ACCESS",
			`The task contract contains unsupported write_access metadata: ${JSON.stringify(field.value)}`,
			{ details: { writeAccess: field.value } },
		);
	}
	return access;
}

function ensureExpectedTaskId(taskId: string | undefined): string | undefined {
	if (taskId === undefined) return undefined;
	if (typeof taskId !== "string" || taskId.trim().length === 0 || /^<[^>]+>$/u.test(taskId.trim())) {
		throw new SWEForgeRuntimeError(
			"INVALID_EXPECTED_TASK_ID",
			"The delegated task identifier must be a concrete non-empty value.",
		);
	}
	return taskId.trim();
}

/** Validate the minimum task-contract properties required by the runtime. */
export function validateTaskContract(
	taskContract: string,
	options: { readonly requireTaskId?: boolean; readonly expectedWriteAccess?: CanonicalWriteAccess } = {},
): TaskContractValidation {
	ensureTaskContractString(taskContract);
	const taskId = extractTaskIdentifier(taskContract);
	if (options.requireTaskId && !taskId) {
		throw new SWEForgeRuntimeError(
			"MISSING_TASK_ID",
			"The task contract does not contain an identifiable TASK_ID.",
		);
	}

	const writeAccess = extractTaskWriteAccess(taskContract);
	if (writeAccess !== undefined && options.expectedWriteAccess !== undefined && writeAccess !== options.expectedWriteAccess) {
		throw new SWEForgeRuntimeError(
			"ACCESS_CONFLICT",
			`Task contract requires ${writeAccess}; invocation requested ${options.expectedWriteAccess}.`,
			{ details: { taskWriteAccess: writeAccess, requestedWriteAccess: options.expectedWriteAccess } },
		);
	}

	return {
		valid: true,
		...(taskId === undefined ? {} : { taskId }),
		...(writeAccess === undefined ? {} : { writeAccess }),
	};
}

function outputStructureFields(expectedOutputContract: ExpectedOutputContract): readonly string[] {
	return expectedOutputContract === "result" ? ["SUMMARY", "VALIDATION"] : ["REVIEW_FOCUS", "FINDINGS"];
}

/**
 * Validate the recognizable outer shape of a canonical worker result or
 * review. Invalid output throws a BLOCKED-style runtime error; a canonical
 * BLOCKED/FAILED result is returned as such and is never changed to success.
 */
export function validateCanonicalOutput(
	output: string,
	expectedOutputContract: ExpectedOutputContract,
	options: CanonicalOutputValidationOptions = {},
): CanonicalOutputValidation {
	if (!isExpectedOutputContract(expectedOutputContract)) {
		throw new SWEForgeRuntimeError(
			"INVALID_EXPECTED_OUTPUT_CONTRACT",
			`Unsupported expected output contract: ${JSON.stringify(expectedOutputContract)}`,
		);
	}
	if (typeof output !== "string" || output.trim().length === 0) {
		throw new SWEForgeRuntimeError("EMPTY_OUTPUT", "The worker returned an empty canonical output.");
	}

	const statusField = parsedField(output, "STATUS");
	if (!statusField.value) {
		throw new SWEForgeRuntimeError(
			statusField.present ? "INVALID_STATUS" : "MISSING_STATUS",
			`The ${expectedOutputContract} output must contain a concrete STATUS field.`,
		);
	}
	const status = statusField.value.trim();
	if (status.includes("|")) {
		throw new SWEForgeRuntimeError(
			"INVALID_STATUS",
			`The ${expectedOutputContract} output contains status alternatives instead of one returned STATUS: ${statusField.value}`,
			{ details: { status: statusField.value, expectedOutputContract } },
		);
	}

	const missingStructure = outputStructureFields(expectedOutputContract).filter(
		(field) => !parsedField(output, field).present,
	);
	if (missingStructure.length > 0) {
		throw new SWEForgeRuntimeError(
			"MISSING_OUTPUT_STRUCTURE",
			`The ${expectedOutputContract} output is missing recognizable canonical structure: ${missingStructure.join(", ")}`,
			{ details: { missingStructure, expectedOutputContract } },
		);
	}

	const returnedTaskId = extractTaskIdentifier(output);
	const expectedTaskId = ensureExpectedTaskId(options.taskId);
	const requireTaskId = options.requireTaskId ?? expectedOutputContract === "result";
	if (requireTaskId && !returnedTaskId) {
		throw new SWEForgeRuntimeError(
			"MISSING_TASK_ID",
			"The canonical output does not contain an identifiable TASK_ID.",
		);
	}
	if (expectedTaskId !== undefined && returnedTaskId !== undefined && returnedTaskId !== expectedTaskId) {
		throw new SWEForgeRuntimeError(
			"TASK_ID_MISMATCH",
			`The returned TASK_ID ${JSON.stringify(returnedTaskId)} does not match delegated task ${JSON.stringify(expectedTaskId)}.`,
			{ details: { expectedTaskId, returnedTaskId } },
		);
	}

	return {
		valid: true,
		status,
		contract: expectedOutputContract,
		...(returnedTaskId === undefined ? {} : { taskId: returnedTaskId }),
		structure: "recognizable",
	};
}

/** Compose only the canonical role, task contract, output contract, and guardrail. */
export async function composeRuntimePrompt(input: RuntimePromptInput): Promise<string> {
	ensureTaskContractString(input.taskContract);
	if (!isExpectedOutputContract(input.expectedOutputContract)) {
		throw new SWEForgeRuntimeError(
			"INVALID_EXPECTED_OUTPUT_CONTRACT",
			`Unsupported expected output contract: ${JSON.stringify(input.expectedOutputContract)}`,
		);
	}
	const role = await loadCanonicalRole(input.roleName, input.discovery);
	const outputContract = await loadExpectedOutputContract(input.expectedOutputContract, input.discovery);

	return [
		"=== CANONICAL ROLE ===",
		role.markdown,
		"=== END CANONICAL ROLE ===",
		"",
		"=== CANONICAL TASK CONTRACT ===",
		input.taskContract,
		"=== END CANONICAL TASK CONTRACT ===",
		"",
		`=== EXPECTED CANONICAL ${input.expectedOutputContract.toUpperCase()} CONTRACT ===`,
		outputContract.markdown,
		`=== END EXPECTED CANONICAL ${input.expectedOutputContract.toUpperCase()} CONTRACT ===`,
		"",
		"Pi runtime guardrail:",
		"- The task contract is authoritative.",
		"- Stay inside the allowed scope.",
		"- Do not perform delivery or integration actions.",
		"- Do not delegate further.",
		`- Return the required canonical ${input.expectedOutputContract} contract.`,
	].join("\n");
}

/** Compatibility-friendly aliases that retain the canonical-source semantics. */
export const discoverCanonicalRoles = discoverCanonicalRoleNames;
export const loadSWEForgeRole = loadCanonicalRole;
export const validateWorkerOutput = validateCanonicalOutput;
