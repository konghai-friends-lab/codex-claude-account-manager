---
title: "Claude Code Usage Display - Plan"
type: feat
date: 2026-08-05
topic: claude-code-usage-display
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Claude Code Usage Display - Plan

## Goal Capsule

- **Objective:** Let a VS Code user see **Claude Code 的 5h / 7d 剩余用量** in the existing multi-product strip, replacing the current hardcoded `CC 暂不可用` placeholder with real data from the machine's current CC login.
- **Product authority:** Product Contract below (from `ce-brainstorm`). This plan owns **read-only display of the current machine's logged-in Claude Code usage**. It does **not** own CC credential storage, CC account switching, auto-switch participation, or spend/credit display.
- **Execution profile:** Standard feature. Mirrors the existing Grok precedent (`grokAuth.ts` + `grokQuotaClient.ts`): read-only auth parse, isolated non-stable HTTP client, fail-soft placeholder. The CC display slot already exists throughout the UI — this fills it rather than carving new surface.
- **Open blockers:** None. One unverified assumption carried into implementation (A1: non-macOS credential fallback path) — it fails soft by design, so it does not block.
- **Product Contract preservation:** Product Contract unchanged. This enrichment added only the Planning Contract, Implementation Units, Verification Contract, and Definition of Done.
- **Stop conditions:** Stop if no honest remaining % can be derived — ship the placeholder path and document the gap rather than displaying a fabricated `0%` or `100%`.
- **Tail ownership:** Implementer runs `npm run compile` and `npm test`; never commit real credentials, tokens, or `.credentials.json` fixtures.

---

## Product Contract

### Summary

Fill the already-scaffolded **CC slot** in the extension's multi-product remaining strip with real Claude Code usage. CC follows the **Grok model, not the Codex model**: single current-machine login, read-only, no credential storage and no account switching. The status bar shows **7d only** (matching Codex's existing treatment); **both 5h and 7d** appear in the tooltip and bottom panel.

### Problem

The CC slot is currently a hardcoded placeholder in four places — `formatClaudeCodeCompactPlaceholder()` returns a fixed `CC 5h — · CC 7d —` string (`src/accountPresentation.ts:198`), the status bar chip passes `unavailable=true` unconditionally (`src/accountPresentation.ts:240`), the tooltip hardcodes `CC 5h 暂不可用 · CC 7d 暂不可用` (`src/statusBar.ts`), and the bottom panel prints `Claude Code 5h / 7d 暂未接入` (`src/bottomPanel.ts:358-359`).

A user who wants to know their CC headroom must read it from the CC statusline inside a CC session. It is not visible alongside Codex and Grok, which is the whole point of the strip.

### Primary actor

A developer running Claude Code, Codex, and Grok on one machine, who wants one place to see remaining headroom across all three before deciding which tool to reach for.

### Requirements

**R1 — Read the current machine's CC credentials, read-only.**
Resolve the CC OAuth access token without ever writing it back or placing it in `SecretStorage`. Two-step resolution:
1. **macOS primary (verified):** macOS Keychain, generic password with service `Claude Code-credentials`; the JSON payload's `claudeAiOauth.accessToken`.
2. **Fallback (assumption A1):** `~/.claude/.credentials.json`, same `claudeAiOauth.accessToken` shape.
3. Neither available → treat as **未登录**, render placeholder.

**R2 — Fetch 5h and 7d usage from the CC usage endpoint.**
`GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`.

**R3 — Parse only the two windows this feature displays.**
Read `five_hour` and `seven_day`, each contributing `utilization` (a **used** percent) and `resets_at` (absolute ISO timestamp). Available percent is `100 - utilization`, matching the existing Grok convention. Do **not** parse or depend on `spend`, `extra_usage`, `limits[]`, or the obfuscated codename fields — see D3.

**R4 — Status bar shows 7d only.**
The CC chip renders the 7d remaining percentage, keeping the strip at three segments. This matches how Codex is already handled (7d in the bar, 5h in detail views).

**R5 — Tooltip and bottom panel show both windows.**
Both surfaces show 5h and 7d remaining, plus reset countdown and last-update time, consistent with the existing Codex and Grok blocks.

**R6 — Compute reset countdown from the absolute timestamp.**
Store `resets_at` as an absolute ISO time and derive the countdown at render time. Do not freeze a `resetAfterSeconds` at fetch time — this is the exact defect corrected in the Grok work (`GrokPeriodSnapshot.periodEndAt`, and `getGrokResetAfterSeconds`).

**R7 — Fail soft, always.**
Any failure — not logged in, HTTP error, timeout, malformed JSON, unparseable shape — writes a placeholder snapshot carrying a short reason. CC failures must never interrupt the Codex refresh path or throw. Refresh runs in parallel with Grok, and the parallel branch must be joined in `finally` so an exception path cannot leave stale CC UI (the defect corrected in Grok review #4).

**R8 — Never log or expose token material.**
No token in error strings, logs, test fixtures, or committed files. Stated as enforceable sinks rather than a bare prohibition, because the CC path introduces a child process and an async loader that the Grok precedent does not have:

- The token is never passed to `outputChannel.appendLine` (`src/manager.ts:213,475`) or any `console.*`.
- `claudeAuth.ts` catches all errors internally and returns `null`; it never rethrows an error whose `.message` could embed a stdout fragment.
- Child-process stderr is captured and discarded, never surfaced or logged.
- The `Authorization` header value never appears in any error. HTTP errors carry only `statusCode` plus a truncated body snippet — read buffer capped at 2048 bytes, whitespace collapsed, snippet sliced to 120 characters, exactly as `GrokBillingHttpError` does (`src/grokQuotaClient.ts:49,305-311`).
- Test fixtures use an obviously synthetic sentinel token so a reviewer can tell at a glance that no real credential was committed.

**R9 — The token is read fresh each refresh and never cached.**
`loadClaudeAuth()` is called once per refresh cycle and its result is passed to a per-refresh client instance — never stored on the manager, never held across cycles. This mirrors `refreshGrokPeriodRemaining` constructing its client per call, keeps the in-memory lifetime as short as the work requires, and makes a CC logout take effect on the next refresh instead of persisting until reload.

### Non-goals

- Storing CC credentials, in `SecretStorage` or anywhere else.
- CC account switching, import/export, or multi-account management.
- CC participation in auto-switch (`autoSwitchPriority` and friends stay Codex-only).
- Displaying `spend`, `extra_usage`, credit balances, or per-model scoped limits.
- Refreshing an expired CC OAuth token — an expired token renders as a placeholder.
- Windows/Linux runtime verification (see A1).

### Key decisions

- **D1 — Single current-machine login, mirroring Grok, not Codex.** *(session-settled)* CC is read-only display. This keeps the change away from the credential-write, token-refresh, and switching machinery, which AGENTS.md classifies as high-risk. **Why:** the user's goal is visibility, not account management; multi-account CC would be a materially larger and riskier change and belongs in its own cycle if ever wanted.
- **D2 — Status bar shows 7d only; both windows in detail views.** *(session-settled)* Keeps the strip at three segments and stays symmetric with Codex's existing treatment. **Why:** a fourth segment widens the bar, and asymmetry with Codex would make the strip harder to read at a glance.
- **D3 — Parse only `five_hour` and `seven_day`.** The live response also carries `spend`, `extra_usage`, `limits[]`, and clearly-internal codename fields (`tangelo`, `iguana_necktie`, `nimbus_quill`, …). Depending on any of these widens the blast radius of an upstream change. **Why:** this is an undocumented non-stable integration; AGENTS.md requires isolating such assumptions and keeping the parsed surface minimal.
- **D4 — macOS Keychain primary with file fallback.** *(session-settled)* Keychain is where credentials actually live on the user's machine (verified); the file path is the documented location on other platforms.

  **Security posture (stated explicitly because this reads another application's credential store):** the extension reads exactly **one** named Keychain item — `Claude Code-credentials`, created by the Claude Code CLI — on the user's own machine, read-only, and transmits the token **only** to the Anthropic endpoint that issued it. Never to another host, never to disk, never to another process. Broadening the read to other Keychain services or credential stores is out of scope and requires its own review. AGENTS.md classifies credential-touching changes as high-risk, so this boundary is recorded rather than left to be re-derived by a future reviewer.
- **D5 — Reuse `QuotaWindow`; add a two-window snapshot type.** CC needs two windows where Grok has one, so it gets its own snapshot type rather than reusing `GrokPeriodSnapshot` or overloading `QuotaSnapshot` (which is bound to the Codex multi-account store).

### Assumptions

- **A1 — `~/.claude/.credentials.json` fallback is UNVERIFIED.** The user's machine stores credentials in the macOS Keychain; no `.credentials.json` exists locally, so the fallback path could not be exercised. The `claudeAiOauth.accessToken` shape is assumed identical to the Keychain payload, which *was* verified. Implementation must make this path fail soft to the placeholder, and a Windows/Linux user should confirm before that support is advertised in the README.
- **A2 — `/api/oauth/usage` is a non-public, non-stable endpoint.** Verified returning `200` with the expected shape on 2026-08-05, but it carries no compatibility guarantee. Treat exactly as AGENTS.md directs for external unstable integrations: isolate the assumption in one module and surface actionable errors on shape change.
- **A3 — `utilization` is a used-percent on a 0–100 scale.** Observed values (`five_hour: 7.0`, `seven_day: 3.0`) against a lightly-used account are consistent with this and with the CC statusline's own `used_percentage` naming. The Grok parser already defends the ambiguous 0–1 vs 0–100 case in `coerceUsagePercent`; reusing that defense is cheap insurance.

### Acceptance examples

- **AE1 — Logged in, healthy.** CC logged in on macOS, usage endpoint returns `five_hour.utilization: 7.0`, `seven_day.utilization: 3.0`. Status bar shows the CC chip as a **bare** `🟩97%` (7d, no product label — matching the existing `⬜— · 🟩77% · 🟨44%` strip form). Tooltip and panel show the **labeled** `CC 5h 🟩93% · CC 7d 🟩97%` with reset countdowns for both. The two forms are different renderers; do not use the labeled form in the status bar.
- **AE2 — Not logged in.** No Keychain entry and no `.credentials.json`. Status bar CC chip shows `⬜—`; tooltip and panel show a `CC 未登录` placeholder. Codex and Grok segments render normally.
- **AE3 — Token expired / rejected.** Endpoint returns 401. CC renders a placeholder with a short auth-failure reason; no token material appears in the message; the Codex refresh completes unaffected.
- **AE4 — Endpoint shape changes.** Response is valid JSON but `five_hour` is absent. CC renders a placeholder citing a parse failure rather than displaying `0%` or `100%`.
- **AE5 — Reset countdown stays live.** After a snapshot is fetched, the displayed countdown continues to decrease on subsequent renders without a refetch, because it is computed from `resets_at`.
- **AE6 — CC failure does not break the strip.** The CC fetch times out. Codex and Grok segments still render current data, and the CC segment shows a placeholder.

### How this work fits together

The extension's status strip is designed as **CC · Codex · Grok**, and that ordering is already implemented across the status bar, tooltip, and bottom panel. Codex is the multi-account product with switching and auto-switch; Grok and now CC are read-only single-login usage displays. This plan completes the third segment and brings the strip to its intended shape.

Deliberately left outside: CC multi-account management. If it is ever wanted, it is a separate, higher-risk cycle requiring credential write-back, OAuth refresh, and process restart — the machinery this plan avoids by design.

### Outstanding questions

- **OQ1 — Should CC usage refresh on the same `refreshIntervalMinutes` timer as Codex and Grok, or on its own cadence?** Defaulting to the shared timer is the simple answer and matches Grok; call it out if the endpoint proves rate-sensitive.
- **OQ2 — Should the README advertise Windows/Linux support before A1 is confirmed on real hardware?** Recommendation: describe CC support as macOS-verified and note the other platforms as untested until someone confirms.

---

## Planning Contract

### Approach

Mirror the Grok vertical end to end. CC gets its own read-only auth module and its own isolated quota client, then threads a single snapshot object through the same plumbing Grok already uses (`manager` field → `statusBar.update()` parameter → `QuotaDetailsPayload` field). No existing Codex or Grok behavior changes.

The work splits into a clean dependency chain: types → auth → client → presentation → wiring → tests. Units U1–U3 are pure and independently testable; U4 is pure presentation; U5 is the only unit touching VS Code API surface.

### Key technical decisions

- **KTD1 — Two-window snapshot type, not a reuse of `GrokPeriodSnapshot`.** *(session-settled: user-approved — chosen over reusing `GrokPeriodSnapshot`: CC has two windows where Grok has one, and `QuotaSnapshot` is bound to the Codex multi-account store.)* Add:

  ```ts
  ClaudeUsageSnapshot {
    fiveHour?: QuotaWindow;
    fiveHourResetAt?: string;   // absolute ISO; render-time countdown source
    sevenDay?: QuotaWindow;
    sevenDayResetAt?: string;   // absolute ISO
    fetchedAt: string;
    statusCode?: number;
    error?: string;
  }
  ```

  Reuses the existing `QuotaWindow` so every presentation helper (`getQuotaToneIcon`, `formatQuotaPercentage`, `buildQuotaBar`) works unchanged. **The two `*ResetAt` sibling fields are load-bearing, not decorative:** `QuotaWindow` carries only a `resetAfterSeconds` number, so without an absolute timestamp beside it there is nowhere to recompute a live countdown from, and R6 / AE5 become unimplementable. This mirrors `GrokPeriodSnapshot.periodEndAt` (`src/types.ts:42-46`) exactly. Governs R3, R5, R6.
- **KTD2 — Do NOT classify windows by duration.** The `docs/solutions/` learning on `/wham/usage` prescribes duration-based classification because Codex's `primary_window` / `secondary_window` slots are semantically ambiguous. **CC's fields are explicitly named `five_hour` and `seven_day`, so that ambiguity does not exist.** Read them directly by name. Porting the duration-classification logic here would add a failure mode rather than prevent one. Governs R3.
- **KTD3 — Credential read is async and shells out on macOS.** `security find-generic-password -s "Claude Code-credentials" -w` returns the JSON payload on stdout. Unlike `grokAuth`'s synchronous `readFileSync`, this requires a child process, so the CC auth loader is `async`. The file fallback stays synchronous internally but the exported function is uniformly async. Invocation shape is pinned, mirroring `src/auth.ts:83`:
  - `execFile` with the arguments as a **literal array** — never a shell string.
  - `{ encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true }`. The timeout is mandatory: this call sits on the refresh path, and a Keychain authorization prompt would otherwise block it indefinitely (see Risks).
  - `stdio` stderr captured but discarded; the `catch` block **discards the error object entirely** and returns `null` rather than formatting `error.message`, because Node embeds captured child output there.
  - Command injection is not a vector here — every argument is a static literal. The binding constraint is that they *stay* static: never interpolate user, workspace, or config input into the args array.

  Governs R1, R8.
- **KTD4 — Failure overwrites the snapshot with a placeholder; no stale-value retention.** *(session-settled: user-directed — chosen over retaining the last good value with a staleness marker: a retained number renders identically to a live one, and the `docs/solutions/` learning warns specifically against display states that imply real data.)* Governs R7.
- **KTD5 — Reuse the Grok HTTP hardening verbatim.** Response size cap, `settled` guard against double-resolve, timeout with `request.destroy()`, and error-body truncation to a short snippet are all carried over from `grokQuotaClient.ts` rather than reinvented. Governs R2, R7, R8.
- **KTD7 — Do NOT port Grok's `coerceUsagePercent` 0–1 fraction heuristic.** That helper (`src/grokQuotaClient.ts:114`) scales any value in `[0, 1]` by 100. Grok needs it because its billing payload genuinely varies. CC does not: A3 verified the scale is 0–100. Applying the heuristic here **corrupts legitimate low-usage values** — a real `utilization: 0.5` (0.5% used) would render as 50% used, and `utilization: 1.0` would render as **0% available**, exactly the fabricated `0%` the Stop condition forbids. It misfires precisely when the account is healthiest, which is also the state the live verification observed (`7.0` / `3.0` — one idle day from the corrupting range). The helper is also module-private, so "reusing" it would mean either exporting it (widening Grok's surface, against KTD6) or copying it. Parse a plain 0–100 number and clamp. If a future scale change needs defending against, key it off an explicit signal, never a per-value range test. Governs R3.
- **KTD6 — Grok credential loading is left untouched.** *(session-settled: user-directed — chosen over extracting a shared Keychain/file credential layer: Grok works today and has no known defect; refactoring a working path for DRY would add regression risk for no user-facing gain.)* Some duplication between `grokAuth.ts` and `claudeAuth.ts` is accepted.

### Assumptions carried into implementation

Product-level assumptions A1–A3 are stated in the Product Contract. Implementation-specific:

- The `security` binary is present on macOS (part of the base OS; safe to assume).
- The Keychain payload's top-level key is `claudeAiOauth` in both the Keychain and file forms. Verified for Keychain; assumed for the file fallback per A1.
- **`expiresAt` is epoch milliseconds as a `number`** — verified live (`1785935407201`), not assumed. The payload also carries `subscriptionType` (`"max"`) and `rateLimitTier` as strings.
- **Unverified:** whether `security find-generic-password` triggers an interactive Keychain authorization prompt when invoked from the VS Code extension host rather than the CC CLI that created the item. The two are different binaries, so a first-run prompt is plausible. KTD3's timeout makes this fail soft either way rather than hang; confirm during U5 manual verification.
- **Unverified:** whether all CC plan tiers return the same `five_hour` / `seven_day` keys. Verified for a `max` subscription. KTD2's read-by-name holds for the verified shape; other tiers degrade to the placeholder rather than to wrong data.

---

## Implementation Units

### U1. Add the CC usage snapshot type

- **Goal:** Define the shared shape CC data flows through.
- **Requirements:** R3, R5. Instantiates KTD1.
- **Dependencies:** none.
- **Files:** `src/types.ts`
- **Approach:** Add `ClaudeUsageSnapshot` (shape in KTD1) alongside `GrokPeriodSnapshot`, reusing `QuotaWindow` for both windows. Document that `fiveHour`/`sevenDay` are absent (not zeroed) when unavailable, and that the reset countdown must be recomputed at render time from the sibling absolute fields `fiveHourResetAt` / `sevenDayResetAt` — never from a frozen `QuotaWindow.resetAfterSeconds`. Mirror the doc-comment already on `GrokPeriodSnapshot.periodEndAt` (`src/types.ts:42-46`).
- **Patterns to follow:** `GrokPeriodSnapshot` in `src/types.ts`, including its doc-comment convention.
- **Test scenarios:** `Test expectation: none -- type-only declaration, no runtime behavior.`
- **Verification:** `npm run compile` succeeds.

### U2. Read CC credentials read-only

- **Goal:** Resolve the current machine's CC access token without ever writing it back.
- **Requirements:** R1, R8, R9. Instantiates KTD3, KTD6.
- **Dependencies:** none.
- **Files:** `src/claudeAuth.ts` (new), `test/claudeAuth.test.js` (new)
- **Approach:**
  1. Export `ClaudeAuthData { accessToken: string; subscriptionType?: string; expiresAt?: number }`. **`expiresAt` is epoch milliseconds as a `number`** — verified live: `1785935407201`. It is **not** an ISO string, so do **not** mirror `grokAuth`'s `Date.parse(record.expires_at)`; a `typeof value !== "string"` guard copied from there would silently ignore the field entirely. Accept a number (`> 1e11` → ms, else seconds, mirroring the disambiguation at `src/quotaClient.ts:221-223`) and tolerate an ISO string defensively.
  2. Export a pure `selectClaudeAuthFromParsed(parsed, nowMs)` that takes an already-parsed object and returns `ClaudeAuthData | null` — this is the unit-testable core, mirroring `selectGrokAuthFromParsed`. Note the shapes differ: Grok's file holds **multiple** identity keys needing selection, while CC's payload has a **single** `claudeAiOauth` object (verified: exactly one Keychain item for this service). So CC needs no candidate sorting — but `security` returns only the first match if a reinstall or second login ever produced duplicates, which would surface as a silently wrong account rather than a placeholder. Out of scope to solve; recorded so a future multi-account CC cycle knows to handle it.
  3. Export `async loadClaudeAuth()`: on macOS run `security find-generic-password -s "Claude Code-credentials" -w`; on other platforms, or if the command fails, read `~/.claude/.credentials.json`. Parse whichever succeeded and hand to the pure selector.
  4. Treat an `expiresAt` in the past as unusable → return `null` (surfaces as 未登录 rather than a doomed 401). This is an optimization to avoid a request known to fail, **not** an authorization decision — the endpoint's 401 stays authoritative. A skewed local clock therefore degrades to 未登录 rather than to wrong data. **Fail in the safe direction:** an `expiresAt` that cannot be interpreted (unexpected type or unit) is treated as **usable**, never as expired — a naming or unit surprise then costs one wasted request instead of a permanent, silent 未登录.
  5. Never throw, never log token material. All failures return `null`. See R8 for the specific sinks this forbids.
- **Patterns to follow:** `src/grokAuth.ts` — the exported-pure-selector-plus-thin-IO-wrapper split, and its "失败返回 null，不抛错、不记录令牌内容" contract.
- **Test scenarios:**
  - `selectClaudeAuthFromParsed` returns the token for a well-formed `claudeAiOauth` payload.
  - Returns `null` when `claudeAiOauth` is absent.
  - Returns `null` when `accessToken` is missing or empty.
  - Returns `null` when `expiresAt` (epoch **ms number**) is in the past (pass a fixed `nowMs`).
  - Returns the token when `expiresAt` is a future epoch-ms number.
  - Returns the token when `expiresAt` is absent entirely (treated as usable).
  - Returns the token when `expiresAt` has an unrecognized type — fails safe toward usable, never toward expired.
  - Returns `null` for non-object input — `null`, an array, a bare string.
  - A failed credential read produces no string anywhere containing the token (guards R8).
- **Verification:** Tests pass; fixtures use an obviously synthetic sentinel token, never a real credential.

### U3. Fetch and parse CC usage

- **Goal:** Turn the usage endpoint response into a `ClaudeUsageSnapshot`.
- **Requirements:** R2, R3, R6, R7, R8. Instantiates KTD2, KTD5, KTD7.
- **Dependencies:** U1, U2.
- **Files:** `src/claudeQuotaClient.ts` (new), `test/claudeQuotaClient.test.js` (new)
- **Approach:**
  1. Export `parseUsageResponseToSnapshot(data, fetchedAt, statusCode, nowMs)` as the pure, testable core.
  2. For each of `five_hour` and `seven_day`: read `utilization` as a **used** percent, derive `availablePercent = 100 - used`, and store `resets_at` **verbatim** into the matching `fiveHourResetAt` / `sevenDayResetAt` field. Do **not** freeze a countdown at fetch time (R6) — `resetAfterSeconds` may be populated as a fallback for callers that lack the absolute value, but the absolute ISO string is the source of truth that render-time helpers recompute from. Read the two windows **by name** — see KTD2.
  3. Parse `utilization` as a plain 0–100 number and clamp to `[0, 100]`. **Do NOT port Grok's `coerceUsagePercent` fraction heuristic** — see KTD7. Omit the window if `utilization` is not a finite number.
  4. Set `windowMinutes` to the constant the field name implies — `fiveHour` → 300, `sevenDay` → 10080. The endpoint returns no period start, so it cannot be derived the way `parseBillingConfigToSnapshot` does; KTD2 already establishes the names are authoritative. This completes the available-% / window-length / reset trio the `docs/solutions/` learning requires tests to assert together.
  5. A window whose `utilization` is unparseable is **omitted**, never defaulted to 0 or 100 — per the same learning: a zeroed window renders as a real empty bar.
  6. If neither window parses, return a snapshot carrying only `error`.
  7. `ClaudeUsageHttpError` carries `statusCode`; the HTTP layer lives in an injectable `fetchUsage()` method so tests never hit the network. Follow the Grok precedent by parsing the raw body in the client method and passing the parsed object to the pure function.
  8. Set `User-Agent`, `Authorization: Bearer`, and `anthropic-beta: oauth-2025-04-20`. Keep the endpoint URL a module constant — never configurable — so no setting can redirect the token to another host.
- **Patterns to follow:** `src/grokQuotaClient.ts` end to end — `GrokBillingHttpError`, the `settled` double-resolve guard, `MAX_RESPONSE_BODY_BYTES`, timeout handling, and truncating error bodies to a short snippet before surfacing.
- **Test scenarios:**
  - Full well-formed response → both windows present; assert `availablePercent`, `windowMinutes` where derivable, and the stored absolute `fiveHourResetAt` / `sevenDayResetAt` together (assert the trio in one case, per the learning's Prevention note).
  - `resets_at` is stored verbatim as an ISO string, **not** converted to a frozen countdown (guards R6 against regression).
  - `utilization: 7.0` → `availablePercent` 93.
  - Only `five_hour` present → `sevenDay` is `undefined`, not a zeroed window.
  - `five_hour` absent, `seven_day` present → `fiveHour` is `undefined` with a parse reason recorded, never `0%` or `100%` (covers AE4).
  - Neither window parseable → snapshot has `error` and no windows.
  - `utilization: 0.5` → `availablePercent` **99.5, not 50** (guards KTD7 against a well-meaning re-introduction of the fraction heuristic).
  - `utilization: 1.0` → `availablePercent` **99, not 0**.
  - `utilization` above 100 or below 0 → clamped.
  - `utilization` non-finite or non-numeric → window omitted, never defaulted.
  - Missing or unparseable `resets_at` → window still present, `resetAfterSeconds` undefined.
  - Malformed JSON body → snapshot carries a parse error, does not throw.
  - HTTP 401 → `ClaudeUsageHttpError` with `statusCode` 401; message contains no token material.
  - Error-body snippet is truncated rather than embedded whole.
- **Verification:** Tests pass with no network access.

### U4. Render CC in the presentation layer

- **Goal:** Replace the hardcoded placeholder helpers with real formatting.
- **Requirements:** R4, R5, R7.
- **Dependencies:** U1.
- **Files:** `src/accountPresentation.ts`, `test/grokPresentation.test.js`
- **Approach:**
  1. Replace `formatClaudeCodeCompactPlaceholder()` with snapshot-aware helpers: a compact segment (`CC 5h 🟩93% · CC 7d 🟩97%`), a per-window progress line for tooltip/panel, a status-bar chip fed by the **7d** window only (R4), and a placeholder formatter mapping failure reasons to short suffixes (未登录 / 鉴权失败 / 超时 / —).
  2. Update `formatStatusBarQuotaLine` to accept the CC snapshot and stop hardcoding `unavailable=true` at `src/accountPresentation.ts:240`. Make the new CC parameter **optional** so U4 lands compile-clean before U5 wires the two `statusBar.ts` call sites.
  2b. Add `getClaudeResetAfterSeconds(snapshot, which, nowMs)` mirroring `getGrokResetAfterSeconds` (`src/accountPresentation.ts:279`): prefer the absolute `*ResetAt` field, fall back to the window's frozen `resetAfterSeconds`. This is the helper that makes R6 / AE5 real at render time.
  3. Missing windows render as an explicit 暂不可用 / `⬜—`, never a zero-filled bar.
  4. Keep the existing `.0%` trimming so `93.0%` renders as `93%`.
- **Patterns to follow:** `formatGrokCompactSegment`, `formatGrokPlaceholder`, `formatGrokCompactProgressChip`, and `formatGrokQuotaProgress` in the same file. Note the existing CC test imports already live in `test/grokPresentation.test.js`.
- **Test scenarios:**
  - Both windows present → compact segment shows both, `.0%` trimmed.
  - Status-bar chip reflects the **7d** window, not 5h (guards R4 against regression).
  - Snapshot with `error` and no windows → placeholder, not `0%`.
  - `undefined` snapshot → placeholder.
  - 未登录 / 鉴权失败 / 超时 reasons map to their short suffixes.
  - Only one window present → that window renders, the other shows 暂不可用.
  - `formatStatusBarQuotaLine` renders three chips in CC · Codex · Grok order with CC live.
  - `getClaudeResetAfterSeconds` returns **different** values for two different `nowMs` args against the same snapshot — this is the automated proof of AE5, which manual observation cannot reliably provide.
- **Verification:** Tests pass. **Two existing assertions must be rewritten, not preserved:** `test/grokPresentation.test.js:103-105` asserts the exact old placeholder string `"CC 5h — · CC 7d —"`, and `:125-141` asserts the exact strip `"⬜— · 🟩77% · 🟨44%"` with CC hardcoded unavailable. Both encode the placeholder behavior this unit removes. Existing **Grok and Codex** assertions stay unchanged.

### U5. Wire CC through manager, status bar, and panel

- **Goal:** Fetch CC on the refresh cycle and surface it in all three UI surfaces.
- **Requirements:** R4, R5, R7, R9. Instantiates KTD4.
- **Dependencies:** U2, U3, U4.
- **Files:** `src/manager.ts`, `src/statusBar.ts`, `src/bottomPanel.ts`
- **Approach:**
  1. `manager.ts`: add a `claudeSnapshot` field and a `refreshClaudeUsage()` mirroring `refreshGrokPeriodRemaining()` — never throws, writes a placeholder on any failure (KTD4).
  2. Start it alongside the Grok refresh in `refreshAllQuotas`, and **join it in the same `finally` block** so an exception path cannot leave stale CC UI. This is the defect corrected in Grok review #4; CC must not reintroduce it.
  2b. **The join is necessary but not sufficient — the CC branch must also be self-bounding.** The `finally` join guarantees the promise is awaited before `refreshing = false`, but does not bound how long that takes, and it sits *before* the flag reset. Grok is safe here only incidentally: its auth read is a synchronous `readFileSync` and its client sets `request.setTimeout`. CC adds a **third** segment Grok has no analogue for — the child-process credential read — so "mirror Grok" does not transfer the safety property. Every CC segment must carry its own timeout (credential read 3s per KTD3; HTTP `requestTimeoutMs`), giving a known ceiling. Since `refreshing` gates re-entry, an unbounded CC branch would silently drop every subsequent timer tick and freeze Codex and Grok updates too — the exact interference R7 forbids.
  3. Thread the snapshot through **every** structure that carries `grokSnapshot` today — missing any one of these is a compile error or a panel that renders the placeholder forever:
     - the private `StatusBarRenderState` type and its initial value (`src/statusBar.ts:445-452`);
     - the `statusBar.update()` parameter list and each destructuring site (`renderQuotaItem`, `buildDetailsMarkdown`);
     - `QuotaDetailsPayload` (`src/bottomPanel.ts:21-29`);
     - **both** manager call sites — `refreshStatusBar()` (`src/manager.ts:505-513`) and `showQuotaDetails()` (`src/manager.ts:1070-1081`).
  4. `statusBar.ts`: replace the hardcoded tooltip line at `src/statusBar.ts:710` with a CC block matching `formatGrokTooltipBlock` — progress lines for both windows plus a detail line carrying reset countdown, last-update time, and a short failure reason. Update the `accessibilityInformation` label so it no longer describes CC as unavailable.
  5. `bottomPanel.ts`: replace the two hardcoded rows at `src/bottomPanel.ts:358-359` with real rows plus a `formatClaudeDetailMeta`. Model it on `formatCodexDetailMeta` (`src/bottomPanel.ts:467-470`), **not** `formatGrokDetailMeta` — the Codex one truncates its error string to 40 chars while the Grok row pushes it uncapped (`src/bottomPanel.ts:448`). CC surfaces a third-party response body, so it takes the capped form.
  6. Preserve the CC · Codex · Grok ordering already established in all three surfaces.
- **Patterns to follow:** `refreshGrokPeriodRemaining` (`src/manager.ts:517-536`), the `finally`-join at `src/manager.ts:2304-2311`, `formatGrokTooltipBlock` in `src/statusBar.ts`, `formatCodexDetailMeta` in `src/bottomPanel.ts`.
- **Execution note:** Extract the snapshot-producing core as a pure `buildClaudeSnapshot(authLoader, clientFactory, nowMs)` that `refreshClaudeUsage()` calls. KTD4 is a **write-ordering** property — "failure overwrites the snapshot" — which pure formatter tests in U2–U4 structurally cannot observe: they prove a placeholder *renders*, not that the failure path *writes* one. Extracting this core is what makes the plan's headline safety guarantee testable instead of merely asserted. Only the thin VS Code wiring around it stays manual.
- **Files (test):** `test/claudeSnapshot.test.js` (new)
- **Test scenarios:**
  - Auth loader returns `null` → snapshot has no windows and carries an error.
  - Auth loader throws → snapshot has no windows and carries an error (does not propagate).
  - Client throws `ClaudeUsageHttpError(401)` → snapshot carries the auth reason, no windows.
  - Client returns a windows-less error snapshot → passed through, never replaced with zeroed windows.
  - In every failure case above, assert `fiveHour` and `sevenDay` are `undefined` — never `0`.
- **Verification:** In the Extension Development Host: CC shows a live 7d chip in the status bar; tooltip and panel both show 5h and 7d with reset countdowns; with CC logged out, all three show placeholders while Codex and Grok still render normally.

### U6. Update user-facing docs

- **Goal:** Keep README and AGENTS.md consistent with shipped behavior.
- **Requirements:** none directly; resolves OQ2 and documents A1.
- **Dependencies:** U5.
- **Files:** `README.md`, `AGENTS.md`
- **Approach:** Document CC 5h/7d display as a feature. State that CC support is **macOS-verified**; note other platforms as untested pending A1. Note in the README that the extension reads the local Claude Code login from the Keychain, so a user who sees a Keychain prompt can attribute it correctly. Add `claudeAuth.ts` and `claudeQuotaClient.ts` to the AGENTS.md module table, marking the client as an external non-stable integration alongside the Grok entry.
- **Patterns to follow:** the existing Grok rows in the AGENTS.md module table.
- **Test scenarios:** `Test expectation: none -- documentation only.`
- **Verification:** Module table lists both new files; README does not claim unverified cross-platform support.

---

## Verification Contract

- `npm run compile` — clean TypeScript build, strict mode.
- `npm test` — compiles, then runs `node --test test/*.test.js`. All new and existing tests pass.
- Manual (Extension Development Host, `F5`), covering the Product Contract's acceptance examples:
  - **AE1** logged in → CC 7d chip live in the bar; both windows in tooltip and panel.
  - **AE2** logged out → placeholders everywhere; Codex and Grok unaffected.
  - **AE3** expired token → placeholder with a short auth-failure reason; no token material shown.
  - **AE6** CC failure leaves Codex and Grok segments rendering normally — exercise **both** paths: a hung credential read (bounded by KTD3's timeout) and an HTTP timeout.

  **AE4 and AE5 are automated, not manual.** AE4 (malformed shape → placeholder, never `0%`/`100%`) cannot be reproduced by hand since it needs the live endpoint to misbehave; it is a pure-parse case covered in U3. AE5 (live countdown) is unreliable to observe by hand because renders are event-driven, not timer-driven — it is proven by the `getClaudeResetAfterSeconds` two-`nowMs` test in U4. In the running extension the countdown visibly updates whenever a render is triggered (panel reopen, manual refresh, status-bar update).
- Security check: no token, credential, or `auth.json` content in any fixture, log, commit, or error string.

## Definition of Done

- CC 5h and 7d remaining are visible in status bar (7d), tooltip, and bottom panel (both).
- Every failure mode renders an explicit placeholder — never a fabricated `0%` or `100%`, and never a zero-filled bar for a missing window.
- CC failures never interrupt the Codex refresh path: the parallel refresh is joined in `finally` **and** every CC segment is individually timeout-bounded, so the branch cannot extend the refresh window or hold the re-entrancy flag.
- No CC credential is stored, written back, or placed in `SecretStorage`.
- `npm run compile` and `npm test` both pass.
- README and AGENTS.md reflect the shipped scope, with cross-platform support described honestly per A1.

---

## Risks

- **The usage endpoint is undocumented and may change without notice (A2).** Mitigated by parsing only two named fields, isolating all shape assumptions in `claudeQuotaClient.ts`, and failing soft to a placeholder. A shape change degrades the CC segment; it cannot break Codex or Grok.
- **A single transient CC failure blanks the chip for a full refresh interval.** This is KTD4 working as chosen, not a bug: unlike Codex quota (persisted per-account via the store), the CC snapshot is an in-memory field overwritten wholesale each cycle, so one 429 or dropped connection shows `⬜—` until the next tick (default 5 min). Recorded here so it is not later reported as a defect. If it proves annoying in practice, a single bounded in-cycle retry for **network-class errors only** — never 401/403/parse failures, which are not transient — would address it without touching KTD4's semantics.
- **The non-macOS credential path is unverified (A1).** Mitigated because the fallback fails soft to 未登录 rather than erroring, and U6 documents the limitation instead of over-claiming.
- **`security` prompting for Keychain access could stall the refresh path.** The command reads an existing generic-password item the CC CLI already created, so it normally returns instantly. But if a system policy triggers an interactive authorization prompt, the child process blocks until the user answers — and because U5 joins the CC refresh in `refreshAllQuotas`'s `finally`, a blocked child would hold `refreshing = true` and spin the status bar indefinitely. That would make a CC failure break the strip, contradicting R7 and AE6. **Mitigated by the mandatory 3s `execFile` timeout in KTD3**, which kills the child and degrades to 未登录 — not by assuming the prompt never fires. Confirm during U5 manual verification.

## Open questions

- **OQ1 — Refresh cadence.** Deferred to implementation: default to the shared `refreshIntervalMinutes` timer alongside Codex and Grok. Revisit only if the endpoint proves rate-sensitive.
- **OQ2 — Cross-platform claims in README.** Resolved by U6: describe CC as macOS-verified, other platforms untested.

---

## Sources & Research

Verified against the working tree at `256f8ac` on 2026-08-05:

- `src/accountPresentation.ts:198` — `formatClaudeCodeCompactPlaceholder()`, the fixed placeholder string.
- `src/accountPresentation.ts:234-246` — `formatStatusBarQuotaLine()`, where the CC chip is hardcoded `unavailable`.
- `src/statusBar.ts:710` — `buildDetailsTooltip()`, hardcoded `CC 5h 暂不可用 · CC 7d 暂不可用` line.
- `src/bottomPanel.ts:358-359` — panel CC rows.
- `src/grokAuth.ts` — read-only auth parse precedent to mirror.
- `src/grokQuotaClient.ts` — isolated non-stable HTTP client precedent, including size caps, timeout handling, and error-body truncation.
- `src/manager.ts:517-536` — `refreshGrokPeriodRemaining`, the fail-soft refresh precedent.
- `src/manager.ts:2239-2311` — parallel refresh and the `finally`-join pattern R7 requires.
- `docs/solutions/integration-issues/classify-wham-quota-windows-by-duration.md` — institutional learning. Its Prevention rules directly constrain U3 and U4: never render a missing window as an empty bar, and assert available %, window length, and reset seconds together in tests. Its duration-classification *solution* is deliberately **not** ported — see KTD2.
- Live endpoint verification (2026-08-05): `GET https://api.anthropic.com/api/oauth/usage` returned `200` with `five_hour.utilization`, `seven_day.utilization`, and `resets_at` on both. macOS Keychain item `Claude Code-credentials` confirmed to carry `claudeAiOauth.accessToken`. No rate-limit data is cached anywhere under `~/.claude/`.
