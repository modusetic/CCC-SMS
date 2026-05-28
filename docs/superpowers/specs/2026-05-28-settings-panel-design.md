# Settings Panel Design

## Goal

Allow global AI prompt behavior and SMS template texts to be edited through a slide-in settings panel in the scheduling UI, without touching code — so values can be adjusted for client demos or handoffs.

## Architecture

Three new units plus changes to four existing files:

- **`lib/settings.js`** (new) — Redis read/write with hardcoded defaults; single source of truth for the settings schema
- **`api/settings.js`** (new) — `GET /api/settings` and `POST /api/settings` endpoints
- **`lib/gemini.js`** (modified) — all prompt-building functions accept a `settings` object
- **`api/sms-reply.js`** (modified) — loads settings once per request, passes to Gemini functions and substitutes SMS templates
- **`public/index.html`** (modified) — adds ⚙ button, slide-in panel, fetch/save logic

## Settings Schema

Stored in Redis under the key `global:settings` as a JSON string. All fields are optional at the Redis layer — `getSettings()` merges the stored value over the defaults below.

```json
{
  "assistantName": "Alex",
  "tone": "Be conversational and polite.",
  "maxMessageLength": 160,
  "maxExchanges": 6,
  "holdingMessage": "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
  "confirmationMessage": "Your meeting with {organizerName} is confirmed! You'll receive details soon."
}
```

**Template placeholders** available in `holdingMessage` and `confirmationMessage`: `{contactName}`, `{organizerName}`. Replaced at send time in `api/sms-reply.js`.

**Validation rules** enforced by `POST /api/settings`:
- `assistantName`: string, 1–40 chars
- `tone`: string, 1–300 chars
- `maxMessageLength`: integer, 50–320
- `maxExchanges`: integer, 2–20
- `holdingMessage`: string, 1–320 chars
- `confirmationMessage`: string, 1–320 chars

Unknown keys are stripped; missing keys fall back to defaults.

## `lib/settings.js`

```
getSettings() → Promise<SettingsObject>   reads Redis global:settings, merges over DEFAULTS
saveSettings(partial) → Promise<SettingsObject>   validates, saves merged object, returns saved
```

No caching — Redis is in-memory and the call volume is low (one read per inbound SMS).

## `api/settings.js`

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | /api/settings | Returns current settings (defaults if key absent) |
| POST | /api/settings | Validates body, calls `saveSettings`, returns saved object. 400 on invalid fields. |

No authentication — consistent with the rest of the app.

## Gemini Integration

`api/sms-reply.js` calls `getSettings()` once at the top of the request handler and passes the result to Gemini functions.

Changes to `lib/gemini.js`:

- `buildSystemPrompt(organizerName, contactName, directorAlternatives, timezone, settings)` — substitutes `settings.assistantName`, `settings.tone`, `settings.maxMessageLength`, `settings.maxExchanges` in place of hardcoded values
- `getOrganizerInitialContactMessage(..., settings)` — uses `settings.assistantName` and `settings.maxMessageLength` in system instruction
- `getOrganizerApprovalDecision(..., settings)` — uses `settings.maxMessageLength` in system instruction
- `getOrganizerUpdateReply(..., settings)` — uses `settings.assistantName` and `settings.maxMessageLength` in system instruction

`getNextReply(thread, incomingMessage, settings)` passes `settings` through to `buildSystemPrompt`.

## SMS Template Integration

In `api/sms-reply.js`, a helper replaces placeholders at send time:

```js
function applyTemplate(template, { contactName, organizerName }) {
  return template
    .replace(/{contactName}/g, contactName)
    .replace(/{organizerName}/g, organizerName);
}
```

Two call sites replaced:
1. **Holding message** in `handleContactReply` (contact waiting for organizer initial review)
2. **Confirmation message** in `handleContactReply` (contact confirmed a time)

## Frontend

### ⚙ Button

Added to the existing page header (`h1` row in `public/index.html`). Styled to match the existing card aesthetic — small, unobtrusive.

### Slide-in Panel

- Fixed-position overlay: full viewport height, right-aligned, 360px wide
- Semi-transparent backdrop (`rgba(0,0,0,0.3)`) behind the panel
- CSS `transform: translateX(100%)` hidden → `translateX(0)` visible, animated with `transition: transform 0.25s ease`
- Close button (✕) in panel header; clicking backdrop also closes

### Panel Contents

**Section: AI Behavior**
- Assistant Name — `<input type="text">`
- Tone / Personality — `<textarea rows="3">` with hint: "Describe the assistant's voice, e.g. 'Be warm, concise, and professional.'"
- Max Message Length — `<input type="number" min="50" max="320">`
- Max Exchanges — `<input type="number" min="2" max="20">`

**Section: SMS Templates**
- Holding Message — `<textarea rows="3">` with hint: "Sent to the contact while waiting for the organizer to review. Supports {contactName} and {organizerName}."
- Confirmation Message — `<textarea rows="3">` with hint: "Sent to the contact when the meeting is confirmed. Supports {contactName} and {organizerName}."

**Save Settings button** — POSTs to `/api/settings`. On success: shows the existing toast ("Settings saved") and closes the panel. On error: shows error toast, panel stays open.

### Data Flow

1. Panel opens → `GET /api/settings` → fields populated
2. User edits fields → clicks Save → `POST /api/settings`
3. Next inbound SMS → `getSettings()` → new values used immediately (no restart needed)

## Error Handling

- `getSettings()` Redis error: logged, returns defaults (scheduling continues uninterrupted)
- `saveSettings()` Redis error: propagates to `POST /api/settings` → 500 response; panel shows error toast
- Invalid POST body: 400 with `{ error: '...' }` describing the first failing field
- Template placeholder typos (e.g. `{contactname}`): passed through as-is — no validation, user sees literal text in the SMS

## Testing

- `tests/lib/settings.test.js` — `getSettings` returns defaults when Redis key absent; `saveSettings` merges and persists; invalid fields rejected
- `tests/api/settings.test.js` — GET returns defaults; POST saves and returns; POST 400 on invalid fields
- `tests/api/sms-reply.test.js` — existing tests updated to mock `getSettings`; two new tests verify template substitution in holding message and confirmation message
- `tests/lib/gemini.test.js` — existing tests updated to pass a `settings` argument
