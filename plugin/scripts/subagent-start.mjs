#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
//#region src/hooks/_project.ts
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = gitRevParse(dir, "--show-toplevel");
		const gitDir = gitRevParse(dir, "--git-dir");
		const commonDir = gitRevParse(dir, "--git-common-dir");
		const root = resolve(dir, gitDir) === resolve(dir, commonDir) ? top : resolve(dir, commonDir, "..");
		if (root) return basename(root);
	} catch {}
	return basename(dir);
}
function gitRevParse(cwd, arg) {
	return execFileSync("git", ["rev-parse", arg], {
		cwd,
		stdio: [
			"ignore",
			"pipe",
			"ignore"
		],
		timeout: 500
	}).toString().trim();
}
//#endregion
//#region src/hooks/subagent-start.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const TIMEOUT_MS = 800;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || "unknown";
	const agentId = data.agent_id || data.agentName;
	const agentType = data.agent_type || data.agentDisplayName || data.agentName;
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "subagent_start",
			sessionId,
			project: resolveProject(data.cwd),
			cwd: data.cwd || process.cwd(),
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				agent_id: agentId,
				agent_type: agentType
			}
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main();
//#endregion
export {};

//# sourceMappingURL=subagent-start.mjs.map