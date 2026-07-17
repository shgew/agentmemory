import type { CommitLink } from "./types.js";

export function sanitizeCommitRepository(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value
      .replace(/^((?:[a-z][a-z\d+.-]*:\/\/)?)[^@/\s]+@/i, "$1")
      .replace(/[?#][\s\S]*$/, "");
  }
}

export function projectCommitLink(commit: CommitLink): CommitLink {
  if (!commit.repo) return commit;
  const repo = sanitizeCommitRepository(commit.repo);
  return repo === commit.repo ? commit : { ...commit, repo };
}
