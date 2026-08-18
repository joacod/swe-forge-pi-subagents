#!/usr/bin/env node

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAcceptanceModel } from "./acceptance-model.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sweForgeRoot = join(homedir(), ".pi", "agent", "swe-forge");
const sweForgeRepo = resolve(process.env.SWE_FORGE_ACCEPTANCE_REPO ?? resolve(packageRoot, "..", "swe-forge"));
const mainAdapter = process.env.SWE_FORGE_ACCEPTANCE_ADAPTER ?? join(homedir(), ".pi", "agent", "extensions", "swe-forge-runtime.ts");
const canonicalTemplate = process.env.SWE_FORGE_ACCEPTANCE_PROMPT ?? join(homedir(), ".pi", "agent", "prompts", "swe-forge.md");
const packageExtension = process.env.SWE_FORGE_ACCEPTANCE_PACKAGE ?? join(packageRoot, "src", "index.ts");
const requestedScenario = process.argv[process.argv.indexOf("--scenario") + 1] ?? "all";
const model = resolveAcceptanceModel();
const keepTemp = process.env.SWE_FORGE_ACCEPTANCE_KEEP_TEMP === "1";
const scenarios = new Set(["A", "B", "C", "D", "E", "F", "all"]);

function usage() {
	console.log(`Usage: npm run acceptance -- [--scenario A|B|C|D|E|F|all]

Runs the opt-in release acceptance path. A-D use a real Pi process, the live
SWE-Forge support root, and the optional package; E uses a malformed child
stream and F runs the adapter topology-protection fixture.

Model resolution for A-D:
  SWE_FORGE_ACCEPTANCE_MODEL=provider/model  # optional explicit override
  Otherwise, non-empty PI_PROVIDER plus PI_MODEL become provider/model when
  launched from the current Pi Bash session. Ordinary terminal/CI runs may
  still need SWE_FORGE_ACCEPTANCE_MODEL explicitly.

Optional:
  SWE_FORGE_ACCEPTANCE_PACKAGE=/path/to/installed-or-source-package/src/index.ts
  SWE_FORGE_ACCEPTANCE_REPO=/path/to/swe-forge
  SWE_FORGE_ACCEPTANCE_ADAPTER=/path/to/installed/swe-forge-runtime.ts
  SWE_FORGE_ACCEPTANCE_PROMPT=/path/to/installed/swe-forge.md
  SWE_FORGE_ACCEPTANCE_KEEP_TEMP=1
  SWE_FORGE_ACCEPTANCE_REQUIRED=1  # fail instead of skipping A-D without a model
`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	usage();
	process.exit(0);
}
if (!scenarios.has(requestedScenario)) {
	console.error(`Unknown scenario ${requestedScenario}. Use A, B, C, D, E, F, or all.`);
	process.exit(2);
}

const temporaryPaths = [];
function selected(name) {
	return requestedScenario === "all" || requestedScenario === name;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function requirePath(path, description) {
	try {
		await access(path);
	} catch {
		throw new Error(`${description} is unavailable: ${path}`);
	}
}

async function canonicalRole(preferredNames, supportRoot = sweForgeRoot) {
	const directory = join(supportRoot, ".swe-forge", "agents");
	const names = (await readdir(directory, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => entry.name.slice(0, -3));
	return preferredNames.find((name) => names.includes(name)) ?? names[0];
}

async function writeRunState(directory, id, topology) {
	const stateDirectory = join(directory, `state-${id}`);
	await mkdir(stateDirectory);
	const checkout = join(directory, `checkout-${id}`);
	await mkdir(checkout);
	const statePath = join(stateDirectory, "run-state.yaml");
	await writeFile(
		statePath,
		`workflow: swe-forge
workflow_version: 1
schema_version: 2
run_id: acceptance-${id}
status: running
requested_mode: ${topology}
preferred_mode: ${topology}
execution_mode: ${topology}
requested_provider: AUTO
execution_provider: NONE
delegation_backend: NATIVE
write_isolation: SHARED
invocation_checkout:
  path: ${checkout}
delivery_checkout:
  path: ${checkout}
routing:
  current: ${topology}
  preferred: ${topology}
  context_value:
    projected_pressure: low
continuation:
  workflow_active: true
  workflow: ticket
  phase: implementation
  step: 1
  awaiting: none
  next_action:
    kind: acceptance
    target: bounded delegation
    expected_context_tokens: unknown
  safe_boundary: true
  updated_at: 2099-01-01T00:00:00Z
  delivery:
    mode: GUIDED
    pr_number: none
    pr_state: none
context:
  status: healthy
`,
		"utf8",
	);
	return { checkout, statePath };
}

async function runPi({ id, topology, packageEnabled, ticket, tools = packageEnabled ? "swe_forge_subagent" : undefined }) {
	await requirePath(sweForgeRoot, "canonical SWE-Forge support root");
	await requirePath(mainAdapter, "SWE-Forge Pi runtime extension");
	await requirePath(canonicalTemplate, "canonical SWE-Forge Pi prompt");
	if (packageEnabled) await requirePath(packageExtension, "subagent package extension");

	const directory = await mkdtemp(join(tmpdir(), "swe-forge-acceptance-"));
	temporaryPaths.push(directory);
	const { checkout, statePath } = await writeRunState(directory, id, topology);
	const promptPath = join(directory, "swe-forge.md");
	await writeFile(promptPath, await readFile(canonicalTemplate, "utf8"), { mode: 0o600 });

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
		"-e",
		mainAdapter,
		"--prompt-template",
		promptPath,
		"--thinking",
		"off",
	];
	if (model) args.push("--model", model);
	if (packageEnabled) args.push("-e", packageExtension);
	if (tools) args.push("--tools", tools);
	else args.push("--no-tools");
	args.push(`/swe-forge ${topology.toLowerCase()} ${ticket}`);

	const environment = { ...process.env, SWE_FORGE_RUN_STATE: statePath };
	delete environment.SWE_FORGE_ROOT;
	const child = spawn("pi", args, { cwd: checkout, env: environment, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exitCode = await new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolveExit(code ?? 1));
	});
	const events = stdout
		.split(/\r?\n/u)
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { type: "invalid_json", line };
			}
		});
	const toolCalls = events
		.filter((event) => event.type === "tool_execution_start" && event.toolName === "swe_forge_subagent")
		.map((event) => event.args);
	const toolResults = events
		.filter((event) => event.type === "tool_execution_end" && event.toolName === "swe_forge_subagent")
		.map((event) => event.result);
	const assistantText = events
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.flatMap((event) => (Array.isArray(event.message.content) ? event.message.content : []))
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { checkout, statePath, exitCode, stderr, stdout, events, toolCalls, toolResults, assistantText };
}

function resultForAction(run, action) {
	if (action === "run") return run.toolResults.find((result) => result?.details?.runtime);
	return run.toolResults.find((result) => result?.details);
}

async function scenarioA() {
	const run = await runPi({
		id: "A",
		topology: "SUBAGENTS",
		packageEnabled: true,
		ticket: `Perform capability discovery only. Call swe_forge_subagent with action capabilities, inspect the response, and do not run a child.`,
	});
	assert(run.exitCode === 0, `Scenario A Pi exited ${run.exitCode}: ${run.stderr}`);
	const capabilitiesCall = run.toolCalls.find((input) => input?.action === "capabilities");
	assert(capabilitiesCall, "Scenario A did not call action=capabilities");
	const capabilityResult = run.toolResults.find((result) => result?.details?.protocolVersion === 1);
	assert(capabilityResult, "Scenario A did not return protocolVersion=1 capabilities");
	console.log("PASS A: real Pi discovered protocolVersion=1 SWE-Forge subagent capability");
}

async function scenarioB() {
	const role = await canonicalRole(["researcher", "reader", "reviewer"]);
	const taskContract = `TASK_ID: acceptance-read-only
OBJECTIVE: Read README.md and report its first heading. Do not modify any file.`;
	const run = await runPi({
		id: "B",
		topology: "SUBAGENTS",
		packageEnabled: true,
		ticket: `Run exactly one READ_ONLY bounded task with role=${role}, profile=READ_ONLY, expectedOutputContract=result. Call capabilities first. Set taskContract to exactly this JSON string and do not append any surrounding instructions to its value: ${JSON.stringify(taskContract)}. After the run result is returned, report that the canonical result was consumed and do not perform any writable action.`,
	});
	assert(run.exitCode === 0, `Scenario B Pi exited ${run.exitCode}: ${run.stderr}`);
	const runCall = run.toolCalls.find((input) => input?.action === "run");
	assert(runCall, "Scenario B did not create a child run");
	assert(runCall.profile === "READ_ONLY", `Scenario B used profile ${runCall.profile}`);
	const result = resultForAction(run, "run");
	assert(result?.details?.runtime?.status === "completed", `Scenario B child result was not completed: ${JSON.stringify({ result, toolResults: run.toolResults })}`);
	assert(/^0\.84\./u.test(result.details.runtime.piVersion ?? ""), `Scenario B did not verify a real supported Pi child: ${result.details.runtime.piVersion ?? "missing"}`);
	assert(JSON.stringify(result.details.runtime.tools) === JSON.stringify(["read", "grep", "find", "ls"]), "Scenario B exposed unexpected tools");
	assert(!runCall.taskContract.includes("write_access: read-write"), "Scenario B requested writable access");
	console.log("PASS B: real READ_ONLY child completed with isolated context and read-only tools");
}

async function scenarioC() {
	const role = await canonicalRole(["implementer", "writer"]);
	const directory = await mkdtemp(join(tmpdir(), "swe-forge-acceptance-writable-"));
	temporaryPaths.push(directory);
	const marker = join(directory, "bounded-writable-marker.txt");
	const taskContract = `TASK_ID: acceptance-writable
OBJECTIVE: Create exactly one file at ${marker} containing exactly ACCEPTANCE_WRITABLE. Do not edit any other file.`;
	const run = await runPi({
		id: "C",
		topology: "SUBAGENTS",
		packageEnabled: true,
		ticket: `Run exactly one WRITABLE bounded task with role=${role}, profile=WRITABLE, expectedOutputContract=result. Call capabilities first. Set taskContract to exactly this JSON string and do not append any surrounding instructions to its value: ${JSON.stringify(taskContract)}. The child must create the requested marker, then consume the canonical result. Do not start another child.`,
	});
	assert(run.exitCode === 0, `Scenario C Pi exited ${run.exitCode}: ${run.stderr}`);
	const runCalls = run.toolCalls.filter((input) => input?.action === "run");
	assert(runCalls.length === 1, `Scenario C expected exactly one bounded run, got ${runCalls.length}: ${JSON.stringify({ runCalls, toolResults: run.toolResults })}`);
	assert(runCalls[0].profile === "WRITABLE", `Scenario C used profile ${runCalls[0].profile}`);
	const result = run.toolResults.find((item) => item?.details?.runtime?.profile === "WRITABLE");
	assert(result?.details?.runtime?.status === "completed", `Scenario C writable child result was not completed: ${JSON.stringify({ result, toolResults: run.toolResults })}`);
	assert(/^0\.84\./u.test(result.details.runtime.piVersion ?? ""), `Scenario C did not verify a real supported Pi child: ${result.details.runtime.piVersion ?? "missing"}`);
	assert(await readFile(marker, "utf8") === "ACCEPTANCE_WRITABLE", "Scenario C marker was not written exactly");
	console.log("PASS C: real WRITABLE delegation ran once and returned a canonical result");
}

async function scenarioD() {
	const run = await runPi({
		id: "D",
		topology: "SUBAGENTS",
		packageEnabled: false,
		ticket: "The optional subagent package is unavailable. Use the existing SOLO/sequential fallback and report that no child delegation occurred.",
	});
	assert(run.exitCode === 0, `Scenario D Pi exited ${run.exitCode}: ${run.stderr}`);
	assert(run.toolCalls.length === 0, "Scenario D attempted a missing subagent capability");
	console.log("PASS D: removing the package preserved graceful fallback");
}

async function scenarioE() {
	await requirePath(join(packageRoot, "dist", "runtime.js"), "built runtime (run npm run build first)");
	const runtime = await import(pathToFileURL(join(packageRoot, "dist", "runtime.js")).href);
	const directory = await mkdtemp(join(tmpdir(), "swe-forge-acceptance-malformed-"));
	temporaryPaths.push(directory);
	const child = join(directory, "malformed-child.mjs");
	await writeFile(
		child,
		`const message = { role: "assistant", content: [{ type: "text", text: "STATUS: DONE\\nTASK_ID: acceptance-malformed\\nSUMMARY: truncated" }], stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n" + JSON.stringify({ type: "agent_end", messages: [message] }) + "\\n");\n`,
		"utf8",
	);
	await assertRejectsCode(
		runtime.executeSWEForgeTask({
			role: await canonicalRole(["researcher", "reader", "reviewer"], sweForgeRepo),
			taskContract: "TASK_ID: acceptance-malformed\nOBJECTIVE: fail closed\nwrite_access: read-only\n",
			expectedOutputContract: "result",
			profile: "READ_ONLY",
			cwd: directory,
			model: "fixture/model",
			piCommand: process.execPath,
			piCommandArgs: [child],
			discovery: { env: { SWE_FORGE_ROOT: sweForgeRepo } },
		}),
		"MISSING_OUTPUT_STRUCTURE",
	);
	console.log("PASS E: malformed child output failed closed");
}

async function assertRejectsCode(promise, code) {
	try {
		await promise;
	} catch (error) {
		assert(error?.code === code || error?.details?.code === code, `expected ${code}, got ${error?.code ?? error}`);
		return;
	}
	throw new Error(`expected ${code} rejection`);
}

async function scenarioF() {
	const fixture = join(sweForgeRepo, "scripts", "test-swe-forge-pi");
	await requirePath(fixture, "Pi adapter topology-protection fixture");
	try {
		await execFileAsync(fixture, [], { env: { ...process.env, SWE_FORGE_PI_CI: "1" } });
	} catch (error) {
		throw new Error(`Scenario F adapter fixture failed: ${error.stderr ?? error.message}`);
	}
	console.log("PASS F: adapter fixture proved ISOLATED work is blocked from shared subagents");
}

async function main() {
	if (!scenarios.has(requestedScenario)) throw new Error(`Unknown scenario ${requestedScenario}`);
	if (selected("E")) await scenarioE();
	if (selected("F")) await scenarioF();
	const realRequested = ["A", "B", "C", "D"].some(selected);
	if (realRequested && !model) {
		const message =
			"Scenarios A-D skipped: set SWE_FORGE_ACCEPTANCE_MODEL=provider/model or provide non-empty PI_PROVIDER and PI_MODEL from a Pi Bash session to run real Pi/model acceptance.";
		if (process.env.SWE_FORGE_ACCEPTANCE_REQUIRED === "1") throw new Error(message);
		console.log(`SKIP: ${message}`);
		return;
	}
	if (selected("A")) await scenarioA();
	if (selected("B")) await scenarioB();
	if (selected("C")) await scenarioC();
	if (selected("D")) await scenarioD();
}

try {
	await main();
} finally {
	if (!keepTemp) {
		await Promise.all(temporaryPaths.map((path) => rm(path, { recursive: true, force: true })));
	} else if (temporaryPaths.length > 0) {
		console.log(`Acceptance temporary paths retained: ${temporaryPaths.join(" ")}`);
	}
}
