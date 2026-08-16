import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
if (result.status !== 0) {
	console.error(result.stderr || "git ls-files failed");
	process.exit(result.status ?? 1);
}

const checkedExtensions = new Set([".json", ".md", ".mjs", ".ts"]);
const paths = result.stdout.split("\0").filter((path) => {
	const dot = path.lastIndexOf(".");
	return dot >= 0 && checkedExtensions.has(path.slice(dot));
});
const failures = [];

for (const path of paths) {
	const content = await readFile(path, "utf8");
	const lines = content.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index += 1) {
		if (/[ \t]+$/u.test(lines[index])) failures.push(`${path}:${index + 1}: trailing whitespace`);
	}
	if (content.length > 0 && !content.endsWith("\n")) failures.push(`${path}: missing final newline`);
}

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log(`format invariants passed for ${paths.length} tracked files`);
