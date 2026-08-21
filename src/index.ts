import { Type } from "typebox";
import type { Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	executeSWEForgeTask,
	type ChildToolProfile,
	type SWEForgeTaskResult,
	type SWEForgeTaskRuntimeMetadata,
} from "./runtime.js";
import { getSWEForgeCapabilities, type SWEForgeCapabilities } from "./capabilities.js";
import {
	SWEForgeRuntimeError,
	type ExpectedOutputContract,
} from "./projection.js";

export * from "./capabilities.js";
export * from "./discovery.js";
export * from "./projection.js";
// Keep the package entry focused on the canonical task primitive. The generic
// Pi transport, argument builder, and checkout scheduler remain implementation
// details rather than a second child-agent API.
export {
	CHILD_TOOL_PROFILES,
	READ_ONLY_TOOLS,
	WRITABLE_TOOLS,
	executeSWEForgeTask,
} from "./runtime.js";
export type {
	BuiltinTool,
	ChildAgentRuntimeDiagnostics,
	ChildAgentUsageDiagnostics,
	ChildToolProfile,
	SWEForgeTaskOptions,
	SWEForgeTaskResult,
	SWEForgeTaskRuntimeMetadata,
	ThinkingLevel,
} from "./runtime.js";

export const SWE_FORGE_SUBAGENT_TOOL_NAME = "swe_forge_subagent";
export const SWE_FORGE_SUBAGENT_ACTIONS = Object.freeze(["capabilities", "run"] as const);

// Keep the provider-compatible enum shape used by current Pi without adding
// another runtime dependency to this small package.
function StringEnum<T extends readonly string[]>(values: T, description: string) {
	return Type.Unsafe<T[number]>({ type: "string", enum: values, description });
}

/**
 * The tool has one deliberately small parameter surface. A run supplies one
 * canonical role and one closed tool profile.
 */
const SubagentParameters = Type.Object({
	action: StringEnum(SWE_FORGE_SUBAGENT_ACTIONS, "Exactly one of: capabilities or run"),
	role: Type.Optional(Type.String({ description: "Discovered canonical SWE-Forge role name" })),
	workerBriefing: Type.Optional(
		Type.String({
			description: "The bounded worker_briefing/v1 projection rendered by the SWE-Forge root for this specific launch",
		}),
	),
	expectedOutputContract: Type.Optional(
		StringEnum(["result", "review"] as const, "Canonical output contract the child must return"),
	),
	profile: Type.Optional(
		StringEnum(
			["READ_ONLY", "WRITABLE"] as const,
			"Closed Pi tool profile. READ_ONLY is read, grep, find, ls; WRITABLE adds edit, write, bash.",
		),
	),
});

type SubagentParameters = Static<typeof SubagentParameters>;

export type SWEForgeSubagentRunDetails = {
	readonly runtime: Omit<SWEForgeTaskRuntimeMetadata, "text" | "assistantMessage">;
	readonly validation: SWEForgeTaskResult["validation"];
};

/** Test seams stay outside the Pi tool's public action surface. */
export interface SWEForgeSubagentExtensionDependencies {
	readonly executeTask?: typeof executeSWEForgeTask;
	readonly getCapabilities?: () => Promise<SWEForgeCapabilities>;
}

function inputError(
	code:
		| "INVALID_ROLE_NAME"
		| "EMPTY_WORKER_BRIEFING"
		| "INVALID_WORKER_BRIEFING"
		| "INVALID_EXPECTED_OUTPUT_CONTRACT"
		| "INVALID_TOOL_PROFILE",
	message: string,
): never {
	throw new SWEForgeRuntimeError(code, message);
}

function requiredRunInput(params: SubagentParameters): {
	readonly role: string;
	readonly workerBriefing: string;
	readonly expectedOutputContract: ExpectedOutputContract;
	readonly profile: ChildToolProfile;
} {
	const role = params.role;
	if (typeof role !== "string" || role.trim().length === 0) {
		return inputError("INVALID_ROLE_NAME", "run requires a canonical role name.");
	}
	if (Object.prototype.hasOwnProperty.call(params, "taskContract")) {
		return inputError(
			"INVALID_WORKER_BRIEFING",
			"taskContract is not accepted; run requires the workerBriefing worker_briefing/v1 projection.",
		);
	}
	if (typeof params.workerBriefing !== "string" || params.workerBriefing.trim().length === 0) {
		return inputError(
			"EMPTY_WORKER_BRIEFING",
			"run requires a non-empty worker_briefing/v1 projection rendered by the SWE-Forge root.",
		);
	}
	if (params.expectedOutputContract !== "result" && params.expectedOutputContract !== "review") {
		return inputError("INVALID_EXPECTED_OUTPUT_CONTRACT", "run requires expectedOutputContract=result or review.");
	}
	const profile = params.profile;
	if (profile !== "READ_ONLY" && profile !== "WRITABLE") {
		return inputError("INVALID_TOOL_PROFILE", "run requires profile=READ_ONLY or WRITABLE.");
	}
	return {
		role,
		workerBriefing: params.workerBriefing,
		expectedOutputContract: params.expectedOutputContract,
		profile,
	};
}

function runtimeDetails(result: SWEForgeTaskResult): SWEForgeSubagentRunDetails {
	// The canonical worker output is the tool content. Do not repeat it in the
	// diagnostic details as a second result contract or transcript-like field.
	const runtime = Object.fromEntries(
		Object.entries(result.runtime).filter(([key]) => key !== "text" && key !== "assistantMessage"),
	) as Omit<SWEForgeTaskRuntimeMetadata, "text" | "assistantMessage">;
	return {
		runtime,
		validation: result.validation,
	};
}

function capabilityContent(capabilities: SWEForgeCapabilities): string {
	return JSON.stringify(capabilities);
}

/**
 * The single Pi extension entry point for the Forge runtime.
 *
 * v1 exposes only `capabilities` and one bounded `run`. It does not expose
 * scheduling, chains, background work, resume/steer, recursion, worktrees,
 * workflow/topology selection, or delivery actions.
 */
export default function registerSWEForgeSubagent(
	pi: ExtensionAPI,
	dependencies: SWEForgeSubagentExtensionDependencies = {},
): void {
	const executeTask = dependencies.executeTask ?? executeSWEForgeTask;
	const loadCapabilities = dependencies.getCapabilities ?? (() => getSWEForgeCapabilities());

	pi.registerTool({
		name: SWE_FORGE_SUBAGENT_TOOL_NAME,
		label: "SWE Forge Child Agent",
		description:
			"SWE Forge runtime primitive. action=capabilities reports observed runtime support; action=run transports exactly one bounded worker_briefing/v1 launch. No chains, arrays, background jobs, resume, steer, recursion, worktrees, workflow/topology selection, or delivery actions.",
		parameters: SubagentParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.action === "capabilities") {
				const capabilities = await loadCapabilities();
				return {
					content: [{ type: "text", text: capabilityContent(capabilities) }],
					details: capabilities,
					...(capabilities.compatibilityErrors.length > 0 ? { isError: true } : {}),
				};
			}

			if (params.action !== "run") {
				throw new SWEForgeRuntimeError(
					"INVALID_ACTION",
					`Unsupported swe_forge_subagent action: ${JSON.stringify(params.action)}`,
				);
			}

			const input = requiredRunInput(params);
			const result = await executeTask({
				role: input.role,
				workerBriefing: input.workerBriefing,
				expectedOutputContract: input.expectedOutputContract,
				profile: input.profile,
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				signal,
			});
			const text =
				result.output ||
				result.runtime.errorMessage ||
				(result.runtime.status === "aborted" ? "Child execution aborted" : `Child ${result.runtime.status}`);
			return {
				content: [{ type: "text", text }],
				details: runtimeDetails(result),
				...(result.runtime.status === "completed" ? {} : { isError: true }),
			};
		},
	});
}
