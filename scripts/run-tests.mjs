import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDirectory = await mkdtemp(join(tmpdir(), "swe-forge-pi-subagents-tests-"));
const compiler = join(root, "node_modules", "typescript", "bin", "tsc");

try {
	const compile = spawnSync(
		process.execPath,
		[compiler, "--project", join(root, "tsconfig.json"), "--noEmit", "false", "--outDir", buildDirectory],
		{ cwd: root, stdio: "inherit" },
	);
	if (compile.status !== 0) {
		process.exitCode = compile.status ?? 1;
	} else {
		await writeFile(join(buildDirectory, "package.json"), '{"type":"module"}\n', "utf8");
		await symlink(
			join(root, "node_modules"),
			join(buildDirectory, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const testDirectory = join(buildDirectory, "test");
		const testFiles = [join(testDirectory, "discovery.test.js"), join(testDirectory, "extension.test.js")];
		const test = spawnSync(process.execPath, ["--test", ...testFiles], { cwd: root, stdio: "inherit" });
		process.exitCode = test.status ?? 1;
	}
} finally {
	await rm(buildDirectory, { recursive: true, force: true });
}
