import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverSWEForgeInstallation } from "./discovery.js";

export * from "./discovery.js";

export const SWE_FORGE_SUBAGENT_TOOL_NAME = "swe_forge_subagent";

const SubagentParameters = Type.Object({
	task: Type.String({ description: "The bounded task that SWE Forge will eventually delegate" }),
});

/**
 * The single Pi extension entry point for this package.
 *
 * Child execution is intentionally deferred. Registering the final tool name
 * here keeps the package boundary stable without introducing orchestration or
 * a second generic subagent tool.
 */
export default function registerSWEForgeSubagent(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SWE_FORGE_SUBAGENT_TOOL_NAME,
		label: "SWE Forge Subagent",
		description:
			"SWE Forge's optional child-agent execution primitive. Child execution is not implemented in this package skeleton yet.",
		parameters: SubagentParameters,
		async execute() {
			const installation = await discoverSWEForgeInstallation();
			throw new Error(
				`SWE Forge child execution is not implemented yet (version ${installation.version}, root ${installation.root}).`,
			);
		},
	});
}
