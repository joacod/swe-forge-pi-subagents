import { realpath, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
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

/** The exact writable capability profile used by bounded SWE-Forge workers. */
export const WRITABLE_TOOLS = Object.freeze(
	["read", "grep", "find", "ls", "edit", "write", "bash"] as const,
) satisfies readonly BuiltinTool[];

export const CHILD_TOOL_PROFILES = Object.freeze({
	READ_ONLY: READ_ONLY_TOOLS,
	WRITABLE: WRITABLE_TOOLS,
} as const);

export type ChildToolProfile = keyof typeof CHILD_TOOL_PROFILES;

/** Names denied even when a future SDK resource configuration tries to add extensions. */
export const DELEGATION_TOOL_NAMES = Object.freeze(["subagent", "swe_forge_subagent"] as const);

/** Pi's public SDK compatibility line for the in-process AgentSession runtime. */
export const PI_COMPATIBILITY_POLICY = {
	range: ">=0.84.1 <0.85.0",
	minimum: "0.84.1",
	maximumExclusive: "0.85.0",
	runtime: "in_process_agent_session",
	verification: "public_sdk_api",
} as const;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChildAgentStatus = "completed" | "failed" | "aborted";
export type JsonObject = Record<string, unknown>;

export interface ChildAgentOptions {
	/** The one bounded user message sent to the child. */
	readonly task: string;
	/** Canonical role/task/output instructions installed as the child system prompt. */
	readonly systemPrompt?: string;
	/** The project checkout in which Pi creates its built-in tools. */
	readonly cwd?: string;
	/** Explicit provider/model identifier, for example provider/model. */
	readonly model?: string;
	readonly thinkingLevel?: ThinkingLevel;
	/** Preferred public capability selection. */
	readonly profile?: ChildToolProfile;
	/** Low-level compatibility seam for callers that already have an exact profile. */
	readonly tools?: readonly string[];
	readonly signal?: AbortSignal;
	/** @internal Deterministic session seam; not exposed from the package entry point. */
	readonly sessionFactory?: ChildAgentSessionFactory;
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
	readonly queueWaitDurationMs?: number;
	readonly sessionInitializationDurationMs?: number;
	readonly agentExecutionDurationMs?: number;
	readonly totalRuntimeDurationMs?: number;
	readonly usage?: ChildAgentUsageDiagnostics;
	readonly turns?: number;
}

export interface ChildAgentResult {
	readonly status: ChildAgentStatus;
	readonly text: string;
	readonly assistantMessage?: JsonObject;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly outputTruncated?: boolean;
	readonly diagnostics?: ChildAgentRuntimeDiagnostics;
}

export interface ChildAgentSession {
	readonly messages: readonly unknown[];
	readonly isStreaming: boolean;
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export interface ChildAgentSessionFactoryInput {
	readonly cwd: string;
	readonly model: string;
	readonly thinkingLevel: ThinkingLevel;
	readonly tools: readonly BuiltinTool[];
	readonly systemPrompt: string;
	readonly signal?: AbortSignal;
}

export type ChildAgentSessionFactory = (input: ChildAgentSessionFactoryInput) => Promise<ChildAgentSession>;

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

/** Fixture-only session controls; deliberately absent from the package API. */
interface InternalSWEForgeTaskOptions extends SWEForgeTaskOptions {
	readonly discovery?: SWEForgeDiscoveryOptions;
	readonly sessionFactory?: ChildAgentSessionFactory;
}

export interface SWEForgeTaskRuntimeMetadata extends ChildAgentResult {
	readonly role: string;
	readonly expectedOutputContract: ExpectedOutputContract;
	readonly profile: ChildToolProfile;
	readonly tools: readonly BuiltinTool[];
	readonly cwd: string;
	readonly model?: string;
	readonly taskId?: string;
	/** The in-memory session and its listeners have been awaited and disposed. */
	readonly cleanup: "complete";
}

export interface SWEForgeTaskResult {
	/** The final canonical worker result or review, not a transcript. */
	readonly output: string;
	/** Runtime evidence is deliberately separate from canonical output. */
	readonly runtime: SWEForgeTaskRuntimeMetadata;
	readonly validation: CanonicalOutputValidation | undefined;
}

interface ChildState {
	assistantMessage?: JsonObject;
	agentStartedAt?: number;
	agentSettledAt?: number;
	turnCount: number;
	usage?: ChildAgentUsageDiagnostics;
	stopReason?: string;
	errorMessage?: string;
	outputTruncated: boolean;
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
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
	return { value: "", truncated: true };
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
	const separator = model.indexOf("/");
	if (separator <= 0 || separator === model.length - 1) {
		throw new SWEForgeRuntimeError(
			"INVALID_MODEL",
			`Pi child model must use the provider/model form: ${JSON.stringify(model)}`,
		);
	}
}

function validateThinkingLevel(level: unknown): asserts level is ThinkingLevel | undefined {
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

function resolveTools(options: { readonly profile?: ChildToolProfile; readonly tools?: readonly string[] }): BuiltinTool[] {
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

function boundedTextFromMessage(
	message: JsonObject,
	maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
	const content = message.content;
	if (typeof content === "string") return boundedUtf8(content, maxBytes);
	if (!Array.isArray(content)) return { value: "", truncated: false };

	const textParts: string[] = [];
	let bytes = 0;
	for (const part of content) {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
		bytes += Buffer.byteLength(part.text, "utf8");
		if (bytes > maxBytes) return { value: "", truncated: true };
		textParts.push(part.text);
	}
	return { value: textParts.join(""), truncated: false };
}

function assistantMessage(value: unknown): JsonObject | undefined {
	return isRecord(value) && value.role === "assistant" ? value : undefined;
}

function lastAssistantMessage(values: readonly unknown[]): JsonObject | undefined {
	for (let index = values.length - 1; index >= 0; index -= 1) {
		const message = assistantMessage(values[index]);
		if (message) return message;
	}
	return undefined;
}

function applyFinalAssistant(message: JsonObject, state: ChildState): void {
	state.assistantMessage = message;
	state.usage = usageDiagnostics(message.usage);
	state.stopReason = asNonEmptyString(message.stopReason);
	state.errorMessage = asNonEmptyString(message.errorMessage);
}

function processSessionEvent(eventValue: unknown, state: ChildState): void {
	if (!isRecord(eventValue) || typeof eventValue.type !== "string") return;

	switch (eventValue.type) {
		case "agent_start":
			state.agentStartedAt ??= performance.now();
			return;
		case "turn_start":
			state.turnCount += 1;
			return;
		case "message_end":
			// Streaming and intermediate message events are intentionally ignored.
			return;
		case "agent_end": {
			const messages = Array.isArray(eventValue.messages) ? eventValue.messages : [];
			const finalMessage = lastAssistantMessage(messages);
			if (finalMessage) applyFinalAssistant(finalMessage, state);
			return;
		}
		case "agent_settled":
			state.agentSettledAt ??= performance.now();
			return;
		default:
			return;
	}
}

function failedResult(errorMessage: string): ChildAgentResult {
	return {
		status: "failed",
		text: "",
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
	initializationStartedAt: number | undefined,
	sessionStartedAt: number | undefined,
	finishedAt: number | undefined,
): Partial<ChildAgentRuntimeDiagnostics> {
	const diagnostics: ChildAgentRuntimeDiagnostics = {};
	if (initializationStartedAt !== undefined && sessionStartedAt !== undefined) {
		Object.assign(diagnostics, {
			sessionInitializationDurationMs: elapsedMilliseconds(initializationStartedAt, sessionStartedAt),
		});
	}
	if (state.agentStartedAt !== undefined && finishedAt !== undefined) {
		Object.assign(diagnostics, {
			agentExecutionDurationMs: elapsedMilliseconds(state.agentStartedAt, finishedAt),
		});
	}
	if (state.usage !== undefined) Object.assign(diagnostics, { usage: state.usage });
	if (state.turnCount > 0) Object.assign(diagnostics, { turns: state.turnCount });
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

function createMinimalResourceLoader(systemPrompt: string): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => undefined,
		reload: async () => undefined,
	};
}

function splitModelIdentifier(modelIdentifier: string): { readonly provider: string; readonly model: string } {
	const separator = modelIdentifier.indexOf("/");
	return {
		provider: modelIdentifier.slice(0, separator),
		model: modelIdentifier.slice(separator + 1),
	};
}

function wrapAgentSession(session: AgentSession): ChildAgentSession {
	return {
		get messages() {
			return session.messages;
		},
		get isStreaming() {
			return session.isStreaming;
		},
		subscribe(listener) {
			return session.subscribe(listener as Parameters<AgentSession["subscribe"]>[0]);
		},
		prompt(text) {
			return session.prompt(text, { expandPromptTemplates: false, source: "extension" });
		},
		abort: () => session.abort(),
		waitForIdle: () => session.waitForIdle(),
		dispose: () => session.dispose(),
	};
}

async function createDefaultChildSession(input: ChildAgentSessionFactoryInput): Promise<ChildAgentSession> {
	validateModelIdentifier(input.model);
	const { provider, model: modelId } = splitModelIdentifier(input.model);
	const modelRuntime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: false,
		signal: input.signal,
	});
	const model = modelRuntime.getModel(provider, modelId);
	if (!model) {
		throw new SWEForgeRuntimeError(
			"INVALID_MODEL",
			`Pi child model is not available in the SDK catalog: ${input.model}`,
			{ details: { provider, model: modelId } },
		);
	}

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false, maxRetries: 0 },
		defaultThinkingLevel: input.thinkingLevel,
		defaultTools: [...input.tools],
	});
	const { session } = await createAgentSession({
		cwd: input.cwd,
		modelRuntime,
		model,
		thinkingLevel: input.thinkingLevel,
		tools: [...input.tools],
		excludeTools: [...DELEGATION_TOOL_NAMES],
		resourceLoader: createMinimalResourceLoader(input.systemPrompt),
		sessionManager: SessionManager.inMemory(input.cwd),
		settingsManager,
	});
	return wrapAgentSession(session);
}

const defaultSessionFactory: ChildAgentSessionFactory = createDefaultChildSession;

/** Run one fresh in-process Pi AgentSession and return only its final assistant data. */
async function runPiChildAgent(options: ChildAgentOptions): Promise<ChildAgentResult> {
	const totalStartedAt = performance.now();
	const tools = resolveTools(options);
	if (options.signal?.aborted) {
		return withDiagnostics(
			{ status: "aborted", text: "", errorMessage: "Child aborted before session initialization" },
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
				{ status: "aborted", text: "", errorMessage: "Child aborted before session initialization" },
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
	const initializationStartedAt = performance.now();
	const state: ChildState = { turnCount: 0, outputTruncated: false };
	const sessionFactory = options.sessionFactory ?? defaultSessionFactory;
	let session: ChildAgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let removeAbort: (() => void) | undefined;
	let abortPromise: Promise<void> | undefined;
	let wasAborted = false;
	let promptError: unknown;
	let cleanupError: unknown;
	let sessionStartedAt: number | undefined;
	let finalResult: ChildAgentResult;

	const requestAbort = (cancellation: boolean) => {
		if (cancellation) wasAborted = true;
		if (!session || abortPromise) return;
		abortPromise = session.abort().catch((error: unknown) => {
			cleanupError ??= error;
		});
	};

	try {
		if (options.signal?.aborted) {
			return withDiagnostics(
				{ status: "aborted", text: "", errorMessage: "Child aborted before session initialization" },
				childDiagnostics(state, initializationStartedAt, undefined, undefined),
			);
		}
		if (options.model === undefined) {
			return withDiagnostics(
				failedResult("SWE Forge child execution requires an explicit provider/model identifier."),
				childDiagnostics(state, initializationStartedAt, undefined, undefined),
			);
		}
		validateModelIdentifier(options.model);
		const thinkingLevel = options.thinkingLevel ?? "medium";
		validateThinkingLevel(thinkingLevel);
		session = await sessionFactory({
			cwd,
			model: options.model,
			thinkingLevel,
			tools,
			systemPrompt: options.systemPrompt ?? "",
			signal: options.signal,
		});
		sessionStartedAt = performance.now();
		unsubscribe = session.subscribe((event) => processSessionEvent(event, state));

		const onAbort = () => requestAbort(true);
		if (options.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
			removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
			if (options.signal.aborted) onAbort();
		}
		if (options.signal?.aborted) {
			requestAbort(true);
		} else {
			try {
				await session.prompt(options.task);
			} catch (error) {
				promptError = error;
				requestAbort(options.signal?.aborted === true);
			}
		}

		if (abortPromise) await abortPromise;
		await session.waitForIdle();
		state.agentSettledAt ??= performance.now();
		state.assistantMessage ??= lastAssistantMessage(session.messages);
		if (state.assistantMessage) applyFinalAssistant(state.assistantMessage, state);

		const finalAssistant = state.assistantMessage;
		const stopReason = state.stopReason;
		const abortedByModel = stopReason === "aborted";
		const failedByModel = stopReason === "error" || stopReason === "length";
		const bounded = finalAssistant ? boundedTextFromMessage(finalAssistant, MAX_WORKER_RESULT_BYTES) : undefined;
		if (bounded?.truncated) state.outputTruncated = true;

		const status: ChildAgentStatus = wasAborted || options.signal?.aborted || abortedByModel
			? "aborted"
			: promptError || failedByModel || state.outputTruncated || !finalAssistant
				? "failed"
				: "completed";
		finalResult = {
			status,
			text: status === "completed" && bounded ? bounded.value : "",
			stopReason,
			errorMessage:
				status === "aborted"
					? "Child execution aborted"
					: state.outputTruncated
						? `Worker result exceeded the ${MAX_WORKER_RESULT_BYTES}-byte limit; return a concise canonical result.`
						: (state.errorMessage ??
							(promptError instanceof Error ? promptError.message : promptError ? String(promptError) : undefined) ??
							(status === "failed" && !finalAssistant
								? "AgentSession ended without a canonical assistant result"
								: status === "failed"
									? "AgentSession did not complete successfully"
									: undefined)),
			outputTruncated: state.outputTruncated || undefined,
		};
	} catch (error) {
		if (options.signal?.aborted || wasAborted) {
			finalResult = { status: "aborted", text: "", errorMessage: "Child execution aborted" };
		} else {
			finalResult = failedResult(error instanceof Error ? error.message : String(error));
		}
	} finally {
		removeAbort?.();
		if (session) {
			if (session.isStreaming) requestAbort(false);
			try {
				if (abortPromise) await abortPromise;
				await session.waitForIdle();
			} catch (error) {
				cleanupError ??= error;
			}
			try {
				session.dispose();
			} catch (error) {
				cleanupError ??= error;
			}
		}
		unsubscribe?.();
	}

	if (cleanupError && finalResult.status === "completed") {
		finalResult = failedResult(
			`AgentSession cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
		);
	}
	return withDiagnostics(
		finalResult,
		childDiagnostics(state, initializationStartedAt, sessionStartedAt, state.agentSettledAt ?? performance.now()),
	);
}

/**
 * Internal compatibility entry point for the canonical single-task runtime.
 * It is not re-exported from the package entry.
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

/** Execute exactly one bounded SWE-Forge task through a fresh AgentSession. */
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
		sessionFactory: internalOptions.sessionFactory,
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
