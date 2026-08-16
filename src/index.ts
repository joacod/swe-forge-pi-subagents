import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeSWEForgeTask, type ChildToolProfile } from "./runtime.js";

export * from "./checkout-scheduler.js";
export * from "./discovery.js";
export * from "./projection.js";
export * from "./runtime.js";

export const SWE_FORGE_SUBAGENT_TOOL_NAME = "swe_forge_subagent";

// Keep the provider-compatible enum shape used by current Pi without adding
// another runtime dependency to this small package.
function StringEnum<T extends readonly string[]>(values: T, description: string) {
	return Type.Unsafe<T[number]>({ type: "string", enum: values, description });
}

const SubagentParameters = Type.Object({
	roleName: Type.String({ description: "Discovered canonical SWE-Forge role name" }),
	taskContract: Type.String({ description: "Canonical bounded SWE-Forge task contract text" }),
	expectedOutputContract: StringEnum(
		["result", "review"] as const,
		"Canonical output contract the child must return",
	),
	profile: StringEnum(
		["READ_ONLY", "WRITABLE"] as const,
		"Closed Pi tool profile. READ_ONLY is read, grep, find, ls; WRITABLE adds edit, write, bash.",
	),
});

/**
 * The single Pi extension entry point for the Forge runtime.
 *
 * The tool executes one bounded task only. It does not schedule tasks, chain,
 * resume, steer, persist, create worktrees, deliver changes, or expose a
 * generic subagent. Capability profiles restrict model-visible Pi tools; they
 * are not an OS sandbox, and the child still has the invoking user's local
 * operating-system permissions.
 */
export default function registerSWEForgeSubagent(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SWE_FORGE_SUBAGENT_TOOL_NAME,
		label: "SWE Forge Child Agent",
		description:
			"Run exactly one bounded SWE-Forge task in a fresh Pi process. The role and canonical contracts are loaded dynamically. READ_ONLY exposes read, grep, find, ls; WRITABLE additionally exposes edit, write, bash. Profiles restrict model-visible Pi tools, not the operating-system permissions of the child process.",
		parameters: SubagentParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await executeSWEForgeTask({
				roleName: params.roleName,
				taskContract: params.taskContract,
				expectedOutputContract: params.expectedOutputContract,
				profile: params.profile as ChildToolProfile,
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
				details: result,
				...(result.runtime.status === "completed" ? {} : { isError: true }),
			};
		},
	});
}
