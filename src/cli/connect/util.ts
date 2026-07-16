import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";

// Env values use ${VAR:-default} expansion so the wired MCP entry
// inherits AGENTMEMORY_URL / AGENTMEMORY_SECRET / AGENTMEMORY_TOOLS
// from the user's shell, but never fails parse when the var is unset
// (#510). Earlier `${VAR}` form caused Claude Code to silently drop the
// server when no shell-level export existed — per the Claude Code MCP
// docs, "If a required environment variable is not set and has no
// default value, Claude Code will fail to parse the config."
//
// Defaults match the documented runtime: localhost:3111 (no auth, all
// tools). One wired entry now serves local AND remote (Kubernetes /
// reverse-proxied) deployments without doctor-warning duplicates (#375)
// AND fresh installs that haven't exported envs (#510).
export const AGENTMEMORY_MCP_BLOCK = {
  command: "npx",
  args: ["-y", "@agentmemory/mcp"],
  env: {
    AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
    AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
    AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
  },
};

const COPILOT_MCP_COMMAND =
  process.platform === "win32"
    ? {
        command: process.env["ComSpec"] || process.env["COMSPEC"] || "cmd.exe",
        args: ["/d", "/s", "/c", "npx", "-y", "@agentmemory/mcp"],
      }
    : {
        command: "npx",
        args: ["-y", "@agentmemory/mcp"],
      };

export const AGENTMEMORY_COPILOT_MCP_BLOCK = {
  type: "local" as const,
  ...COPILOT_MCP_COMMAND,
  env: {
    AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
    AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
    AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
  },
  tools: ["*"],
};

export function backupsDir(): string {
  const home =
    process.env["HOME"]?.trim() ||
    process.env["USERPROFILE"]?.trim() ||
    homedir();
  return join(home, ".agentmemory", "backups");
}

export function ensureBackupsDir(): string {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function backupFile(
  sourcePath: string,
  agent: string,
  ext = "json",
): string {
  ensureBackupsDir();
  const stamp = timestampSlug();
  for (let suffix = 0; ; suffix++) {
    const discriminator = suffix === 0 ? "" : `-${suffix}`;
    const target = join(
      backupsDir(),
      `${agent}-${stamp}${discriminator}.${ext}`,
    );
    try {
      copyFileSync(sourcePath, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function normalizeJsonc(source: string): string {
  const chars = [...source];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    const next = chars[index + 1];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      while (index < chars.length && chars[index] !== "\n") {
        chars[index] = " ";
        index++;
      }
      index--;
      continue;
    }
    if (char === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      while (
        index < chars.length &&
        !(chars[index] === "*" && chars[index + 1] === "/")
      ) {
        if (chars[index] !== "\n" && chars[index] !== "\r") {
          chars[index] = " ";
        }
        index++;
      }
      if (index < chars.length) {
        chars[index] = " ";
        chars[index + 1] = " ";
        index++;
      }
    }
  }

  inString = false;
  escaped = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== ",") continue;
    let next = index + 1;
    while (/\s/.test(chars[next] ?? "")) next++;
    if (chars[next] === "}" || chars[next] === "]") chars[index] = " ";
  }
  return chars.join("");
}

export function readJsonSafe<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readJsoncSafe<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(normalizeJsonc(readFileSync(path, "utf-8"))) as T;
  } catch {
    return null;
  }
}

function skipJsoncTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index] ?? "")) {
      index++;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index++;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }
    break;
  }
  return index;
}

function scanJsoncString(source: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === '"') {
      return index + 1;
    }
  }
  throw new Error("Unterminated JSONC string");
}

function scanJsoncValue(source: string, start: number): number {
  const valueStart = skipJsoncTrivia(source, start);
  const first = source[valueStart];
  if (first === '"') return scanJsoncString(source, valueStart);
  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    let index = valueStart + 1;
    while (index < source.length && stack.length > 0) {
      const char = source[index];
      if (char === '"') {
        index = scanJsoncString(source, index);
        continue;
      }
      if (char === "/" && source[index + 1] === "/") {
        index = skipJsoncTrivia(source, index);
        continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        index = skipJsoncTrivia(source, index);
        continue;
      }
      if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === stack[stack.length - 1]) stack.pop();
      index++;
    }
    if (stack.length > 0) throw new Error("Unterminated JSONC value");
    return index;
  }
  let index = valueStart;
  while (index < source.length) {
    const char = source[index];
    if (char === "," || char === "}" || char === "]" || /\s/.test(char ?? "")) {
      break;
    }
    index++;
  }
  return index;
}

interface JsoncPropertySpan {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

interface JsoncObjectSpan {
  start: number;
  end: number;
  properties: JsoncPropertySpan[];
}

function scanJsoncObject(source: string, start: number): JsoncObjectSpan {
  const objectStart = skipJsoncTrivia(source, start);
  if (source[objectStart] !== "{") throw new Error("Expected JSONC object");
  const properties: JsoncPropertySpan[] = [];
  let index = objectStart + 1;
  while (index < source.length) {
    index = skipJsoncTrivia(source, index);
    if (source[index] === "}") {
      return { start: objectStart, end: index + 1, properties };
    }
    const keyStart = index;
    const keyEnd = scanJsoncString(source, keyStart);
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as string;
    index = skipJsoncTrivia(source, keyEnd);
    if (source[index] !== ":") throw new Error("Expected JSONC property colon");
    const valueStart = skipJsoncTrivia(source, index + 1);
    const valueEnd = scanJsoncValue(source, valueStart);
    properties.push({ key, keyStart, valueStart, valueEnd });
    index = skipJsoncTrivia(source, valueEnd);
    if (source[index] === ",") {
      index++;
      continue;
    }
    if (source[index] !== "}") throw new Error("Expected JSONC property separator");
  }
  throw new Error("Unterminated JSONC object");
}

function lineIndent(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const prefix = source.slice(lineStart, index);
  return /^\s*$/.test(prefix) ? prefix : "";
}

function formatJsoncValue(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function setJsoncObjectProperty(
  source: string,
  object: JsoncObjectSpan,
  key: string,
  value: unknown,
): string {
  const existing = object.properties.find((property) => property.key === key);
  if (existing) {
    return `${source.slice(0, existing.valueStart)}${formatJsoncValue(value, lineIndent(source, existing.keyStart))}${source.slice(existing.valueEnd)}`;
  }

  const close = object.end - 1;
  const closeIndent = lineIndent(source, close);
  const propertyIndent = object.properties.length > 0
    ? lineIndent(source, object.properties[0]!.keyStart) || `${closeIndent}  `
    : `${closeIndent}  `;
  const property = `${JSON.stringify(key)}: ${formatJsoncValue(value, propertyIndent)}`;
  if (object.properties.length === 0) {
    if (closeIndent || source.slice(object.start + 1, close).includes("\n")) {
      return `${source.slice(0, close)}\n${propertyIndent}${property}\n${closeIndent}${source.slice(close)}`;
    }
    return `${source.slice(0, close)}${property}${source.slice(close)}`;
  }

  const last = object.properties[object.properties.length - 1]!;
  const separator = skipJsoncTrivia(source, last.valueEnd);
  const hasTrailingComma = source[separator] === ",";
  const closeLineStart = source.lastIndexOf("\n", close - 1) + 1;
  const closeIsOwnLine = /^\s*$/.test(source.slice(closeLineStart, close));
  if (!closeIsOwnLine) {
    const comma = hasTrailingComma ? "" : ",";
    return `${source.slice(0, close)}${comma} ${property}${source.slice(close)}`;
  }

  let updated = source;
  if (!hasTrailingComma) {
    updated = `${updated.slice(0, last.valueEnd)},${updated.slice(last.valueEnd)}`;
  }
  const adjustedCloseLineStart = closeLineStart + (hasTrailingComma ? 0 : 1);
  return `${updated.slice(0, adjustedCloseLineStart)}${propertyIndent}${property}\n${updated.slice(adjustedCloseLineStart)}`;
}

export function upsertJsoncNestedPropertyAtomic(
  path: string,
  parentKey: string,
  key: string,
  value: unknown,
): void {
  const source = readFileSync(path, "utf-8");
  const root = scanJsoncObject(source, 0);
  const parent = root.properties.find((property) => property.key === parentKey);
  let updated: string;
  if (!parent || source[parent.valueStart] !== "{") {
    updated = setJsoncObjectProperty(source, root, parentKey, { [key]: value });
  } else {
    const parentObject = scanJsoncObject(source, parent.valueStart);
    updated = setJsoncObjectProperty(source, parentObject, key, value);
  }
  writeTextAtomic(path, updated);
}

function writeTextAtomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, value, "utf-8");
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function logInstalled(label: string, target: string): void {
  p.log.success(`${label} → wired into ${target}`);
}

export function logAlreadyWired(label: string, target: string): void {
  p.log.info(`${label} already wired in ${target} (use --force to re-install)`);
}

export function logBackup(target: string): void {
  p.log.info(`Backup: ${target}`);
}
