import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
	checkoutScheduler,
	isCheckoutAbortError,
	type CheckoutAccess,
} from "./checkout-scheduler.js";
import type { SWEForgeDiscoveryOptions } from "./discovery.js";
import {
	composeRuntimePrompt,
	extractTaskIdentifier,
	SWEForgeRuntimeError,
	type CanonicalOutputValidation,
	type ExpectedOutputContract,
	validateCanonicalOutput,
	validateTaskContract,
} from "./projection.js";

/** The built-in Pi tools that are available to the child runtime. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

/** The exact read-only capability profile. It intentionally contains no shell. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const satisfies readonly BuiltinTool[];

/**
 * The exact writable capability profile. These are the current built-ins needed
 * to edit files and run local validation; no generic or delegation tool is part
 * of either profile.
 */
export const WRITABLE_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const satisfies readonly BuiltinTool[];

export const CHILD_TOOL_PROFILES = {
	READ_ONLY: READ_ONLY_TOOLS,
	WRITABLE: WRITABLE_TOOLS,
} as const;

export type ChildToolProfile = keyof typeof CHILD_TOOL_PROFILES;

/** Names denied even when a future Pi configuration tries to add extensions. */
export const DELEGATION_TOOL_NAMES = ["subagent", "swe_forge_subagent"] as const;

/** Keep diagnostics bounded; the final worker output is bounded separately. */
export const MAX_STDERR_BYTES = 16 * 1024;
export const MAX_WORKER_OUTPUT_BYTES = 256 * 1024;

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

export interface ChildAgentResult {
	readonly status: ChildAgentStatus;
	readonly exitCode: number | null;
	readonly text: string;
	readonly assistantMessage?: JsonObject;
	readonly stderr: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly outputTruncated?: boolean;
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
	readonly roleName: string;
	/** The canonical task contract text supplied by the Forge orchestrator. */
	readonly taskContract: string;
	readonly expectedOutputContract: ExpectedOutputContract;
	readonly profile: ChildToolProfile;
	readonly cwd?: string;
	/** Required so the child does not silently select a different model. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	readonly signal?: AbortSignal;
	readonly discovery?: SWEForgeDiscoveryOptions;
	/** Test seam for a Pi executable or fixture. */
	readonly piCommand?: string;
	readonly piCommandArgs?: readonly string[];
	readonly env?: NodeJS.ProcessEnv;
}

export interface SWEForgeTaskRuntimeMetadata extends ChildAgentResult {
	readonly roleName: string;
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
	/** Compatibility aliases for callers that use worker-oriented terminology. */
	readonly workerOutput: string;
	readonly metadata: SWEForgeTaskRuntimeMetadata;
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
	stopReason?: string;
	errorMessage?: string;
	agentEnded: boolean;
	outputTruncated: boolean;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return { value, truncated: false };

	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return {
		value: `${bytes.subarray(0, end).toString("utf8")}\n[worker output truncated]`,
		truncated: true,
	};
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
 */
export function buildChildArgs(options: BuildChildArgsOptions): string[] {
	const tools = resolveTools(options);
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
	if (isPiProcess && currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	return { command: "pi", args: [] };
}

function consumeJsonLines(
	stream: NodeJS.ReadableStream | null | undefined,
	onLine: (line: string) => void,
): void {
	if (!stream) return;

	const decoder = new StringDecoder("utf8");
	let buffer = "";
	stream.on("data", (chunk: Buffer | string) => {
		buffer += decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	});
	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
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

function applyAssistantMessage(message: JsonObject, state: ChildState): void {
	if (message.role !== "assistant") return;

	state.assistantMessage = message;
	const bounded = boundedUtf8(textFromMessage(message), MAX_WORKER_OUTPUT_BYTES);
	state.text = bounded.value;
	state.outputTruncated = bounded.truncated;
	state.stopReason = asNonEmptyString(message.stopReason);
	state.errorMessage = asNonEmptyString(message.errorMessage);
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
		// Pi's JSON mode is authoritative; non-JSON diagnostic lines are ignored.
		return;
	}
	if (!isRecord(parsed)) return;

	const event = parsed as ChildEvent;
	if (event.type === "message_end" && isRecord(event.message)) {
		applyAssistantMessage(event.message, state);
		return;
	}
	if (event.type === "agent_end") {
		state.agentEnded = true;
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

/** Run one isolated Pi conversation and return only its final structured data. */
async function runPiChildAgent(options: ChildAgentOptions): Promise<ChildAgentResult> {
	// Validate capability selection before entering the child-error recovery path;
	// invalid profiles are caller errors, not child process failures.
	const tools = resolveTools(options);
	const cwd = options.cwd ?? process.cwd();
	const access: CheckoutAccess = tools.includes("bash") ? "WRITABLE" : "READ_ONLY";

	try {
		return await checkoutScheduler.run(
			cwd,
			access,
			() => runPiChildAgentUnlocked(options, tools, cwd),
			options.signal,
		);
	} catch (error) {
		if (options.signal?.aborted || isCheckoutAbortError(error)) {
			return {
				status: "aborted",
				exitCode: null,
				text: "",
				stderr: "",
				errorMessage: "Child aborted before launch",
			};
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
		agentEnded: false,
		outputTruncated: false,
	};
	let stderr = "";
	let wasAborted = false;
	let removeAbort: (() => void) | undefined;
	let clearTermination: (() => void) | undefined;
	let tempDir: string | undefined;
	let child: ChildProcess | undefined;

	try {
		if (options.signal?.aborted) {
			return { status: "aborted", exitCode: null, text: "", stderr: "", errorMessage: "Child aborted before launch" };
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

		consumeJsonLines(child.stdout, (line) => processChildEvent(line, state));
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
			: outcome.spawnError || outcome.exitCode !== 0 || state.stopReason === "error" || state.stopReason === "aborted"
				? "failed"
				: state.agentEnded && state.assistantMessage
					? "completed"
					: "failed";

		return {
			status,
			exitCode: outcome.exitCode,
			text: state.text,
			assistantMessage: state.assistantMessage,
			stderr,
			stopReason: state.stopReason,
			errorMessage:
				outcome.spawnError?.message ??
				state.errorMessage ??
				(status === "failed" ? "Child produced no successful completed result" : undefined),
			outputTruncated: state.outputTruncated || undefined,
		};
	} catch (error) {
		if (wasAborted || options.signal?.aborted) {
			return {
				status: "aborted",
				exitCode: null,
				text: state.text,
				assistantMessage: state.assistantMessage,
				stderr,
				errorMessage: "Child aborted",
				outputTruncated: state.outputTruncated || undefined,
			};
		}
		return failedResult(error instanceof Error ? error.message : String(error), stderr);
	} finally {
		removeAbort?.();
		clearTermination?.();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * Compatibility entry point for the low-level transport and the canonical
 * single-task runtime. Role-aware callers receive the validated Forge result;
 * transport callers receive only child/process metadata.
 */
export function runChildAgent(options: ChildAgentOptions): Promise<ChildAgentResult>;
export function runChildAgent(options: SWEForgeTaskOptions): Promise<SWEForgeTaskResult>;
export function runChildAgent(
	options: ChildAgentOptions | SWEForgeTaskOptions,
): Promise<ChildAgentResult | SWEForgeTaskResult> {
	if ("roleName" in options) return executeSWEForgeTask(options);
	return runPiChildAgent(options);
}

function runtimeMetadata(
	child: ChildAgentResult,
	options: SWEForgeTaskOptions,
	profile: ChildToolProfile,
	taskId: string | undefined,
): SWEForgeTaskRuntimeMetadata {
	return {
		...child,
		roleName: options.roleName,
		expectedOutputContract: options.expectedOutputContract,
		profile,
		tools: getToolsForProfile(profile),
		cwd: options.cwd ?? process.cwd(),
		...(options.model === undefined ? {} : { model: options.model }),
		...(taskId === undefined ? {} : { taskId }),
		cleanup: "complete",
	};
}

function rethrowWithRuntimeDetails(
	error: unknown,
	runtime: SWEForgeTaskRuntimeMetadata,
	output: string,
): never {
	if (error instanceof SWEForgeRuntimeError) {
		throw new SWEForgeRuntimeError(error.code, error.message, {
			status: error.status,
			cause: error,
			details: { ...(error.details ?? {}), output, runtime },
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
	getToolsForProfile(options.profile);
	if (typeof options.model !== "string" || options.model.trim().length === 0) {
		throw new SWEForgeRuntimeError(
			"MISSING_MODEL",
			"SWE Forge child execution requires an explicit provider/model identifier.",
		);
	}

	const taskValidation = validateTaskContract(options.taskContract, {
		requireTaskId: options.expectedOutputContract === "result",
	});
	const prompt = await composeRuntimePrompt({
		roleName: options.roleName,
		taskContract: options.taskContract,
		expectedOutputContract: options.expectedOutputContract,
		discovery: options.discovery,
	});
	const taskId = taskValidation.taskId ?? extractTaskIdentifier(options.taskContract);
	const child = await runPiChildAgent({
		task: "Execute the bounded SWE-Forge task and return only the required canonical output.",
		systemPrompt: prompt,
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		profile: options.profile,
		signal: options.signal,
		piCommand: options.piCommand,
		piCommandArgs: options.piCommandArgs,
		env: options.env,
	});
	const runtime = runtimeMetadata(child, options, options.profile, taskId);

	if (child.status !== "completed") {
		return {
			output: child.text,
			runtime,
			validation: undefined,
			workerOutput: child.text,
			metadata: runtime,
		};
	}

	try {
		const validation = validateCanonicalOutput(child.text, options.expectedOutputContract, {
			taskId,
			requireTaskId: options.expectedOutputContract === "result",
		});
		return {
			output: child.text,
			runtime,
			validation,
			workerOutput: child.text,
			metadata: runtime,
		};
	} catch (error) {
		return rethrowWithRuntimeDetails(error, runtime, child.text);
	}
}

/** Compatibility-friendly aliases for the single-task runtime. */
export const runSWEForgeTask = executeSWEForgeTask;
export const runSWEForgeSubagent = executeSWEForgeTask;
