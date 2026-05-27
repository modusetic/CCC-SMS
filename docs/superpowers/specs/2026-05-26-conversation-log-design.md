# Conversation Log — Design Spec
**Date:** 2026-05-26  
**Status:** Approved

---

## Overview

Add a live SMS conversation log to the right of the scheduling form in `public/index.html`. After the form is submitted, two iOS-style phone mockups appear side by side — one showing the contact's conversation, one showing the organizer's — and refresh every 5 seconds by polling a new `/api/conversation` endpoint. The goal is to let the operator visually verify that the messages each party receives in real life match what the system is doing.

---

## Architecture

### New endpoint: `GET /api/conversation`

A dedicated lightweight endpoint for the frontend phone log. Returns full conversation histories for both parties from a single request (one thread object serves both). No `DEBUG_TOKEN` required — it returns only conversation content, not sensitive fields like organizer email, private keys, or calendar data.

**Request:**
```
GET /api/conversation?phone=<e164>
```
The `phone` param accepts the contact or organizer phone number (both point to the same thread). Applies the same `+`-as-space URL decoding as `/api/debug-thread`.

**Response (found):**
```json
{
  "found": true,
  "status": "pending",
  "contactName": "Bob",
  "contactPhone": "+15551234567",
  "organizerName": "Alice",
  "organizerPhone": "+15550009999",
  "conversationHistory": [
    { "role": "model", "content": "Hi Bob! Alice wants to meet..." },
    { "role": "user",  "content": "Monday works!" }
  ],
  "organizerConversationHistory": [
    { "role": "model", "content": "Bob wants to schedule. Reply APPROVE..." },
    { "role": "user",  "content": "Approve" },
    { "role": "model", "content": "Got it! I've reached out to Bob." }
  ]
}
```

**Response (not found):**
```json
{ "found": false, "phone": "+15551234567" }
```

**Excluded fields:** `organizerEmail`, `threadId`, `createdAt`, `pendingContactSuggestion`, `pendingContactDatetime`, `directorAlternatives`, `waitingForOrganizerApproval`, `attempts`. These are either sensitive or irrelevant to the conversation view.

---

## Thread Schema Change

Add `organizerConversationHistory: []` to the thread object created in `api/initiate.js`. This is a separate array from `conversationHistory` (which tracks the contact's side) so it never interferes with Gemini's multi-turn API, which requires strict alternating `user`/`model` roles.

**Role semantics (same for both arrays):**
- `role: "model"` — message sent BY the system TO the person (outbound SMS)
- `role: "user"` — message sent BY the person TO the system (inbound SMS reply)

---

## Backend Changes

### `api/initiate.js`
1. Add `organizerConversationHistory: []` to the thread init object.
2. Push the outbound organizer SMS into `organizerConversationHistory` in all branches that send to the organizer:
   - Branch 1 (organizer review): push the "wants to schedule, reply APPROVE" message
   - Branch 2 (backup times / FYI): push the `orgFyi` message

### `api/sms-reply.js`
Push organizer-bound messages into `organizerConversationHistory` at every point the system sends or receives from the organizer:

| Location | What to push |
|---|---|
| `handleOrganizerInitialReview` — on success | `{ role: 'user', content: incomingMessage }` (organizer's reply), then `{ role: 'model', content: replyToOrganizer }` (acknowledgment sent back) |
| `handleOrganizerInitialReview` — on error | `{ role: 'model', content: 'Sorry, something went wrong...' }` |
| `handleOrganizerReply` — approval branch | `{ role: 'user', content: incomingMessage }`, then `{ role: 'model', content: 'Confirmed! I've let X know.' }` |
| `handleOrganizerReply` — rejection/alternatives branch | `{ role: 'user', content: incomingMessage }`, then `{ role: 'model', content: 'Got it! I've forwarded your message...' }` |
| `handleOrganizerReply` — unsolicited update | `{ role: 'user', content: incomingMessage }`, then `{ role: 'model', content: 'Got it! I've let X know...' }` |
| `handleOrganizerReply` — error catch | `{ role: 'model', content: 'Sorry, something went wrong...' }` |

All pushes happen before `saveBoth(thread)` so the history is always consistent with what was sent, with one exception: the **unsolicited update branch** in `handleOrganizerReply` currently calls `saveBoth` before generating the AI reply. That branch will need a slight reorder — push both the user message and the model acknowledgment first, then call `saveBoth` once at the end.

### `api/conversation.js` (new file)
Express app with a single `GET /api/conversation` handler:
1. Decode `+`-as-space in phone param (same pattern as debug-thread)
2. Return 400 if phone is missing
3. Call `getThread(phone)`
4. Return 404 `{ found: false }` if not found
5. Return 500 on Redis error
6. Return 200 with the safe subset of fields listed above

---

## Frontend Changes (`public/index.html`)

### Layout
Change the page's main content area from a single-column form to a two-column grid:
- **Left column:** existing scheduling form (no changes to form fields)
- **Right column:** new conversation log panel (fixed ~420px width)

### Conversation Log Panel
Contains:
- Header: "Conversation Log" label + "Live · 5s" pulsing green badge (hidden before submit)
- Two iOS phone mockups side by side: Contact (left) and Organizer (right)
- Each phone has: Dynamic Island, status bar, iMessage-style header with avatar + name + number, scrollable bubble area, home bar indicator
- Status badge under each phone label: reflects `status` field — `pending` (blue), `waiting_organizer_initial` / `waitingForOrganizerApproval` (orange "reviewing"), `confirmed` (green)
- If no organizer phone was provided, the organizer phone column is hidden

### Phone bubble rendering
- `role: "model"` → left-aligned blue bubble (`#007aff`)
- `role: "user"` → right-aligned grey bubble (`#e9e9eb`, black text)
- Bubble area auto-scrolls to the latest message on each refresh

### Before submit state
Both phones show an empty state: phone icon + "Submit the form to see messages"

### Polling logic (JavaScript)
1. On successful form submit, capture `contactPhone` and `organizerPhone` via `getPhone()` **before** the form fields are cleared/reset
2. If an existing poll interval is running (from a previous submit), clear it first
3. Immediately call `GET /api/conversation?phone=<contactPhone>`
4. Render both phone conversations from the response
5. Start `setInterval` at 5000ms to repeat steps 3–4
6. On each poll, clear and re-render bubbles from fresh response
7. Stop polling when `response.status === 'confirmed'`; show a "✓ Confirmed" banner across both phones
8. On API error: show a small ⚠ indicator below the live badge; keep retrying (do not clear existing bubbles)
9. If `found: false`: show "Waiting for first message…" in both bubble areas

---

## Error Handling Summary

| State | Contact phone display | Organizer phone display |
|---|---|---|
| Before form submit | Empty state icon + label | Same |
| No organizer phone in form | Shows normally | Hidden |
| API returns `found: false` | "Waiting for first message…" | Same |
| API returns 500 / network error | ⚠ badge, keep existing bubbles | Same |
| `status: confirmed` | Confirmed banner, polling stops | Same |

---

## Testing

### New: `tests/api/conversation.test.js`
- Returns 400 when `phone` param is missing
- Returns 404 `{ found: false }` when no thread exists
- Returns 200 with `conversationHistory` and `organizerConversationHistory` when thread found
- Excludes sensitive fields (`organizerEmail`, `threadId`, etc.)
- Returns 500 on Redis error
- Restores `+` when browser URL-encodes it as space

### Updated: `tests/api/initiate.test.js`
- Verify `organizerConversationHistory` is initialized as empty array on all threads
- Verify organizer SMS is pushed to `organizerConversationHistory` in branch 1 (review flow)
- Verify orgFyi is pushed to `organizerConversationHistory` in branch 2 (backup times flow)

### Updated: `tests/api/sms-reply.test.js`
- Verify organizer inbound + outbound messages pushed to `organizerConversationHistory` in `handleOrganizerInitialReview`
- Verify organizer messages pushed in approval, rejection, and unsolicited update branches of `handleOrganizerReply`

---

## Files Touched

| File | Change type |
|---|---|
| `api/conversation.js` | New |
| `api/initiate.js` | Updated — add `organizerConversationHistory` to thread init + push initial organizer messages |
| `api/sms-reply.js` | Updated — push organizer messages to `organizerConversationHistory` throughout |
| `public/index.html` | Updated — two-column layout, iOS phone mockups, polling JS |
| `tests/api/conversation.test.js` | New |
| `tests/api/initiate.test.js` | Updated — new assertions |
| `tests/api/sms-reply.test.js` | Updated — new assertions |
