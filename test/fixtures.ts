import { cp, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Tiny, deliberately synthetic SWE-Forge installation used by integration
 * tests. It is copied before mutation so the fixture itself remains immutable.
 */
export const FAKE_SWE_FORGE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-swe-forge");

export async function copyFakeSWEForgeInstallation(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "swe-forge-fake-installation-"));
	await cp(FAKE_SWE_FORGE_FIXTURE, root, { recursive: true });
	return root;
}
