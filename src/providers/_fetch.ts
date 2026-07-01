import { getEnvVar } from "../config.js";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const parsed =
    timeoutMs ??
    Number.parseInt(getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS") ?? "60000", 10);
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;

  const ctl = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, ctl.signal])
    : ctl.signal;
  // fetch() resolves once headers arrive, so clearing the timer there leaves
  // the caller's response.json()/text() body read unbounded: a backend that
  // stalls the body hangs the read forever. Keep the abort armed until the
  // body stream settles, and unref the timer so an unread body can't pin the
  // event loop.
  const t = setTimeout(() => ctl.abort(), ms);
  (t as { unref?: () => void }).unref?.();

  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (err) {
    clearTimeout(t);
    throw err;
  }

  const source = response.body;
  if (!source) {
    clearTimeout(t);
    return response;
  }

  // Pass the body through unchanged (streaming callers still stream) and
  // disarm the timeout once the body finishes. Until then the abort covers
  // the body read; a stalled body is aborted instead of hanging.
  const timed = source.pipeThrough(
    new TransformStream({
      flush() {
        clearTimeout(t);
      },
    }),
  );
  return new Response(timed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
