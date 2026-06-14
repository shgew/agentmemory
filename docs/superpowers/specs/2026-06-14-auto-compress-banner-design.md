# Auto-Compress Banner Design

## Goal

The viewer should stop presenting `AGENTMEMORY_AUTO_COMPRESS=false` as an alert. Auto-compress is intentionally off by default because enabling it spends LLM tokens on every observation. A deployment that leaves it disabled is healthy and should not show a warning.

## Current Behavior

The `/agentmemory/config/flags` endpoint returns all feature flags with an `enabled` boolean. The viewer renders a warning banner for every disabled flag that affects the current tab or dashboard.

This makes deliberate default-off settings look broken. In particular, `AGENTMEMORY_AUTO_COMPRESS=false` and unset both evaluate to disabled, so the viewer shows "LLM-powered observation compression" as an alert even though zero-LLM synthetic compression is the recommended safe default.

## Proposed Approach

Add explicit banner policy metadata to each config flag returned by `/agentmemory/config/flags`. The viewer will render disabled flags according to that policy instead of assuming every disabled flag is a warning.

Use this initial policy:

- `AGENTMEMORY_AUTO_COMPRESS`: disabled banner policy `none`
- existing flags without a policy: keep current warning behavior

This keeps the patch focused and upstream-friendly. The API owns the product meaning of a flag; the viewer only renders the policy it receives.

## Data Flow

1. `src/triggers/api.ts` builds the config flag list.
2. Each flag may include a `disabledBanner` value.
3. `src/viewer/index.html` checks disabled flags:
   - skip enabled flags
   - skip dismissed flags
   - skip disabled flags with `disabledBanner: "none"`
   - render disabled flags with `disabledBanner: "info"` as informational banners
   - render disabled flags with no policy, or `disabledBanner: "warn"`, as warnings

## Error Handling

The viewer should tolerate older backends or omitted metadata. Missing `disabledBanner` must preserve the existing warning behavior so this change is backward compatible.

Unknown `disabledBanner` values should also fall back to warnings, because a warning is safer than silently hiding a potentially important flag.

## Testing

Validate the patch with:

- source build or typecheck, if available in the local clone
- `docker compose -f agentmemory/compose.yaml config`
- rebuild the local image
- recreate the container only after explicit approval
- verify `/agentmemory/config/flags` still reports `AGENTMEMORY_AUTO_COMPRESS` as disabled
- verify the viewer no longer shows the auto-compress alert

## Scope

This patch does not enable LLM-powered observation compression, change runtime compression behavior, alter provider detection, or hide unrelated warnings.
