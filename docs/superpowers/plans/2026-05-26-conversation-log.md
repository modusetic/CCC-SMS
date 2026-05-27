# Conversation Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live two-phone iOS-style SMS conversation log to the right of the scheduling form, auto-polling every 5 seconds to show exactly what the contact and organizer see on their phones.

**Architecture:** A new `/api/conversation` endpoint returns both conversation histories from one Redis lookup. The thread schema gains an `organizerConversationHistory` array (separate from `conversationHistory` to avoid breaking Gemini's alternating-role requirement). The frontend polls after submit and renders two iOS phone mockups side by side.

**Tech Stack:** Node.js/Express, Redis (via `lib/kv`), vanilla JS, plain CSS (no build step — all changes go in `public/index.html`)

---

## File Map

| File | Change |
|---|---|
| `api/initiate.js` | Add `organizerConversationHistory: []` to thread; push organizer SMS in branches 1 & 2; fix orgFyi (move from `conversationHistory` → `organizerConversationHistory`) |
| `api/sms-reply.js` | Push organizer inbound+outbound to `organizerConversationHistory` in all organizer handler branches; reorder unsolicited-update branch |
| `api/conversation.js` | New — GET endpoint returning safe conversation fields |
| `public/index.html` | Two-column layout, iOS phone shells, polling JS |
| `tests/api/initiate.test.js` | New assertions for `organizerConversationHistory`; fix existing orgFyi test |
| `tests/api/sms-reply.test.js` | New assertions for `organizerConversationHistory` in all organizer branches |
| `tests/api/conversation.test.js` | New — full coverage of the new endpoint |

---

## Task 1: Thread schema + `initiate.js` organizer history

**Context:** `conversationHistory` tracks the contact's side only. We add a parallel `organizerConversationHistory` array. We also fix a bug introduced in the last session: `orgFyi` was pushed to `conversationHistory` (creating two consecutive `model` entries which breaks Gemini). It should instead go to `organizerConversationHistory`.

**Files:**
- Modify: `api/initiate.js`
- Modify: `tests/api/initiate.test.js`

- [ ] **Step 1: Write failing tests**

Open `tests/api/initiate.test.js`. Add a new describe block at the bottom and update the existing orgFyi test:

```javascript
// ── REPLACE this existing test (it currently asserts the wrong behavior) ──
// Old name: 'records both contactMsg and orgFyi in conversationHistory before save'
// New test replaces it entirely:

describe('POST /api/initiate — organizerConversationHistory', () => {
  beforeEach(() => {
    saveThread.mockClear();
    sendSms.mockClear();
  });

  it('initializes every thread with empty organizerConversationHistory', async () => {
    await request(app).post('/api/initiate').send(base);
    const saved = saveThread.mock.calls[0][1];
    expect(saved.organizerConversationHistory).toEqual([]);
  });

  it('pushes organizer review SMS to organizerConversationHistory in branch 1', async () => {
    const body = { ...base, organizerPhone: '+15550009999' };
    await request(app).post('/api/initiate').send(body);
    const saved = saveThread.mock.calls.find(c => c[0] === '+15550009999')[1];
    expect(saved.organizerConversationHistory).toHaveLength(1);
    expect(saved.organizerConversationHistory[0].role).toBe('model');
    expect(saved.organizerConversationHistory[0].content).toMatch(/Reply APPROVE/i);
  });

  it('puts orgFyi in organizerConversationHistory (not conversationHistory) in branch 2', async () => {
    const body = {
      ...base,
      organizerPhone: '+15550009999',
      directorAlternatives: ['Wednesday at 3pm']
    };
    await request(app).post('/api/initiate').send(body);
    const saved = saveThread.mock.calls.find(c => c[0] === '+15551234567')[1];
    // conversationHistory must have exactly 1 entry (contactMsg only — no orgFyi)
    expect(saved.conversationHistory).toHaveLength(1);
    expect(saved.conversationHistory[0].role).toBe('model');
    // organizerConversationHistory must have exactly 1 entry (orgFyi)
    expect(saved.organizerConversationHistory).toHaveLength(1);
    expect(saved.organizerConversationHistory[0].role).toBe('model');
    expect(saved.organizerConversationHistory[0].content).toContain('Bob');
  });
});
```

Also **delete** the existing test `'records both contactMsg and orgFyi in conversationHistory before save'` from the `POST /api/initiate — orgFyi recorded in conversationHistory` describe block — it tests incorrect behavior.

- [ ] **Step 2: Run tests and verify the three new tests fail (plus the old orgFyi test if not yet deleted)**

```
npx jest tests/api/initiate.test.js --no-coverage
```

Expected: 3+ failures. The new tests should fail because `organizerConversationHistory` doesn't exist yet.

- [ ] **Step 3: Update `api/initiate.js`**

Make three changes:

**3a — Add `organizerConversationHistory` to the thread init object** (after `conversationHistory: []`):

```javascript
  conversationHistory: [],
  organizerConversationHistory: [],
  createdAt: new Date().toISOString()
```

**3b — Branch 1 (organizer review, no backup times):** push `smsBody` to `organizerConversationHistory` BEFORE saves. Replace this block:

```javascript
    // BEFORE (lines ~81-88):
    thread.status = 'waiting_organizer_initial';
    const n = proposedTimes.length;
    const smsBody = truncate(
      `${contactName} wants to schedule. Their proposed ${timeWord(n)}: ${listTimes(proposedTimes)}. Reply APPROVE or with your available ${timeWord(n)}.`
    );
    await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);
    console.log(`[initiate] thread ${thread.threadId} saved (waiting_organizer_initial) contact=${normalizedContactPhone} organizer=${normalizedOrganizerPhone}`);
    await sendSms(normalizedOrganizerPhone, smsBody);
```

With:

```javascript
    thread.status = 'waiting_organizer_initial';
    const n = proposedTimes.length;
    const smsBody = truncate(
      `${contactName} wants to schedule. Their proposed ${timeWord(n)}: ${listTimes(proposedTimes)}. Reply APPROVE or with your available ${timeWord(n)}.`
    );
    thread.organizerConversationHistory.push({ role: 'model', content: smsBody });
    await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);
    console.log(`[initiate] thread ${thread.threadId} saved (waiting_organizer_initial) contact=${normalizedContactPhone} organizer=${normalizedOrganizerPhone}`);
    await sendSms(normalizedOrganizerPhone, smsBody);
```

**3c — Branch 2 (backup times):** move orgFyi from `conversationHistory` to `organizerConversationHistory`. Replace:

```javascript
    // BEFORE:
      thread.conversationHistory.push({ role: 'model', content: contactMsg });
      const orgFyi = truncate(
        `Scheduling started with ${contactName}. I've sent them your available ${timeWord(n)} and will let you know when confirmed.`
      );
      // Record orgFyi in history so future organizer multi-turn context is complete.
      thread.conversationHistory.push({ role: 'model', content: orgFyi });
      await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);
```

With:

```javascript
      thread.conversationHistory.push({ role: 'model', content: contactMsg });
      const orgFyi = truncate(
        `Scheduling started with ${contactName}. I've sent them your available ${timeWord(n)} and will let you know when confirmed.`
      );
      // orgFyi goes to organizerConversationHistory — NOT conversationHistory.
      // Putting it in conversationHistory would create two consecutive 'model' entries
      // which breaks Gemini's multi-turn API.
      thread.organizerConversationHistory.push({ role: 'model', content: orgFyi });
      await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);
```

- [ ] **Step 4: Run tests and verify all pass**

```
npx jest tests/api/initiate.test.js --no-coverage
```

Expected: all tests pass, no failures.

- [ ] **Step 5: Commit**

```
git add api/initiate.js tests/api/initiate.test.js
git commit -m "feat: add organizerConversationHistory to thread schema"
```

---

## Task 2: Track organizer messages in `sms-reply.js`

**Context:** Every point where the system sends to or receives from the organizer should push an entry to `organizerConversationHistory`. Four locations: `handleOrganizerInitialReview`, approval branch, rejection/alternatives branch, and unsolicited-update branch. The unsolicited-update branch also needs a reorder (currently saves before calling AI; we move the save to after so all history is captured in one write).

**Files:**
- Modify: `api/sms-reply.js`
- Modify: `tests/api/sms-reply.test.js`

- [ ] **Step 1: Write failing tests**

Add these describe blocks to `tests/api/sms-reply.test.js`:

```javascript
describe('organizer messages — organizerConversationHistory tracking', () => {
  const waitingThread = { ...baseThread, status: 'waiting_organizer_initial' };
  const pendingThread = {
    ...baseThread,
    waitingForOrganizerApproval: true,
    pendingContactSuggestion: 'Friday May 22 at 2pm',
    pendingContactDatetime: '2026-05-22T14:00:00'
  };

  beforeEach(() => {
    const { saveThread } = require('../../lib/kv');
    saveThread.mockClear();
    sendSms.mockClear();
    getOrganizerInitialContactMessage.mockResolvedValue(
      "Hey Bob! Alice wants to meet — Monday at 2pm. Which works?"
    );
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is free at 3pm instead.");
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on initial review approval', async () => {
    const { saveThread } = require('../../lib/kv');
    getThread.mockResolvedValue({ ...waitingThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: 'Approve' });
    const saved = saveThread.mock.calls.find(c => c[0] === '+15550009999')[1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: 'Approve' });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
    expect(saved.organizerConversationHistory[1].content).toContain('Bob');
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on counter-proposal approval', async () => {
    const { saveThread } = require('../../lib/kv');
    getThread.mockResolvedValue({ ...pendingThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: 'Yes' });
    const saved = saveThread.mock.calls.find(c => c[0] === '+15550009999')[1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: 'Yes' });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
    expect(saved.organizerConversationHistory[1].content).toMatch(/confirmed/i);
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on rejection/alternatives', async () => {
    const { saveThread } = require('../../lib/kv');
    getThread.mockResolvedValue({ ...pendingThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: 'Monday at 3pm instead' });
    const saved = saveThread.mock.calls.find(c => c[0] === '+15550009999')[1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: 'Monday at 3pm instead' });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
    expect(saved.organizerConversationHistory[1].content).toMatch(/forwarded/i);
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on unsolicited update', async () => {
    const { saveThread } = require('../../lib/kv');
    getThread.mockResolvedValue({ ...baseThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: "I can't Monday, try 3pm" });
    const saved = saveThread.mock.calls.find(c => c[0] === '+15550009999')[1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: "I can't Monday, try 3pm" });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
  });
});
```

- [ ] **Step 2: Run tests and verify the 4 new tests fail**

```
npx jest tests/api/sms-reply.test.js --no-coverage
```

Expected: 4 failures on the new `organizerConversationHistory tracking` tests.

- [ ] **Step 3: Update `handleOrganizerInitialReview` in `api/sms-reply.js`**

Replace the entire `handleOrganizerInitialReview` function:

```javascript
async function handleOrganizerInitialReview(thread, incomingMessage, res) {
  try {
    const isApproval = /\b(yes|approve|ok|confirm|confirmed|sounds good|great|perfect)\b/i.test(incomingMessage);

    const aiMsg = await getOrganizerInitialContactMessage(
      thread.organizerName,
      thread.contactName,
      thread.proposedTimes,
      incomingMessage,
      isApproval
    );
    const smsBody = truncate(aiMsg);

    const reply = isApproval
      ? `Got it! I've reached out to ${thread.contactName} with the proposed times.`
      : `Got it! I've sent ${thread.contactName} your updated availability.`;

    thread.status = 'pending';
    thread.conversationHistory.push({ role: 'model', content: smsBody });
    thread.organizerConversationHistory = thread.organizerConversationHistory || [];
    thread.organizerConversationHistory.push({ role: 'user', content: incomingMessage });
    thread.organizerConversationHistory.push({ role: 'model', content: reply });
    await saveBoth(thread);

    await sendSms(thread.contactPhone, smsBody);
    console.log(`[sms-reply] initial contact message sent to ${thread.contactPhone}: "${smsBody}"`);

    return res.send(twimlReply(reply));

  } catch (err) {
    console.error('[sms-reply] Error processing organizer initial review:', err.message);
    return res.send(twimlReply('Sorry, something went wrong sending the message. Please try again.'));
  }
}
```

- [ ] **Step 4: Update the approval branch in `handleOrganizerReply`**

Find the `if (isApproval)` block inside `handleOrganizerReply`. Add the two history pushes **before** the existing `await saveBoth(thread)` call:

```javascript
    if (isApproval) {
      thread.status = 'confirmed';
      thread.waitingForOrganizerApproval = false;

      if (thread.pendingContactDatetime) {
        try {
          await bookCalendarEvent(thread.pendingContactDatetime, thread.contactName, thread.organizerEmail);
        } catch (calErr) {
          console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
        }
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactDatetime);
      } else {
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactSuggestion);
      }

      const confirmMsg = `Great news! Your meeting with ${thread.organizerName} is confirmed for ${thread.pendingContactSuggestion}.`;
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      thread.organizerConversationHistory = thread.organizerConversationHistory || [];
      thread.organizerConversationHistory.push({ role: 'user', content: incomingMessage });
      thread.organizerConversationHistory.push({ role: 'model', content: `Confirmed! I've let ${thread.contactName} know.` });
      await saveBoth(thread);

      await sendSms(thread.contactPhone, confirmMsg);
      return res.send(twimlReply(`Confirmed! I've let ${thread.contactName} know.`));
```

- [ ] **Step 5: Update the rejection/alternatives branch in `handleOrganizerReply`**

Find the `} else {` block (the non-approval path). Add history pushes **before** `await saveBoth(thread)`:

```javascript
    } else {
      thread.waitingForOrganizerApproval = false;
      thread.pendingContactSuggestion = null;
      thread.pendingContactDatetime = null;
      thread.directorAlternatives = [...(thread.directorAlternatives || []), incomingMessage];

      const contactMsg = truncate(`Message from ${thread.organizerName}: ${incomingMessage}`);
      thread.organizerConversationHistory = thread.organizerConversationHistory || [];
      thread.organizerConversationHistory.push({ role: 'user', content: incomingMessage });
      thread.organizerConversationHistory.push({ role: 'model', content: `Got it! I've forwarded your message to ${thread.contactName}.` });
      await saveBoth(thread);

      console.log(`[sms-reply] forwarding organizer alternatives to contact ${thread.contactPhone}`);
      await sendSms(thread.contactPhone, contactMsg);
      return res.send(twimlReply(`Got it! I've forwarded your message to ${thread.contactName}.`));
    }
```

- [ ] **Step 6: Update the unsolicited-update branch in `handleOrganizerReply`**

Find the `if (!thread.waitingForOrganizerApproval)` block. Replace the entire try/catch with the reordered version (AI call first, then push history, then save):

```javascript
  if (!thread.waitingForOrganizerApproval) {
    try {
      thread.directorAlternatives = [...(thread.directorAlternatives || []), incomingMessage];
      const aiMsg = await getOrganizerUpdateReply(thread.organizerName, thread.contactName, incomingMessage);
      const smsSafe = truncate(aiMsg);
      thread.organizerConversationHistory = thread.organizerConversationHistory || [];
      thread.organizerConversationHistory.push({ role: 'user', content: incomingMessage });
      thread.organizerConversationHistory.push({ role: 'model', content: `Got it! I've let ${thread.contactName} know about your updated availability.` });
      await saveBoth(thread);
      await sendSms(thread.contactPhone, smsSafe);
      console.log(`[sms-reply] organizer unsolicited update — AI reply sent to contact ${thread.contactPhone}: "${smsSafe}"`);
      return res.send(twimlReply(`Got it! I've let ${thread.contactName} know about your updated availability.`));
    } catch (err) {
      console.error('[sms-reply] Error handling organizer availability update:', err.message);
      return res.send('<Response></Response>');
    }
  }
```

- [ ] **Step 7: Run all tests and verify everything passes**

```
npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```
git add api/sms-reply.js tests/api/sms-reply.test.js
git commit -m "feat: track organizerConversationHistory in sms-reply"
```

---

## Task 3: New `/api/conversation` endpoint

**Files:**
- Create: `api/conversation.js`
- Create: `tests/api/conversation.test.js`

- [ ] **Step 1: Create the test file**

Create `tests/api/conversation.test.js`:

```javascript
const request = require('supertest');

jest.mock('../../lib/kv', () => ({ getThread: jest.fn() }));
const { getThread } = require('../../lib/kv');
const app = require('../../api/conversation');

const mockThread = {
  threadId: 'abc-123',
  status: 'pending',
  contactName: 'Bob',
  contactPhone: '+15551234567',
  organizerName: 'Alice',
  organizerEmail: 'alice@example.com',
  organizerPhone: '+15550009999',
  conversationHistory: [
    { role: 'model', content: 'Hi Bob! Which time works?' },
    { role: 'user',  content: 'Monday works!' }
  ],
  organizerConversationHistory: [
    { role: 'model', content: 'Bob wants to schedule. Reply APPROVE.' }
  ],
  attempts: 1,
  pendingContactSuggestion: null,
  directorAlternatives: []
};

describe('GET /api/conversation', () => {
  beforeEach(() => getThread.mockReset());

  it('returns 400 when phone param is missing', async () => {
    const res = await request(app).get('/api/conversation');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  it('returns 404 with found:false when no thread exists', async () => {
    getThread.mockResolvedValue(null);
    const res = await request(app).get('/api/conversation?phone=+19999999999');
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
    expect(res.body.phone).toBe('+19999999999');
  });

  it('returns 200 with both conversation histories when thread found', async () => {
    getThread.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.conversationHistory).toHaveLength(2);
    expect(res.body.organizerConversationHistory).toHaveLength(1);
  });

  it('includes status, waitingForOrganizerApproval, contactName, organizerName, contactPhone, organizerPhone', async () => {
    getThread.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.body.status).toBe('pending');
    expect(res.body.waitingForOrganizerApproval).toBe(false);
    expect(res.body.contactName).toBe('Bob');
    expect(res.body.organizerName).toBe('Alice');
    expect(res.body.contactPhone).toBe('+15551234567');
    expect(res.body.organizerPhone).toBe('+15550009999');
  });

  it('excludes sensitive fields', async () => {
    getThread.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.body.organizerEmail).toBeUndefined();
    expect(res.body.threadId).toBeUndefined();
    expect(res.body.attempts).toBeUndefined();
    expect(res.body.directorAlternatives).toBeUndefined();
    expect(res.body.pendingContactSuggestion).toBeUndefined();
  });

  it('returns empty arrays when histories are missing (old threads)', async () => {
    getThread.mockResolvedValue({ ...mockThread, conversationHistory: undefined, organizerConversationHistory: undefined });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.body.conversationHistory).toEqual([]);
    expect(res.body.organizerConversationHistory).toEqual([]);
  });

  it('returns 500 on Redis error', async () => {
    getThread.mockRejectedValue(new Error('Redis timeout'));
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.status).toBe(500);
  });

  it('restores + sign when browser URL-encodes it as a space', async () => {
    getThread.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=%2015551234567');
    expect(getThread).toHaveBeenCalledWith('+15551234567');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests and verify all 8 fail (module not found)**

```
npx jest tests/api/conversation.test.js --no-coverage
```

Expected: all 8 fail — `Cannot find module '../../api/conversation'`.

- [ ] **Step 3: Create `api/conversation.js`**

```javascript
const express = require('express');
const { getThread } = require('../lib/kv');

const app = express();
app.use(express.json());

app.get('/api/conversation', async (req, res) => {
  const raw = req.query.phone || '';
  // Express/qs decodes '+' as a space in query strings — restore it.
  const phone = raw.startsWith(' ') ? '+' + raw.slice(1).trim() : raw.trim();

  if (!phone) {
    return res.status(400).json({ error: 'Missing ?phone= query parameter (E.164 format, e.g. +15551234567)' });
  }

  let thread;
  try {
    thread = await getThread(phone);
  } catch (err) {
    return res.status(500).json({ error: 'Redis lookup failed', detail: err.message });
  }

  if (!thread) {
    return res.status(404).json({ found: false, phone });
  }

  return res.status(200).json({
    found: true,
    status:                        thread.status,
    waitingForOrganizerApproval:   thread.waitingForOrganizerApproval || false,
    contactName:                   thread.contactName,
    contactPhone:                  thread.contactPhone,
    organizerName:                 thread.organizerName,
    organizerPhone:                thread.organizerPhone || null,
    conversationHistory:           thread.conversationHistory || [],
    organizerConversationHistory:  thread.organizerConversationHistory || []
  });
});

module.exports = app;
```

- [ ] **Step 4: Run tests and verify all pass**

```
npx jest tests/api/conversation.test.js --no-coverage
```

Expected: 8/8 pass.

- [ ] **Step 5: Run full suite to check nothing broke**

```
npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```
git add api/conversation.js tests/api/conversation.test.js
git commit -m "feat: add /api/conversation endpoint for phone log"
```

---

## Task 4: Frontend — layout, CSS, and phone shells

**Context:** The current page is a centred single-column card. We restructure to a two-column layout: form on the left, phone log on the right. The phone log panel contains two iOS-style phone mockups (contact + organizer) in an empty state until the form is submitted. No JavaScript changes in this task — just HTML and CSS.

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Replace the `<style>` block's `body` and `.card` rules and add all new CSS**

In `public/index.html`, find the closing `</style>` tag (line 224). **Before it**, add the following new CSS rules:

```css
    /* ── Two-column workspace ─────────────────────────────────────────────── */
    .workspace {
      display: grid;
      grid-template-columns: 540px 1fr;
      gap: 24px;
      align-items: start;
      width: 100%;
      max-width: 1100px;
    }

    /* ── Phone log panel ─────────────────────────────────────────────────── */
    .log-panel {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
      padding: 28px;
    }

    .log-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    .log-title {
      font-size: 1rem;
      font-weight: 600;
      color: #111;
    }

    .live-badge {
      display: none;
      align-items: center;
      gap: 5px;
      background: #ecfdf5;
      border: 1px solid #6ee7b7;
      border-radius: 20px;
      padding: 3px 10px;
      font-size: 0.75rem;
      font-weight: 500;
      color: #065f46;
    }

    .live-badge.visible { display: flex; }

    .live-dot {
      width: 7px;
      height: 7px;
      background: #10b981;
      border-radius: 50%;
      animation: livepulse 1.5s infinite;
    }

    @keyframes livepulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.25; }
    }

    .phones-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    .phone-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .phone-col.hidden { display: none; }

    .phone-label {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
    }

    .status-badge {
      font-size: 0.68rem;
      font-weight: 600;
      padding: 2px 10px;
      border-radius: 20px;
      letter-spacing: 0.03em;
      display: none;
    }

    .status-badge.visible { display: inline-block; }
    .status-pending  { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .status-waiting  { background: #fff7ed; color: #c2410c; border: 1px solid #fed7aa; }
    .status-confirmed{ background: #ecfdf5; color: #065f46; border: 1px solid #6ee7b7; }

    /* ── iOS phone shell ─────────────────────────────────────────────────── */
    .iphone {
      width: 160px;
      background: #000;
      border-radius: 38px;
      border: 8px solid #1a1a1a;
      box-shadow: 0 0 0 1.5px #333, 0 12px 28px rgba(0,0,0,0.18);
      overflow: hidden;
    }

    .dynamic-island-bar {
      background: #000;
      height: 30px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .dynamic-island {
      width: 62px;
      height: 18px;
      background: #111;
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
    }

    .di-camera {
      width: 7px;
      height: 7px;
      background: #1c1c1c;
      border-radius: 50%;
      border: 1px solid #2a2a2a;
    }

    .di-dot {
      width: 3px;
      height: 3px;
      background: #1c1c1c;
      border-radius: 50%;
    }

    .ios-status {
      background: #fff;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1px 13px 2px;
      font-size: 9px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .imessage-header {
      background: #f2f2f7;
      padding: 8px 8px 7px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      border-bottom: 1px solid #d1d1d6;
    }

    .phone-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 14px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .avatar-contact  { background: #007aff; }
    .avatar-organizer{ background: #34c759; }

    .imessage-name {
      font-size: 9px;
      font-weight: 600;
      color: #000;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .imessage-number {
      font-size: 8px;
      color: #8e8e93;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .bubble-area {
      background: #fff;
      padding: 8px 7px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-height: 150px;
      max-height: 150px;
      overflow-y: auto;
    }

    .bubble {
      font-size: 8.5px;
      padding: 5px 9px;
      border-radius: 14px;
      line-height: 1.35;
      max-width: 82%;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      word-break: break-word;
    }

    .bubble-out {
      background: #007aff;
      color: #fff;
      border-bottom-left-radius: 3px;
      align-self: flex-start;
    }

    .bubble-in {
      background: #e9e9eb;
      color: #000;
      border-bottom-right-radius: 3px;
      align-self: flex-end;
    }

    .ios-home {
      background: #fff;
      padding: 5px;
      display: flex;
      justify-content: center;
    }

    .home-bar {
      width: 46px;
      height: 4px;
      background: #000;
      border-radius: 2px;
      opacity: 0.18;
    }

    /* Empty state shown before first submit */
    .phone-empty {
      background: #fff;
      min-height: 150px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }

    .phone-empty-icon {
      font-size: 22px;
      opacity: 0.25;
    }

    .phone-empty-text {
      font-size: 8px;
      color: #8e8e93;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      text-align: center;
      padding: 0 8px;
    }

    /* Poll error indicator */
    .poll-error {
      display: none;
      font-size: 0.75rem;
      color: #b45309;
      text-align: center;
      margin-top: 10px;
    }

    .poll-error.visible { display: block; }

    /* Confirmed banner */
    .confirmed-banner {
      display: none;
      background: #ecfdf5;
      border: 1px solid #6ee7b7;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.82rem;
      font-weight: 500;
      color: #065f46;
      text-align: center;
      margin-top: 14px;
    }

    .confirmed-banner.visible { display: block; }

    /* Responsive: stack on narrow screens */
    @media (max-width: 900px) {
      .workspace {
        grid-template-columns: 1fr;
      }
    }
```

- [ ] **Step 2: Update `body` CSS to support the wider workspace**

Find and replace the `body` rule in the `<style>` block:

```css
    /* REPLACE existing body rule with: */
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f5f5f7;
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 32px 16px;
    }
```

- [ ] **Step 3: Update `.card` to remove `max-width` constraint**

Find and replace the `.card` rule:

```css
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
      padding: 40px;
      width: 100%;
    }
```

- [ ] **Step 4: Wrap the existing `<div class="card">` in the workspace grid and add the phone log panel**

Find this in `<body>`:

```html
<div class="card">
  <h1>SMS Scheduling</h1>
```

Replace with:

```html
<div class="workspace">
<div class="card">
  <h1>SMS Scheduling</h1>
```

Then find the closing `</div>` that closes the card. It is the line immediately before the blank line before `<script>` — the very last `</div>` before the script tag. Replace:

```html
</div>

<script>
```

With:

```html
</div><!-- /.card -->

<!-- ── Phone log panel ── -->
<div class="log-panel">
  <div class="log-header">
    <span class="log-title">Conversation Log</span>
    <span class="live-badge" id="liveBadge">
      <span class="live-dot"></span>
      Live · 5s
    </span>
  </div>

  <div class="phones-row">

    <!-- Contact phone -->
    <div class="phone-col" id="contactCol">
      <span class="phone-label">Contact</span>
      <span class="status-badge" id="contactStatus"></span>
      <div class="iphone">
        <div class="dynamic-island-bar">
          <div class="dynamic-island">
            <div class="di-camera"></div>
            <div class="di-dot"></div>
          </div>
        </div>
        <div class="ios-status">
          <span>9:41</span>
          <span>●●● 🔋</span>
        </div>
        <div class="imessage-header">
          <div class="phone-avatar avatar-contact" id="contactAvatar">?</div>
          <div class="imessage-name" id="contactAvatarName">—</div>
          <div class="imessage-number" id="contactAvatarNumber">—</div>
        </div>
        <div class="bubble-area" id="contactBubbles">
          <div class="phone-empty">
            <div class="phone-empty-icon">💬</div>
            <div class="phone-empty-text">Submit the form to see messages</div>
          </div>
        </div>
        <div class="ios-home"><div class="home-bar"></div></div>
      </div>
    </div>

    <!-- Organizer phone -->
    <div class="phone-col" id="organizerCol">
      <span class="phone-label">Organizer</span>
      <span class="status-badge" id="organizerStatus"></span>
      <div class="iphone">
        <div class="dynamic-island-bar">
          <div class="dynamic-island">
            <div class="di-camera"></div>
            <div class="di-dot"></div>
          </div>
        </div>
        <div class="ios-status">
          <span>9:41</span>
          <span>●●● 🔋</span>
        </div>
        <div class="imessage-header">
          <div class="phone-avatar avatar-organizer" id="organizerAvatar">?</div>
          <div class="imessage-name" id="organizerAvatarName">—</div>
          <div class="imessage-number" id="organizerAvatarNumber">—</div>
        </div>
        <div class="bubble-area" id="organizerBubbles">
          <div class="phone-empty">
            <div class="phone-empty-icon">💬</div>
            <div class="phone-empty-text">Submit the form to see messages</div>
          </div>
        </div>
        <div class="ios-home"><div class="home-bar"></div></div>
      </div>
    </div>

  </div><!-- /.phones-row -->

  <div class="poll-error" id="pollError">⚠ Could not refresh — retrying…</div>
  <div class="confirmed-banner" id="confirmedBanner">✓ Meeting confirmed! Polling stopped.</div>
</div><!-- /.log-panel -->

</div><!-- /.workspace -->

<script>
```

- [ ] **Step 5: Open the page in a browser and verify the layout**

Start the dev server (`npm start` or `vercel dev`) and open `http://localhost:3000`. Confirm:
- Form on the left, phone log panel on the right
- Both phones show the 💬 empty state
- Live badge is hidden
- Page looks correct at ~1100px+ width and stacks vertically at <900px

- [ ] **Step 6: Commit**

```
git add public/index.html
git commit -m "feat: add phone log panel layout and iOS shell to index.html"
```

---

## Task 5: Frontend polling JavaScript

**Context:** After a successful form submit, start polling `/api/conversation` every 5 seconds and render the results into the phone shells added in Task 4.

**Files:**
- Modify: `public/index.html` (JavaScript section only)

- [ ] **Step 1: Add the phone log JavaScript before the closing `</script>` tag**

Find the closing `</script>` tag at the end of the file. **Before it**, add:

```javascript
  // ── Phone log ─────────────────────────────────────────────────────────────
  let pollInterval = null;
  let currentContactPhone = null;

  function renderBubbles(containerId, history) {
    const el = document.getElementById(containerId);
    if (!history || history.length === 0) {
      el.innerHTML = '<div class="phone-empty"><div class="phone-empty-icon">💬</div><div class="phone-empty-text">Waiting for first message…</div></div>';
      return;
    }
    el.innerHTML = history.map(msg =>
      `<div class="bubble ${msg.role === 'model' ? 'bubble-out' : 'bubble-in'}">${msg.content}</div>`
    ).join('');
    el.scrollTop = el.scrollHeight;
  }

  function setStatusBadge(badgeId, status, waitingForOrganizerApproval) {
    const el = document.getElementById(badgeId);
    el.className = 'status-badge visible';
    if (status === 'confirmed') {
      el.classList.add('status-confirmed');
      el.textContent = '✓ confirmed';
    } else if (status === 'waiting_organizer_initial' || waitingForOrganizerApproval) {
      el.classList.add('status-waiting');
      el.textContent = '● reviewing';
    } else {
      el.classList.add('status-pending');
      el.textContent = '● pending';
    }
  }

  function updatePhoneHeaders(data) {
    // Contact
    document.getElementById('contactAvatar').textContent = (data.contactName || '?')[0].toUpperCase();
    document.getElementById('contactAvatarName').textContent = data.contactName || '—';
    document.getElementById('contactAvatarNumber').textContent = data.contactPhone || '—';
    // Organizer
    if (data.organizerPhone) {
      document.getElementById('organizerCol').classList.remove('hidden');
      document.getElementById('organizerAvatar').textContent = (data.organizerName || '?')[0].toUpperCase();
      document.getElementById('organizerAvatarName').textContent = data.organizerName || '—';
      document.getElementById('organizerAvatarNumber').textContent = data.organizerPhone;
    } else {
      document.getElementById('organizerCol').classList.add('hidden');
    }
  }

  async function pollConversation() {
    if (!currentContactPhone) return;
    try {
      const res = await fetch(`/api/conversation?phone=${encodeURIComponent(currentContactPhone)}`);
      document.getElementById('pollError').classList.remove('visible');

      if (res.status === 404) {
        renderBubbles('contactBubbles', []);
        renderBubbles('organizerBubbles', []);
        return;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      updatePhoneHeaders(data);
      renderBubbles('contactBubbles', data.conversationHistory);
      renderBubbles('organizerBubbles', data.organizerConversationHistory);
      setStatusBadge('contactStatus', data.status, data.waitingForOrganizerApproval);
      setStatusBadge('organizerStatus', data.status, data.waitingForOrganizerApproval);

      if (data.status === 'confirmed') {
        clearInterval(pollInterval);
        pollInterval = null;
        document.getElementById('liveBadge').classList.remove('visible');
        document.getElementById('confirmedBanner').classList.add('visible');
      }
    } catch (err) {
      document.getElementById('pollError').classList.add('visible');
    }
  }

  function startPolling(contactPhone) {
    currentContactPhone = contactPhone;
    // Clear any existing poll from a previous submit
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    document.getElementById('confirmedBanner').classList.remove('visible');
    document.getElementById('liveBadge').classList.add('visible');
    document.getElementById('pollError').classList.remove('visible');
    pollConversation(); // immediate first poll
    pollInterval = setInterval(pollConversation, 5000);
  }
```

- [ ] **Step 2: Hook `startPolling` into the form submit handler**

Find the `if (res.ok)` block inside the form submit handler:

```javascript
      if (res.ok) {
        showToast(`SMS sent! Thread ID: ${data.threadId}`, 'success');
        e.target.reset();
```

Replace the first two lines with:

```javascript
      if (res.ok) {
        showToast(`SMS sent! Thread ID: ${data.threadId}`, 'success');
        startPolling(contactPhone); // contactPhone captured before reset below
        e.target.reset();
```

- [ ] **Step 3: Verify in the browser end-to-end**

With the dev server running:
1. Fill in the form with real or test data
2. Click **Send scheduling SMS**
3. Confirm: both phones populate immediately with the initial messages, Live badge appears, status badges appear
4. If no organizer phone is entered, confirm the organizer phone column hides
5. Wait 5 seconds — confirm the panel refreshes (you can check Network tab in DevTools)

- [ ] **Step 4: Run full test suite to confirm nothing broke**

```
npx jest --no-coverage
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```
git add public/index.html
git commit -m "feat: add live conversation polling to phone log"
```

---

## Final Verification

- [ ] Run `npx jest --no-coverage` — all tests pass
- [ ] Open the page and do a full end-to-end walkthrough: submit form → phones populate → Live badge shows → status badges update → (if thread reaches confirmed) banner shows and polling stops
- [ ] Confirm organizer phone column hides when no organizer phone is entered
- [ ] Confirm the page is usable on a ~1000px wide browser window
