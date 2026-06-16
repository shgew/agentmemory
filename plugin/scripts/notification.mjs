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
//#region src/hooks/notification.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
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
	const notificationType = data.notification_type ?? data.notificationType;
	if (notificationType !== "permission_prompt") return;
	const rawSessionId = data.session_id ?? data.sessionId;
	const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : "unknown";
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "notification",
			sessionId,
			project: resolveProject(data.cwd),
			cwd: data.cwd || process.cwd(),
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				notification_type: notificationType,
				title: data.title,
				message: data.message
			}
		}),
		signal: AbortSignal.timeout(2e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main();
//#endregion
export {};

//# sourceMappingURL=notification.mjs.map