import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import {
	checkoutScheduler,
	isCheckoutAbortError,
	type CheckoutAccess,
} from "./checkout-scheduler.js";
import type { SWEForgeDiscoveryOptions } from "./discovery.js";
import {
	composeRuntimePrompt,
	extractTaskIdentifier,
	loadCanonicalTaskContract,
	SWEForgeRuntimeError,
	type CanonicalOutputValidation,
	type ExpectedOutputContract,
	MAX_WORKER_RESULT_BYTES,
	validateCanonicalOutput,
	validateTaskContract,
} from "./projection.js";

/** The built-in Pi tools that are available to the child runtime. */
export const BUILTIN_TOOLS = Object.freeze(["read", "bash", "edit", "write", "grep", "find", "ls"] as const);
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** The exact read-only capability profile. It intentionally contains no shell. */
export const READ_ONLY_TOOLS = Object.freeze(["read", "grep", "find", "ls"] as const) satisfies readonly BuiltinTool[];

/**
 * The exact writable capability profile. These are the current built-ins needed
 * to edit files and run local validation; no generic or delegation tool is part
 * of either profile.
 */
export const WRITABLE_TOOLS = Object.freeze(
	["read", "grep", "find", "ls", "edit", "write", "bash"] as const,
) satisfies readonly BuiltinTool[];

export const CHILD_TOOL_PROFILES = Object.freeze({
	READ_ONLY: READ_ONLY_TOOLS,
	WRITABLE: WRITABLE_TOOLS,
} as const);

export type ChildToolProfile = keyof typeof CHILD_TOOL_PROFILES;

/** Names denied even when a future Pi configuration tries to add extensions. */
export const DELEGATION_TOOL_NAMES = Object.freeze(["subagent", "swe_forge_subagent"] as const);

/** Keep diagnostics bounded; the final worker output is bounded separately. */
export const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_EVENT_LINE_BYTES = 512 * 1024;

/**
 * Pi's CLI/event boundary is tested against this compatibility line. A child
 * launched through an injected command is a fixture seam and is not probed.
 */
export const PI_COMPATIBILITY_POLICY = {
	range: ">=0.84.1 <0.85.0",
	minimum: "0.84.1",
	maximumExclusive: "0.85.0",
} as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChildAgentStatus = "completed" | "failed" | "aborted";
export type JsonObject = Record<string, unknown>;

export interface ChildAgentOptions {
	/** The one bounded user message sent to the child. */
	readonly task: string;
	/** Canonical role/task/output instructions written to a temporary file. */
	readonly systemPrompt?: string;
	/** The project checkout in which Pi creates its built-in tools. */
	readonly cwd?: string;
	/** Explicit provider/model identifier, for example provider/model. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	/** Preferred public capability selection. */
	readonly profile?: ChildToolProfile;
	/**
	 * Low-level transport compatibility seam. High-level Forge execution always
	 * uses one of the two named profiles.
	 */
	readonly tools?: readonly string[];
	readonly signal?: AbortSignal;
	/** Test seam for a Pi executable or fixture. Defaults to the active Pi CLI. */
	readonly piCommand?: string;
	/** Arguments placed before the runner's Pi CLI arguments. */
	readonly piCommandArgs?: readonly string[];
	/** Additional child environment values. The parent environment is inherited. */
	readonly env?: NodeJS.ProcessEnv;
}

export interface ChildAgentUsageDiagnostics {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly totalTokens?: number;
	readonly cost?: number;
}

export interface ChildAgentRuntimeDiagnostics {
	readonly compatibilityCheckDurationMs?: number;
	readonly queueWaitDurationMs?: number;
	readonly childStartupDurationMs?: number;
	readonly agentExecutionDurationMs?: number;
	readonly totalRuntimeDurationMs?: number;
	readonly usage?: ChildAgentUsageDiagnostics;
	readonly turns?: number;
}

type MutableChildAgentRuntimeDiagnostics = {
	-readonly [Key in keyof ChildAgentRuntimeDiagnostics]?: ChildAgentRuntimeDiagnostics[Key];
};

export interface ChildAgentResult {
	readonly status: ChildAgentStatus;
	readonly exitCode: number | null;
	readonly text: string;
	readonly assistantMessage?: JsonObject;
	readonly stderr: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly outputTruncated?: boolean;
	readonly eventStreamError?: string;
	readonly piVersion?: string;
	readonly diagnostics?: ChildAgentRuntimeDiagnostics;
}

export interface ChildInvocation {
	readonly command: string;
	readonly args: readonly string[];
}

export interface BuildChildArgsOptions {
	readonly task: string;
	readonly systemPromptPath?: string;
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly profile?: ChildToolProfile;
	/** Compatibility input for the low-level transport seam. */
	readonly tools?: readonly string[];
}

export interface SWEForgeTaskOptions {
	/** A discovered canonical role name, never a path. */
	readonly role: string;
	/** The canonical task contract text supplied by the Forge orchestrator. */
	readonly taskContract: string;
	readonly expectedOutputContract: ExpectedOutputContract;
	readonly profile: ChildToolProfile;
	readonly cwd?: string;
	/** Required so the child does not silently select a different model. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly signal?: AbortSignal;
}

/** Fixture-only transport controls; deliberately absent from the package API. */
interface InternalSWEForgeTaskOptions extends SWEForgeTaskOptions {
	readonly discovery?: SWEForgeDiscoveryOptions;
	readonly piCommand?: string;
	readonly piCommandArgs?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
}

export interface SWEForgeTaskRuntimeMetadata extends ChildAgentResult {
	readonly role: string;
	readonly expectedOutputContract: ExpectedOutputContract;
	readonly profile: ChildToolProfile;
	readonly tools: readonly BuiltinTool[];
	readonly cwd: string;
	readonly model?: string;
	readonly taskId?: string;
	/** The child process and prompt material have been awaited and removed. */
	readonly cleanup: "complete";
}

export interface SWEForgeTaskResult {
	/** The final canonical worker result or review, not a transcript. */
	readonly output: string;
	/** Runtime/process evidence is deliberately separate from canonical output. */
	readonly runtime: SWEForgeTaskRuntimeMetadata;
	readonly validation: CanonicalOutputValidation | undefined;
}

interface ChildEvent extends JsonObject {
	readonly type?: unknown;
}

interface ChildProcessOutcome {
	readonly exitCode: number | null;
	readonly spawnError?: Error;
}

interface ChildState {
	assistantMessage?: JsonObject;
	text: string;
	canonicalTexts: string[];
	stopReason?: string;
	errorMessage?: string;
	agentStartedAt?: number;
	agentEndedAt?: number;
	turnCount: number;
	usage?: ChildAgentUsageDiagnostics;
	agentEnded: boolean;
	outputTruncated: boolean;
	eventStreamError?: string;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function elapsedMilliseconds(startedAt: number, finishedAt = performance.now()): number {
	return Math.max(0, Math.round(finishedAt - startedAt));
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageDiagnostics(value: unknown): ChildAgentUsageDiagnostics | undefined {
	if (!isRecord(value)) return undefined;
	const inputTokens = finiteNonNegativeNumber(value.input);
	const outputTokens = finiteNonNegativeNumber(value.output);
	const cacheReadTokens = finiteNonNegativeNumber(value.cacheRead);
	const cacheWriteTokens = finiteNonNegativeNumber(value.cacheWrite);
	const totalTokens = finiteNonNegativeNumber(value.totalTokens);
	const cost = isRecord(value.cost) ? finiteNonNegativeNumber(value.cost.total) : undefined;
	if (
		inputTokens === undefined &&
		outputTokens === undefined &&
		cacheReadTokens === undefined &&
		cacheWriteTokens === undefined &&
		totalTokens === undefined &&
		cost === undefined
	) {
		return undefined;
	}
	return {
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
		...(totalTokens === undefined ? {} : { totalTokens }),
		...(cost === undefined ? {} : { cost }),
	};
}

function boundedUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return { value, truncated: false };

	return { value: "", truncated: true };
}

function appendBounded(current: string, chunk: string, maxBytes: number, marker: string): string {
	if (current.endsWith(marker)) return current;
	const bytes = Buffer.concat([Buffer.from(current, "utf8"), Buffer.from(chunk, "utf8")]);
	if (bytes.byteLength <= maxBytes) return bytes.toString("utf8");

	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}\n${marker}`;
}

function isChildTool(value: string): value is BuiltinTool {
	return (BUILTIN_TOOLS as readonly string[]).includes(value);
}

function validateTools(tools: readonly string[]): BuiltinTool[] {
	const unique = [...new Set(tools)];
	const unknown = unique.filter((tool) => !isChildTool(tool));
	if (unknown.length > 0) {
		throw new SWEForgeRuntimeError(
			"INVALID_TOOL_PROFILE",
			`Unsupported child tool(s): ${unknown.join(", ")}`,
			{ details: { unknown } },
		);
	}
	return unique as BuiltinTool[];
}

function isChildToolProfile(value: unknown): value is ChildToolProfile {
	return value === "READ_ONLY" || value === "WRITABLE";
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function validateModelIdentifier(model: unknown): asserts model is string {
	if (typeof model !== "string" || model.trim().length === 0 || model.includes("\0")) {
		throw new SWEForgeRuntimeError(
			"INVALID_MODEL",
			`Pi child model must be a non-empty provider/model identifier: ${JSON.stringify(model)}`,
		);
	}
}

function validateThinkingLevel(level: unknown): asserts level is ThinkingLevel {
	if (level === undefined) return;
	if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
		throw new SWEForgeRuntimeError(
			"INVALID_THINKING_LEVEL",
			`Unsupported Pi thinking level: ${JSON.stringify(level)}`,
		);
	}
}

/** Resolve one of the two closed capability profiles. */
export function getToolsForProfile(profile: unknown): readonly BuiltinTool[] {
	if (!isChildToolProfile(profile)) {
		throw new SWEForgeRuntimeError(
			"INVALID_TOOL_PROFILE",
			`Child capability profile must be READ_ONLY or WRITABLE, received ${JSON.stringify(profile)}`,
		);
	}
	return CHILD_TOOL_PROFILES[profile];
}

function sameToolSet(left: readonly BuiltinTool[], right: readonly BuiltinTool[]): boolean {
	if (left.length !== right.length) return false;
	const rightSet = new Set(right);
	return left.every((tool) => rightSet.has(tool));
}

function resolveTools(options: BuildChildArgsOptions): BuiltinTool[] {
	if (options.profile !== undefined) {
		const profileTools = [...getToolsForProfile(options.profile)];
		if (options.tools !== undefined) {
			const suppliedTools = validateTools(options.tools);
			if (!sameToolSet(suppliedTools, profileTools)) {
				throw new SWEForgeRuntimeError(
					"INVALID_TOOL_PROFILE",
					`Tools do not match the ${options.profile} capability profile.`,
					{ details: { profile: options.profile, expected: profileTools, received: suppliedTools } },
				);
			}
		}
		return profileTools;
	}

	if (options.tools === undefined) {
		throw new SWEForgeRuntimeError(
			"INVALID_TOOL_PROFILE",
			"Child execution requires exactly one of the READ_ONLY or WRITABLE capability profiles.",
		);
	}
	const suppliedTools = validateTools(options.tools);
	for (const profile of ["READ_ONLY", "WRITABLE"] as const) {
		const profileTools = getToolsForProfile(profile);
		if (sameToolSet(suppliedTools, profileTools)) return [...profileTools];
	}
	throw new SWEForgeRuntimeError(
		"INVALID_TOOL_PROFILE",
		"Child tools must match exactly the READ_ONLY or WRITABLE capability profile.",
		{ details: { received: suppliedTools } },
	);
}

/**
 * Build the one-shot CLI arguments used for every child.
 *
 * Resource discovery is intentionally disabled here. SWE Forge supplies the
 * child contract explicitly rather than asking a child to discover workflow
 * roles or to load the adapter recursively.
 *
 * @internal The package entry point deliberately does not expose this generic
 * transport helper.
 */
export function buildChildArgs(options: BuildChildArgsOptions): string[] {
	const tools = resolveTools(options);
	if (options.model !== undefined) validateModelIdentifier(options.model);
	validateThinkingLevel(options.thinkingLevel);
	const args = [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
		"--exclude-tools",
		DELEGATION_TOOL_NAMES.join(","),
	];

	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (tools.length > 0) args.push("--tools", tools.join(","));
	else args.push("--no-tools");
	if (options.systemPromptPath) args.push("--append-system-prompt", options.systemPromptPath);

	// Prefixing the task keeps a task beginning with '-' from being parsed as a flag.
	args.push(`Task: ${options.task}`);
	return args;
}

/**
 * Resolve the Pi process without depending on a globally installed package
 * when the caller is itself running from Pi's CLI entry point.
 */
export function resolvePiInvocation(): ChildInvocation {
	const currentScript = process.argv[1];
	const isPiProcess = process.env.PI_CODING_AGENT === "true";
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	const resolvedScript = currentScript === undefined ? undefined : resolve(currentScript);
	if (isPiProcess && resolvedScript && !isBunVirtualScript && existsSync(resolvedScript)) {
		return { command: process.execPath, args: [resolvedScript] };
	}

	return { command: "pi", args: [] };
}

function consumeJsonLines(
	stream: NodeJS.ReadableStream | null | undefined,
	onLine: (line: string) => void,
	onInvalid: (reason: string) => void,
): void {
	if (!stream) {
		onInvalid("stdout was not available");
		return;
	}

	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let droppingOversizedLine = false;
	const deliverLine = (line: string) => {
		if (line.includes("\uFFFD")) {
			onInvalid("stdout contained invalid UTF-8 event data");
			return;
		}
		onLine(line);
	};
	const consumeDecoded = (decoded: string) => {
		let remaining = decoded;
		while (remaining.length > 0) {
			if (droppingOversizedLine) {
				const newline = remaining.indexOf("\n");
				if (newline === -1) return;
				remaining = remaining.slice(newline + 1);
				droppingOversizedLine = false;
			}

			buffer += remaining;
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
					onInvalid(`stdout event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
				} else {
					deliverLine(line);
				}
			}

			if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_LINE_BYTES) {
				onInvalid(`stdout event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
				buffer = "";
				droppingOversizedLine = true;
				return;
			}
			remaining = "";
		}
	};

	stream.on("data", (chunk: Buffer | string) => {
		consumeDecoded(decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
	});
	stream.on("error", (error) => {
		onInvalid(`stdout stream error: ${error instanceof Error ? error.message : String(error)}`);
	});
	stream.on("end", () => {
		consumeDecoded(decoder.end());
		if (droppingOversizedLine) return;
		if (buffer.length > 0) {
			if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_LINE_BYTES) {
				onInvalid(`stdout event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
				return;
			}
			deliverLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		}
	});
}

function terminateProcess(child: ChildProcess): () => void {
	let forceTimer: NodeJS.Timeout | undefined;
	const pid = child.pid;

	const sendSignal = (signal: NodeJS.Signals) => {
		if (process.platform !== "win32" && pid) {
			try {
				// The child is detached on POSIX, so its process group includes Pi's
				// shell descendants as well as the Pi process itself.
				process.kill(-pid, signal);
				return;
			} catch {
				// Fall through to the direct child operation if the group is gone.
			}
		}
		try {
			child.kill(signal);
		} catch {
			// The process has already exited.
		}
		if (process.platform === "win32" && pid) {
			// Windows has no POSIX process-group equivalent. taskkill is the
			// supported best-effort tree termination path for Pi-launched children.
			const treeKill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
				stdio: "ignore",
				windowsHide: true,
			});
			treeKill.once("error", () => {
				// The direct child may already have exited or taskkill may be absent.
			});
		}
	};

	sendSignal("SIGTERM");
	forceTimer = setTimeout(() => sendSignal("SIGKILL"), 5_000);
	forceTimer.unref?.();

	return () => {
		if (forceTimer) clearTimeout(forceTimer);
	};
}

function waitForProcess(child: ChildProcess): Promise<ChildProcessOutcome> {
	return new Promise((resolve) => {
		let settled = false;
		let spawnError: Error | undefined;
		const finish = (outcome: ChildProcessOutcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};

		child.once("error", (error) => {
			spawnError = error;
			finish({ exitCode: null, spawnError });
		});
		child.once("close", (code) => finish({ exitCode: code, spawnError }));
	});
}

function recordCanonicalCandidate(text: string, state: ChildState): void {
	if (
		!/^\s*status\s*:/imu.test(text) ||
		!/(^|\n)\s*(?:summary|validation|review_focus|findings)\s*:/imu.test(text)
	) {
		return;
	}
	if (!state.canonicalTexts.includes(text)) state.canonicalTexts.push(text);
	if (state.canonicalTexts.length > 1) {
		state.eventStreamError ??= "stdout contained conflicting canonical assistant results";
	}
}

function applyAssistantMessage(message: JsonObject, state: ChildState): void {
	if (message.role !== "assistant") return;

	state.assistantMessage = message;
	const bounded = boundedUtf8(textFromMessage(message), MAX_WORKER_RESULT_BYTES);
	state.text = bounded.value;
	state.outputTruncated ||= bounded.truncated;
	state.usage = usageDiagnostics(message.usage);
	state.stopReason = asNonEmptyString(message.stopReason);
	state.errorMessage = asNonEmptyString(message.errorMessage);
	if (!bounded.truncated) recordCanonicalCandidate(bounded.value, state);
}

function textFromMessage(message: JsonObject): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter(isRecord)
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("");
}

function processChildEvent(line: string, state: ChildState): void {
	if (!line.trim()) return;

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		state.eventStreamError ??= "stdout contained a non-JSON event line";
		return;
	}
	if (!isRecord(parsed)) {
		state.eventStreamError ??= "stdout contained a JSON value that was not an event object";
		return;
	}

	const event = parsed as ChildEvent;
	if (typeof event.type !== "string") {
		state.eventStreamError ??= "stdout contained an event without a type";
		return;
	}
	if (event.type === "agent_start") {
		state.agentStartedAt ??= performance.now();
		return;
	}
	if (event.type === "turn_start") {
		state.turnCount += 1;
		return;
	}
	if (event.type === "message_end") {
		if (!isRecord(event.message)) {
			state.eventStreamError ??= "message_end did not contain a message object";
			return;
		}
		applyAssistantMessage(event.message, state);
		return;
	}
	if (event.type === "agent_end") {
		state.agentEndedAt ??= performance.now();
		state.agentEnded = true;
		if (event.messages !== undefined && !Array.isArray(event.messages)) {
			state.eventStreamError ??= "agent_end.messages was not an array";
			return;
		}
		if (Array.isArray(event.messages)) {
			for (const message of event.messages) {
				if (isRecord(message)) applyAssistantMessage(message, state);
			}
		}
	}
}

function failedResult(errorMessage: string, stderr = ""): ChildAgentResult {
	return {
		status: "failed",
		exitCode: null,
		text: "",
		stderr,
		errorMessage,
	};
}

function withDiagnostics(
	result: ChildAgentResult,
	diagnostics: Partial<ChildAgentRuntimeDiagnostics>,
): ChildAgentResult {
	return {
		...result,
		diagnostics: {
			...(result.diagnostics ?? {}),
			...diagnostics,
		},
	};
}

function childDiagnostics(
	state: ChildState,
	spawnStartedAt: number | undefined,
	compatibilityCheckDurationMs: number | undefined,
): Partial<ChildAgentRuntimeDiagnostics> {
	const diagnostics: MutableChildAgentRuntimeDiagnostics = {};
	if (compatibilityCheckDurationMs !== undefined) diagnostics.compatibilityCheckDurationMs = compatibilityCheckDurationMs;
	if (spawnStartedAt !== undefined && state.agentStartedAt !== undefined) {
		diagnostics.childStartupDurationMs = elapsedMilliseconds(spawnStartedAt, state.agentStartedAt);
	}
	if (state.agentStartedAt !== undefined && state.agentEndedAt !== undefined) {
		diagnostics.agentExecutionDurationMs = elapsedMilliseconds(state.agentStartedAt, state.agentEndedAt);
	}
	if (state.usage !== undefined) diagnostics.usage = state.usage;
	if (state.turnCount > 0) diagnostics.turns = state.turnCount;
	return diagnostics;
}

async function canonicalizeCwd(input: string | undefined): Promise<string> {
	const cwd = input ?? process.cwd();
	if (cwd.length === 0 || cwd.includes("\0")) {
		throw new SWEForgeRuntimeError(
			"INVALID_CWD",
			`Child working directory is not a valid filesystem path: ${JSON.stringify(cwd)}`,
		);
	}
	let info;
	try {
		info = await stat(cwd);
	} catch (error) {
		throw new SWEForgeRuntimeError(
			"INVALID_CWD",
			`Child working directory could not be inspected: ${cwd}`,
			{ cause: error, details: { cwd } },
		);
	}
	if (!info.isDirectory()) {
		throw new SWEForgeRuntimeError(
			"INVALID_CWD",
			`Child working directory is not a directory: ${cwd}`,
			{ details: { cwd } },
		);
	}
	try {
		return await realpath(cwd);
	} catch (error) {
		throw new SWEForgeRuntimeError(
			"INVALID_CWD",
			`Child working directory could not be normalized: ${cwd}`,
			{ cause: error, details: { cwd } },
		);
	}
}

const PI_VERSION_PATTERN = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\s|$)/u;

/** Check the Pi CLI version against the documented public CLI boundary. */
export function isSupportedPiVersion(version: string): boolean {
	const match = PI_VERSION_PATTERN.exec(version.trim());
	if (!match) return false;
	return match[4] === undefined && Number(match[1]) === 0 && Number(match[2]) === 84 && Number(match[3]) >= 1;
}

interface PiProbeResult {
	readonly version?: string;
	readonly error?: string;
	readonly aborted: boolean;
}

interface PiCompatibilityVerification {
	readonly result: PiProbeResult;
	readonly performed: boolean;
	readonly durationMs?: number;
}

/** Successful and in-flight checks live only for this host process. */
const piCompatibilityCache = new Map<string, Promise<PiProbeResult>>();

function piCompatibilityCacheKey(
	invocation: ChildInvocation,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
): string {
	const inheritedEnvironmentKeys = ["PATH", "PATHEXT", "NODE_OPTIONS", "PI_CODING_AGENT_DIR"];
	const mergedEnvironment = { ...process.env, ...env };
	const keys = new Set([...inheritedEnvironmentKeys, ...Object.keys(env ?? {})]);
	const environment = [...keys]
		.sort()
		.map((key) => [key, mergedEnvironment[key] ?? null]);
	const commandIdentity = /[\\/]/u.test(invocation.command) ? resolve(cwd, invocation.command) : invocation.command;
	const identity = JSON.stringify({ command: commandIdentity, args: invocation.args, environment });
	return createHash("sha256").update(identity).digest("hex");
}

async function verifyPiVersion(
	invocation: ChildInvocation,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
	signal: AbortSignal | undefined,
): Promise<PiCompatibilityVerification> {
	const key = piCompatibilityCacheKey(invocation, cwd, env);
	const cached = piCompatibilityCache.get(key);
	if (cached) return { result: await cached, performed: false };

	const startedAt = performance.now();
	let pending!: Promise<PiProbeResult>;
	pending = probePiVersion(invocation, cwd, env, signal).then(
		(result) => {
			if (result.version !== undefined && !result.error && !result.aborted) {
				piCompatibilityCache.set(key, Promise.resolve(result));
			} else if (piCompatibilityCache.get(key) === pending) {
				piCompatibilityCache.delete(key);
			}
			return result;
		},
		(error: unknown) => {
			if (piCompatibilityCache.get(key) === pending) piCompatibilityCache.delete(key);
			throw error;
		},
	);
	piCompatibilityCache.set(key, pending);
	return {
		result: await pending,
		performed: true,
		durationMs: elapsedMilliseconds(startedAt),
	};
}

async function probePiVersion(
	invocation: ChildInvocation,
	cwd: string,
	env: NodeJS.ProcessEnv | undefined,
	signal: AbortSignal | undefined,
): Promise<PiProbeResult> {
	if (signal?.aborted) return { aborted: true };
	return new Promise((resolveProbe) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let timeout: NodeJS.Timeout | undefined;
		let removeAbort: (() => void) | undefined;
		let terminationCleanup: (() => void) | undefined;
		let processForProbe: ChildProcess | undefined;
		let timedOut = false;
		const finish = (result: PiProbeResult) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			terminationCleanup?.();
			removeAbort?.();
			resolveProbe(result);
		};

		try {
			processForProbe = spawn(invocation.command, [...invocation.args, "--version"], {
				cwd,
				env: { ...process.env, ...env },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			finish({ aborted: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}

		processForProbe.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendBounded(stdout, typeof chunk === "string" ? chunk : chunk.toString("utf8"), 8 * 1024, "[stdout truncated]");
		});
		processForProbe.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBounded(stderr, typeof chunk === "string" ? chunk : chunk.toString("utf8"), 8 * 1024, "[stderr truncated]");
		});
		processForProbe.once("error", (error) => finish({ aborted: false, error: error.message }));
		processForProbe.once("close", (code) => {
			if (signal?.aborted) {
				finish({ aborted: true });
				return;
			}
			if (timedOut) {
				finish({ aborted: false, error: "Pi compatibility probe timed out after 5000ms." });
				return;
			}
			if (code !== 0) {
				finish({
					aborted: false,
					error: `Pi compatibility probe exited with code ${String(code)}${stderr ? `: ${stderr.trim()}` : ""}`,
				});
				return;
			}
			const match = PI_VERSION_PATTERN.exec(stdout.trim());
			if (!match) {
				finish({ aborted: false, error: `Pi compatibility probe returned no semantic version: ${stdout.trim() || "(empty)"}` });
				return;
			}
			const version = match[0].trim();
			if (!isSupportedPiVersion(version)) {
				finish({
					aborted: false,
					error: `Unsupported Pi version ${version}; supported compatibility range is ${PI_COMPATIBILITY_POLICY.range}.`,
				});
				return;
			}
			finish({ aborted: false, version });
		});

		const abort = () => {
			if (processForProbe && !settled) {
				terminationCleanup?.();
				terminationCleanup = terminateProcess(processForProbe);
			}
		};
		if (signal) {
			signal.addEventListener("abort", abort, { once: true });
			removeAbort = () => signal.removeEventListener("abort", abort);
			if (signal.aborted) abort();
		}
		timeout = setTimeout(() => {
			if (!settled && processForProbe) {
				timedOut = true;
				terminationCleanup?.();
				terminationCleanup = terminateProcess(processForProbe);
			}
		}, 5_000);
		timeout.unref?.();
	});
}

/** Run one isolated Pi conversation and return only its final structured data. */
async function runPiChildAgent(options: ChildAgentOptions): Promise<ChildAgentResult> {
	// Validate capability selection before entering the child-error recovery path;
	// invalid profiles are caller errors, not child process failures.
	const totalStartedAt = performance.now();
	const tools = resolveTools(options);
	if (options.signal?.aborted) {
		return withDiagnostics(
			{ status: "aborted", exitCode: null, text: "", stderr: "", errorMessage: "Child aborted before launch" },
			{ totalRuntimeDurationMs: elapsedMilliseconds(totalStartedAt), queueWaitDurationMs: 0 },
		);
	}
	const cwd = await canonicalizeCwd(options.cwd);
	const access: CheckoutAccess = tools.includes("bash") ? "WRITABLE" : "READ_ONLY";
	const queueStartedAt = performance.now();
	let operationStartedAt: number | undefined;

	try {
		const result = await checkoutScheduler.run(
			cwd,
			access,
			() => {
				operationStartedAt = performance.now();
				return runPiChildAgentUnlocked(options, tools, cwd);
			},
			options.signal,
		);
		return withDiagnostics(result, {
			queueWaitDurationMs: elapsedMilliseconds(queueStartedAt, operationStartedAt ?? performance.now()),
			totalRuntimeDurationMs: elapsedMilliseconds(totalStartedAt),
		});
	} catch (error) {
		const queueWaitDurationMs = elapsedMilliseconds(queueStartedAt, operationStartedAt ?? performance.now());
		if (options.signal?.aborted || isCheckoutAbortError(error)) {
			return withDiagnostics(
				{ status: "aborted", exitCode: null, text: "", stderr: "", errorMessage: "Child aborted before launch" },
				{ queueWaitDurationMs, totalRuntimeDurationMs: elapsedMilliseconds(totalStartedAt) },
			);
		}
		throw error;
	}
}

async function runPiChildAgentUnlocked(
	options: ChildAgentOptions,
	tools: readonly BuiltinTool[],
	cwd: string,
): Promise<ChildAgentResult> {
	const invocation = options.piCommand
		? { command: options.piCommand, args: options.piCommandArgs ?? [] }
		: resolvePiInvocation();
	const state: ChildState = {
		text: "",
		canonicalTexts: [],
		agentEnded: false,
		outputTruncated: false,
		turnCount: 0,
	};
	let stderr = "";
	let wasAborted = false;
	let removeAbort: (() => void) | undefined;
	let clearTermination: (() => void) | undefined;
	let tempDir: string | undefined;
	let child: ChildProcess | undefined;
	let spawnStartedAt: number | undefined;
	let compatibilityCheckDurationMs: number | undefined;

	let piVersion: string | undefined;
	try {
		if (options.signal?.aborted) {
			return { status: "aborted", exitCode: null, text: "", stderr: "", errorMessage: "Child aborted before launch" };
		}

		const verification = await verifyPiVersion(invocation, cwd, options.env, options.signal);
		if (verification.performed) compatibilityCheckDurationMs = verification.durationMs;
		const probe = verification.result;
		if (probe.aborted) {
			return withDiagnostics(
				{ status: "aborted", exitCode: null, text: "", stderr: "", errorMessage: "Child aborted during Pi compatibility probe" },
				{ compatibilityCheckDurationMs },
			);
		}
		if (probe.error) {
			return withDiagnostics(
				failedResult(`Pi compatibility check failed: ${probe.error}`),
				{ compatibilityCheckDurationMs },
			);
		}
		piVersion = probe.version;
		if (piVersion === undefined) {
			return withDiagnostics(
				failedResult("Pi compatibility check did not return a verified version."),
				{ compatibilityCheckDurationMs },
			);
		}

		let systemPromptPath: string | undefined;
		if (options.systemPrompt?.trim()) {
			tempDir = await mkdtemp(join(tmpdir(), "swe-forge-pi-subagent-"));
			systemPromptPath = join(tempDir, "system-prompt.md");
			await writeFile(systemPromptPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });
		}
		if (options.signal?.aborted) {
			return { status: "aborted", exitCode: null, text: "", stderr: "", errorMessage: "Child aborted before launch" };
		}

		const childArgs = buildChildArgs({
			task: options.task,
			systemPromptPath,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			tools,
		});

		try {
			spawnStartedAt = performance.now();
			child = spawn(invocation.command, [...invocation.args, ...childArgs], {
				cwd,
				env: { ...process.env, ...options.env },
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// A detached POSIX process group lets cancellation include Pi-launched
				// shell descendants. Windows uses the direct process fallback below.
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			return failedResult(error instanceof Error ? error.message : String(error));
		}

		consumeJsonLines(
			child.stdout,
			(line) => processChildEvent(line, state),
			(reason) => {
				state.eventStreamError ??= reason;
			},
		);
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBounded(
				stderr,
				typeof chunk === "string" ? chunk : chunk.toString("utf8"),
				MAX_STDERR_BYTES,
				"[stderr truncated]",
			);
		});

		const onAbort = () => {
			wasAborted = true;
			clearTermination?.();
			clearTermination = terminateProcess(child as ChildProcess);
		};
		if (options.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
			removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
			if (options.signal.aborted) onAbort();
		}

		const outcome = await waitForProcess(child);
		const status: ChildAgentStatus = wasAborted
			? "aborted"
			: outcome.spawnError ||
					outcome.exitCode !== 0 ||
					state.stopReason === "error" ||
					state.stopReason === "aborted" ||
					state.eventStreamError !== undefined ||
					state.outputTruncated
				? "failed"
				: state.agentEnded && state.assistantMessage
					? "completed"
					: "failed";

		return withDiagnostics(
			{
				status,
				exitCode: outcome.exitCode,
				text: state.outputTruncated ? "" : state.text,
				assistantMessage: state.assistantMessage,
				stderr,
				stopReason: state.stopReason,
				errorMessage:
					outcome.spawnError?.message ??
					(state.outputTruncated
						? `Worker result exceeded the ${MAX_WORKER_RESULT_BYTES}-byte limit; return a concise canonical result.`
						: state.eventStreamError ??
							state.errorMessage ??
							(status === "failed" && (!state.agentEnded || !state.assistantMessage)
								? "Child exited without a canonical assistant result"
								: status === "failed"
									? "Child did not complete successfully"
									: undefined)),
				outputTruncated: state.outputTruncated || undefined,
				eventStreamError: state.eventStreamError,
				...(piVersion === undefined ? {} : { piVersion }),
			},
			childDiagnostics(state, spawnStartedAt, compatibilityCheckDurationMs),
		);
	} catch (error) {
		if (wasAborted || options.signal?.aborted) {
			return withDiagnostics(
				{
					status: "aborted",
					exitCode: null,
					text: state.outputTruncated ? "" : state.text,
					assistantMessage: state.assistantMessage,
					stderr,
					errorMessage: "Child aborted",
					outputTruncated: state.outputTruncated || undefined,
					eventStreamError: state.eventStreamError,
					...(piVersion === undefined ? {} : { piVersion }),
				},
				childDiagnostics(state, spawnStartedAt, compatibilityCheckDurationMs),
			);
		}
		return withDiagnostics(
			failedResult(error instanceof Error ? error.message : String(error), stderr),
			childDiagnostics(state, spawnStartedAt, compatibilityCheckDurationMs),
		);
	} finally {
		removeAbort?.();
		clearTermination?.();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * Internal compatibility entry point for fixture-backed transport tests and the
 * canonical single-task runtime. It is not re-exported from the package entry.
 */
export function runChildAgent(options: ChildAgentOptions): Promise<ChildAgentResult>;
export function runChildAgent(options: SWEForgeTaskOptions): Promise<SWEForgeTaskResult>;
export function runChildAgent(
	options: ChildAgentOptions | SWEForgeTaskOptions,
): Promise<ChildAgentResult | SWEForgeTaskResult> {
	if ("role" in options) return executeSWEForgeTask(options);
	return runPiChildAgent(options);
}

function runtimeMetadata(
	child: ChildAgentResult,
	options: SWEForgeTaskOptions,
	profile: ChildToolProfile,
	taskId: string | undefined,
	cwd: string,
): SWEForgeTaskRuntimeMetadata {
	return {
		...child,
		role: options.role,
		expectedOutputContract: options.expectedOutputContract,
		profile,
		tools: getToolsForProfile(profile),
		cwd,
		...(options.model === undefined ? {} : { model: options.model }),
		...(taskId === undefined ? {} : { taskId }),
		cleanup: "complete",
	};
}

function runtimeDetailsWithoutModelContent(
	runtime: SWEForgeTaskRuntimeMetadata,
): Omit<SWEForgeTaskRuntimeMetadata, "text" | "assistantMessage"> {
	return Object.fromEntries(
		Object.entries(runtime).filter(([key]) => key !== "text" && key !== "assistantMessage"),
	) as Omit<SWEForgeTaskRuntimeMetadata, "text" | "assistantMessage">;
}

function rethrowWithRuntimeDetails(error: unknown, runtime: SWEForgeTaskRuntimeMetadata): never {
	if (error instanceof SWEForgeRuntimeError) {
		throw new SWEForgeRuntimeError(error.code, error.message, {
			status: error.status,
			cause: error,
			details: { ...(error.details ?? {}), runtime: runtimeDetailsWithoutModelContent(runtime) },
		});
	}
	throw error;
}

/**
 * Execute exactly one bounded SWE-Forge task.
 *
 * The role and expected output contract are loaded afresh for every call. The
 * child receives one prompt file and one user message, uses the selected closed
 * tool profile, and has no extensions, skills, templates, themes, context-file
 * discovery, session persistence, or delegation tools.
 */
export async function executeSWEForgeTask(options: SWEForgeTaskOptions): Promise<SWEForgeTaskResult> {
	const internalOptions = options as InternalSWEForgeTaskOptions;
	getToolsForProfile(internalOptions.profile);
	if (typeof internalOptions.model !== "string" || internalOptions.model.trim().length === 0) {
		throw new SWEForgeRuntimeError(
			"MISSING_MODEL",
			"SWE Forge child execution requires an explicit provider/model identifier.",
		);
	}
	validateModelIdentifier(internalOptions.model);
	validateThinkingLevel(internalOptions.thinkingLevel);
	const cwd = await canonicalizeCwd(internalOptions.cwd);

	// Validate the installed task contract even though the orchestrator supplies
	// the concrete task text. This detects canonical contract drift before launch.
	await loadCanonicalTaskContract(internalOptions.discovery);
	const taskValidation = validateTaskContract(internalOptions.taskContract, {
		requireTaskId: internalOptions.expectedOutputContract === "result",
		expectedWriteAccess: internalOptions.profile,
	});
	const prompt = await composeRuntimePrompt({
		role: internalOptions.role,
		taskContract: internalOptions.taskContract,
		expectedOutputContract: internalOptions.expectedOutputContract,
		discovery: internalOptions.discovery,
	});
	const taskId = taskValidation.taskId ?? extractTaskIdentifier(internalOptions.taskContract);
	const child = await runPiChildAgent({
		task: "Execute the bounded SWE-Forge task and return only the required canonical output.",
		systemPrompt: prompt,
		cwd: internalOptions.cwd,
		model: internalOptions.model,
		thinkingLevel: internalOptions.thinkingLevel,
		profile: internalOptions.profile,
		signal: internalOptions.signal,
		piCommand: internalOptions.piCommand,
		piCommandArgs: internalOptions.piCommandArgs,
		env: internalOptions.env,
	});
	const runtime = runtimeMetadata(child, internalOptions, internalOptions.profile, taskId, cwd);

	if (child.status !== "completed") {
		return {
			// Failed/aborted child text is never a canonical worker result. Returning
			// an empty output keeps the extension content on the structured error path.
			output: "",
			runtime,
			validation: undefined,
		};
	}

	try {
		const validation = validateCanonicalOutput(child.text, internalOptions.expectedOutputContract, {
			taskId,
			requireTaskId: internalOptions.expectedOutputContract === "result",
		});
		return {
			output: child.text,
			runtime,
			validation,
		};
	} catch (error) {
		return rethrowWithRuntimeDetails(error, runtime);
	}
}
