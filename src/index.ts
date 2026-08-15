import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

const DELEGATION_TOOL_NAMES = ["subagent", "swe_forge_subagent"] as const;
const MAX_STDERR_BYTES = 16 * 1024;

type BuiltinTool = (typeof BUILTIN_TOOLS)[number];
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ChildAgentStatus = "completed" | "failed" | "aborted";
export type JsonObject = Record<string, unknown>;

export interface ChildAgentOptions {
	task: string;
	systemPrompt?: string;
	cwd?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools: readonly string[];
	signal?: AbortSignal;
	/** Test seam for a Pi executable or fixture. Defaults to the active Pi CLI. */
	piCommand?: string;
	/** Arguments placed before the runner's Pi CLI arguments. */
	piCommandArgs?: readonly string[];
	/** Additional child environment values. The parent environment is inherited. */
	env?: NodeJS.ProcessEnv;
}

export interface ChildAgentResult {
	status: ChildAgentStatus;
	exitCode: number | null;
	text: string;
	assistantMessage?: JsonObject;
	stderr: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface ChildInvocation {
	command: string;
	args: readonly string[];
}

interface ChildEvent extends JsonObject {
	type?: unknown;
}

interface ChildProcessOutcome {
	exitCode: number | null;
	spawnError?: Error;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
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

function appendBounded(current: string, chunk: string): string {
	const bytes = Buffer.concat([Buffer.from(current), Buffer.from(chunk)]);
	if (bytes.byteLength <= MAX_STDERR_BYTES) return bytes.toString("utf8");

	return `${bytes.subarray(0, MAX_STDERR_BYTES).toString("utf8")}\n[stderr truncated]`;
}

function validateTools(tools: readonly string[]): BuiltinTool[] {
	const unique = [...new Set(tools)];
	const unknown = unique.filter((tool): tool is string => !BUILTIN_TOOLS.includes(tool as BuiltinTool));
	if (unknown.length > 0) {
		throw new Error(`Unsupported child tool(s): ${unknown.join(", ")}`);
	}
	return unique as BuiltinTool[];
}

/**
 * Build the one-shot CLI arguments used for every child.
 *
 * Resource discovery is intentionally disabled here. SWE Forge supplies the
 * child contract explicitly rather than asking a child to discover workflow
 * roles or to load the adapter recursively.
 */
export function buildChildArgs(options: {
	task: string;
	systemPromptPath?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	tools: readonly string[];
}): string[] {
	const tools = validateTools(options.tools);
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

	args.push(`Task: ${options.task}`);
	return args;
}

/**
 * Resolve the Pi process without depending on a globally installed package
 * when the caller is itself running from Pi's CLI entry point.
 */
export function resolvePiInvocation(): ChildInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
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
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
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
		if (!pid) return;
		try {
			if (process.platform === "win32") child.kill(signal);
			else process.kill(-pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// The process has already exited.
			}
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
			finish({ exitCode: 1, spawnError });
		});
		child.once("close", (code) => finish({ exitCode: code, spawnError }));
	});
}

function applyAssistantMessage(
	message: JsonObject,
	state: {
		assistantMessage?: JsonObject;
		text: string;
		stopReason?: string;
		errorMessage?: string;
	},
): void {
	if (message.role !== "assistant") return;

	state.assistantMessage = message;
	const text = textFromMessage(message);
	if (text) state.text = text;
	state.stopReason = asNonEmptyString(message.stopReason);
	state.errorMessage = asNonEmptyString(message.errorMessage);
}

function processChildEvent(
	line: string,
	state: {
		assistantMessage?: JsonObject;
		text: string;
		stopReason?: string;
		errorMessage?: string;
		agentEnded: boolean;
	},
): void {
	if (!line.trim()) return;

	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
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

/** Run one isolated Pi conversation and return only its final structured data. */
export async function runChildAgent(options: ChildAgentOptions): Promise<ChildAgentResult> {
	const tools = validateTools(options.tools);
	const cwd = options.cwd ?? process.cwd();
	const invocation = options.piCommand
		? { command: options.piCommand, args: options.piCommandArgs ?? [] }
		: resolvePiInvocation();
	const state = {
		assistantMessage: undefined as JsonObject | undefined,
		text: "",
		stopReason: undefined as string | undefined,
		errorMessage: undefined as string | undefined,
		agentEnded: false,
	};
	let stderr = "";
	let wasAborted = false;
	let removeAbort: (() => void) | undefined;
	let clearTermination: (() => void) | undefined;
	let tempDir: string | undefined;

	try {
		if (options.signal?.aborted) {
			return {
				status: "aborted",
				exitCode: null,
				text: "",
				stderr: "",
				errorMessage: "Child aborted before launch",
			};
		}

		let systemPromptPath: string | undefined;
		if (options.systemPrompt?.trim()) {
			tempDir = await mkdtemp(join(tmpdir(), "swe-forge-pi-subagent-"));
			systemPromptPath = join(tempDir, "system-prompt.md");
			await writeFile(systemPromptPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });
		}

		const childArgs = buildChildArgs({
			task: options.task,
			systemPromptPath,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			tools,
		});
		const child = spawn(invocation.command, [...invocation.args, ...childArgs], {
			cwd,
			env: { ...process.env, ...options.env },
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// A detached POSIX process group lets cancellation include Pi-launched
			// shell descendants. Windows uses the direct process fallback below.
			detached: process.platform !== "win32",
			windowsHide: true,
		});

		consumeJsonLines(child.stdout, (line) => processChildEvent(line, state));
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBounded(stderr, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		});

		const onAbort = () => {
			wasAborted = true;
			clearTermination?.();
			clearTermination = terminateProcess(child);
		};
		if (options.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
			removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
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
			errorMessage: outcome.spawnError?.message ?? state.errorMessage ?? (status === "failed" ? "Child produced no successful result" : undefined),
		};
	} finally {
		removeAbort?.();
		clearTermination?.();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}
}

const SubagentParameters = Type.Object({
	task: Type.String({ description: "The bounded task for one child agent" }),
	systemPrompt: Type.String({ description: "The role and task contract supplied by SWE Forge" }),
	tools: Type.Array(Type.String(), { description: "Closed list of built-in Pi tools for the child" }),
});

/**
 * Pi extension entry point. It exposes one low-level child execution tool; all
 * topology, task, role, and result-contract decisions remain with SWE Forge.
 */
export default function registerSWEForgeSubagent(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "swe_forge_subagent",
		label: "SWE Forge Child Agent",
		description:
			"Run exactly one Pi child-agent context in the current checkout. Supply the SWE Forge role/contract prompt and an explicit built-in tool allowlist. This tool does not schedule, chain, or isolate filesystems.",
		parameters: SubagentParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runChildAgent({
				task: params.task,
				systemPrompt: params.systemPrompt,
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				tools: params.tools,
				signal,
			});

			const text = result.text || result.errorMessage || `Child ${result.status}`;
			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});
}
