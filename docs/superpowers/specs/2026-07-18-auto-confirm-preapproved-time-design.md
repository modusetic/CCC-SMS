# Auto-Confirm on Pre-Approved Exact Time

## Goal

Reduce unnecessary back-and-forth when an organizer has already unambiguously named one specific meeting time, and the contact then agrees to that exact time. Today the system always sends the organizer a second "Reply YES to confirm" message in this situation, even though they already committed to that time. This should be skipped — but narrowly, so we don't reintroduce the bug that made the final-confirmation step necessary in the first place.

## Background

Commit `6255af3` ("require explicit organizer final confirmation before any meeting is set") made the final organizer sign-off mandatory because *ambiguous* organizer availability statements (e.g. "I can until 6pm") were being misread as approval of specific times the organizer never actually confirmed. Any redesign here must not regress that fix — auto-confirmation is only safe when the organizer's approval was unambiguous.

## Behavior

**Trigger rule:** skip the final organizer confirmation only when the contact confirms a time that exactly matches a single, unambiguous time the organizer already named. Multiple options, ranges, or vague statements never qualify and always fall back to today's behavior (ask the organizer to confirm).

**Scope:** the rule applies at all three points where an organizer can pre-approve availability before the contact confirms:
1. Backup times (`directorAlternatives`) submitted at `/api/initiate` — qualifies only if exactly one backup time was given.
2. The organizer's initial review of the proposed times (`waiting_organizer_initial` → `handleOrganizerInitialReview`).
3. A later unsolicited organizer availability update (`handleOrganizerReply`'s non-approval branch).

It does not change the counter-proposal approval flow (`getOrganizerApprovalDecision`) — that path already finalizes immediately on organizer approval and isn't part of the redundant round-trip problem.

**Toggle:** a single settings switch, `autoConfirmPreApprovedTimes` (boolean, default `true`), controls this behavior globally. When off, all flows behave exactly as they do today.

## Data Model

New thread field: `organizerPreApprovedTime` (`string | null`). Plain-language text of the one exact time the organizer has most recently and unambiguously authorized.

- Set at `/api/initiate` when `directorAlternatives.length === 1`, to `directorAlternatives[0]`.
- Set/overwritten in `handleOrganizerInitialReview` and in the unsolicited-update branch of `handleOrganizerReply`, based on a new structured field returned by the relevant Gemini call (see below). If that call reports no single unambiguous time, the field is explicitly set to `null` — a new organizer message always supersedes whatever was there before, it never leaves a stale value in place.
- Not touched by the counter-proposal approval flow (out of scope, see above).
- Not needed after a thread reaches `confirmed` (terminal state).

## Gemini Changes (`lib/gemini.js`)

`getOrganizerInitialContactMessage` and `getOrganizerUpdateReply` change from returning plain text to returning structured JSON: `{ "contactMessage": "<sms text, same as today's return value>", "exactApprovedTime": "<plain-language time, or null>" }`. `exactApprovedTime` is populated only when the organizer's reply unambiguously resolves to exactly one specific time — the prompt must instruct the model to leave it `null` for anything else (multiple times offered, a range, a vague or partial answer), matching the same conservative standard as the original bug fix.

`getNextReply`'s system prompt gains a new context line when `thread.organizerPreApprovedTime` is set: something to the effect of "The organizer has already explicitly confirmed availability for exactly this time: `<organizerPreApprovedTime>`. If the contact agrees to this exact time, include `"matchesOrganizerPreApproval": true` in your confirmed-status response." The existing confirmed-status JSON shape gains this optional boolean field (defaults to absent/false when not applicable).

## Flow Changes (`api/sms-reply.js`)

In `handleContactReply`, the existing `parsed?.status === 'confirmed'` branch currently always sets `waitingForOrganizerApproval = true` whenever `thread.organizerPhone` exists. This becomes conditional:

- If `settings.autoConfirmPreApprovedTimes && parsed.matchesOrganizerPreApproval`: skip the approval hold entirely. Set `status = 'confirmed'`, book the calendar event, email the organizer, send the contact their confirmation message (existing `confirmationMessage` template), and send the organizer a short FYI SMS (new copy, e.g. "{contactName} confirmed {time} — already booked per your earlier OK, no action needed!") rather than a "Reply YES" request.
- Otherwise: unchanged — existing `waitingForOrganizerApproval` hold-and-ask flow.

`handleOrganizerInitialReview` and the unsolicited-update branch of `handleOrganizerReply` are updated to parse the new structured Gemini response, use `contactMessage` where they previously used the raw text, and set `thread.organizerPreApprovedTime` from `exactApprovedTime` (including explicitly clearing it to `null` when absent).

`api/initiate.js` sets `thread.organizerPreApprovedTime = directorAlternatives[0]` when `directorAlternatives.length === 1`, else `null`.

## Settings (`lib/settings.js`, `api/settings.js`, `public/index.html`)

Add `autoConfirmPreApprovedTimes: true` to `DEFAULTS` and `RULES` (boolean type, matching the existing `demoMode` pattern). Add one checkbox to the settings panel's "AI Behavior" section, labeled something like "Skip final organizer confirmation when they already named an exact time," mirroring the existing `demoMode` checkbox's markup/wiring (`loadSettings`/`saveSettings` already generalize over the settings object).

## Error Handling

- If Gemini's structured response fails to parse (same risk as existing `extractJson` usage elsewhere), fall back to the plain-text-only behavior: treat `exactApprovedTime`/`matchesOrganizerPreApproval` as absent and take the existing (safe) always-ask path. Never fail open into auto-confirming on a parse error.
- `organizerPreApprovedTime` is plain conversational text with no format validation — it's only ever read back by Gemini as prompt context, never parsed programmatically, so malformed or unusual phrasing just degrades to "no match" rather than erroring.

## Testing

- `tests/lib/gemini.test.js`: `getOrganizerInitialContactMessage` and `getOrganizerUpdateReply` return `exactApprovedTime` populated for an unambiguous single-time reply, and `null` for multiple times / vague replies; `getNextReply` includes `matchesOrganizerPreApproval: true` in its parsed output when the system prompt context signals a match, and omits/false otherwise.
- `tests/api/initiate.test.js`: `organizerPreApprovedTime` set when exactly one backup time is given, `null` when zero or multiple.
- `tests/api/sms-reply.test.js`: contact confirming a pre-approved exact time with the setting on skips `waitingForOrganizerApproval` and books immediately; the same scenario with the setting off falls back to today's ask-again behavior; an ambiguous organizer reply (multiple times / vague) never triggers auto-confirm regardless of the setting.
- `tests/lib/settings.test.js` / `tests/api/settings.test.js`: new field's default, validation, and persistence.
