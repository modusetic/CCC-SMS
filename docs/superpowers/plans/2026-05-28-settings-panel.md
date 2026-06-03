# Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slide-in settings panel to the scheduling UI that lets operators edit AI prompt behavior and SMS template texts globally without touching code.

**Architecture:** A new `lib/settings.js` module stores/retrieves a JSON settings object from Redis under `global:settings`, with hardcoded defaults as fallback. A new `api/settings.js` exposes GET/POST endpoints. `lib/gemini.js` functions each accept an optional `settings` object. `api/sms-reply.js` loads settings once per request and passes them through. The frontend panel fetches on open and POSTs on save.

**Tech Stack:** Node.js/Express, @upstash/redis, Gemini 2.5 Flash, vanilla JS/CSS in public/index.html, Jest + supertest for tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/settings.js` | Create | DEFAULTS constant, `getSettings()`, `saveSettings()`, validation |
| `api/settings.js` | Create | GET /api/settings, POST /api/settings |
| `tests/lib/settings.test.js` | Create | Unit tests for settings module |
| `tests/api/settings.test.js` | Create | Integration tests for settings endpoints |
| `lib/gemini.js` | Modify | All 4 functions accept optional `settings` param |
| `api/sms-reply.js` | Modify | Load settings per request; `applyTemplate()`; pass settings to Gemini calls |
| `tests/lib/gemini.test.js` | Modify | Add tests verifying settings values appear in prompts |
| `tests/api/sms-reply.test.js` | Modify | Mock `getSettings`; add template substitution tests |
| `public/index.html` | Modify | ⚙ button, slide-in panel HTML/CSS/JS |

---

## Task 1: `lib/settings.js` — storage module

**Files:**
- Create: `lib/settings.js`
- Create: `tests/lib/settings.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/settings.test.js`:

```javascript
jest.mock('@upstash/redis', () => {
  const mockGet = jest.fn();
  const mockSet = jest.fn();
  return {
    Redis: jest.fn(() => ({ get: mockGet, set: mockSet })),
    _mockGet: mockGet,
    _mockSet: mockSet
  };
});

process.env.KV_REST_API_URL = 'https://test.upstash.io';
process.env.KV_REST_API_TOKEN = 'test-token';

const { getSettings, saveSettings, DEFAULTS } = require('../../lib/settings');
const redis = require('@upstash/redis');

beforeEach(() => {
  redis._mockGet.mockReset();
  redis._mockSet.mockReset();
});

describe('getSettings', () => {
  it('returns DEFAULTS when Redis key is absent', async () => {
    redis._mockGet.mockResolvedValue(null);
    const result = await getSettings();
    expect(result).toEqual(DEFAULTS);
  });

  it('merges stored partial values over defaults', async () => {
    redis._mockGet.mockResolvedValue({ assistantName: 'Jordan' });
    const result = await getSettings();
    expect(result.assistantName).toBe('Jordan');
    expect(result.maxMessageLength).toBe(160);
    expect(result.maxExchanges).toBe(6);
  });
});

describe('saveSettings', () => {
  it('saves merged object to Redis and returns it', async () => {
    redis._mockGet.mockResolvedValue(null);
    redis._mockSet.mockResolvedValue('OK');
    const result = await saveSettings({ assistantName: 'Jordan' });
    expect(result.assistantName).toBe('Jordan');
    expect(result.maxMessageLength).toBe(160);
    expect(redis._mockSet).toHaveBeenCalledWith(
      'global:settings',
      expect.objectContaining({ assistantName: 'Jordan' })
    );
  });

  it('strips unknown keys', async () => {
    redis._mockGet.mockResolvedValue(null);
    redis._mockSet.mockResolvedValue('OK');
    const result = await saveSettings({ assistantName: 'Jordan', hackerField: 'evil' });
    expect(result).not.toHaveProperty('hackerField');
  });

  it('throws validation error when assistantName is too long', async () => {
    await expect(saveSettings({ assistantName: 'x'.repeat(41) }))
      .rejects.toThrow(/assistantName/);
  });

  it('throws validation error when maxExchanges is out of range', async () => {
    await expect(saveSettings({ maxExchanges: 100 }))
      .rejects.toThrow(/maxExchanges/);
  });

  it('throws validation error when maxMessageLength is wrong type', async () => {
    await expect(saveSettings({ maxMessageLength: 'lots' }))
      .rejects.toThrow(/maxMessageLength/);
  });

  it('validation error has isValidation flag set', async () => {
    const err = await saveSettings({ maxExchanges: 99 }).catch(e => e);
    expect(err.isValidation).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/lib/settings.test.js --no-coverage
```

Expected: FAIL — "Cannot find module '../../lib/settings'"

- [ ] **Step 3: Create `lib/settings.js`**

```javascript
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const SETTINGS_KEY = 'global:settings';

const DEFAULTS = {
  assistantName: 'Alex',
  tone: 'Be conversational and polite.',
  maxMessageLength: 160,
  maxExchanges: 6,
  holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
  confirmationMessage: "Your meeting with {organizerName} is confirmed! You'll receive details soon."
};

const RULES = {
  assistantName:       { type: 'string',  min: 1,  max: 40  },
  tone:                { type: 'string',  min: 1,  max: 300 },
  maxMessageLength:    { type: 'integer', min: 50, max: 320 },
  maxExchanges:        { type: 'integer', min: 2,  max: 20  },
  holdingMessage:      { type: 'string',  min: 1,  max: 320 },
  confirmationMessage: { type: 'string',  min: 1,  max: 320 }
};

function validate(obj) {
  for (const [key, rule] of Object.entries(RULES)) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (rule.type === 'string') {
      if (typeof v !== 'string') return `${key} must be a string`;
      if (v.length < rule.min) return `${key} must be at least ${rule.min} character`;
      if (v.length > rule.max) return `${key} must be at most ${rule.max} characters`;
    } else {
      if (!Number.isInteger(v)) return `${key} must be an integer`;
      if (v < rule.min) return `${key} must be at least ${rule.min}`;
      if (v > rule.max) return `${key} must be at most ${rule.max}`;
    }
  }
  return null;
}

async function getSettings() {
  const stored = await redis.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...(stored || {}) };
}

async function saveSettings(partial) {
  const cleaned = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key in partial) cleaned[key] = partial[key];
  }
  const error = validate(cleaned);
  if (error) {
    const err = new Error(error);
    err.isValidation = true;
    throw err;
  }
  const current = await redis.get(SETTINGS_KEY);
  const merged = { ...DEFAULTS, ...(current || {}), ...cleaned };
  await redis.set(SETTINGS_KEY, merged);
  return merged;
}

module.exports = { getSettings, saveSettings, DEFAULTS };
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/lib/settings.test.js --no-coverage
```

Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/settings.js tests/lib/settings.test.js
git commit -m "feat: add lib/settings.js — global settings storage with Redis"
```

---

## Task 2: `api/settings.js` — GET/POST endpoints

**Files:**
- Create: `api/settings.js`
- Create: `tests/api/settings.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/api/settings.test.js`:

```javascript
const request = require('supertest');

jest.mock('../../lib/settings', () => ({
  getSettings: jest.fn(),
  saveSettings: jest.fn()
}));

const { getSettings, saveSettings } = require('../../lib/settings');
const app = require('../../api/settings');

beforeEach(() => {
  getSettings.mockReset();
  saveSettings.mockReset();
});

describe('GET /api/settings', () => {
  it('returns 200 with current settings', async () => {
    getSettings.mockResolvedValue({ assistantName: 'Alex', maxExchanges: 6 });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.assistantName).toBe('Alex');
  });

  it('returns 500 on Redis error without leaking detail', async () => {
    getSettings.mockRejectedValue(new Error('Redis timeout'));
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
    expect(res.body.detail).toBeUndefined();
  });
});

describe('POST /api/settings', () => {
  it('returns 200 with saved settings', async () => {
    saveSettings.mockResolvedValue({ assistantName: 'Jordan', maxExchanges: 6 });
    const res = await request(app)
      .post('/api/settings')
      .send({ assistantName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(res.body.assistantName).toBe('Jordan');
  });

  it('returns 400 on validation error', async () => {
    const err = new Error('assistantName must be at most 40 characters');
    err.isValidation = true;
    saveSettings.mockRejectedValue(err);
    const res = await request(app)
      .post('/api/settings')
      .send({ assistantName: 'x'.repeat(50) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assistantName/);
  });

  it('returns 500 on Redis error', async () => {
    saveSettings.mockRejectedValue(new Error('Redis timeout'));
    const res = await request(app)
      .post('/api/settings')
      .send({ assistantName: 'Test' });
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
npx jest tests/api/settings.test.js --no-coverage
```

Expected: FAIL — "Cannot find module '../../api/settings'"

- [ ] **Step 3: Create `api/settings.js`**

```javascript
const express = require('express');
const { getSettings, saveSettings } = require('../lib/settings');

const app = express();
app.use(express.json());

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    return res.status(200).json(settings);
  } catch (err) {
    console.error('[settings] getSettings error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const saved = await saveSettings(req.body || {});
    return res.status(200).json(saved);
  } catch (err) {
    if (err.isValidation) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[settings] saveSettings error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx jest tests/api/settings.test.js --no-coverage
```

Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add api/settings.js tests/api/settings.test.js
git commit -m "feat: add GET/POST /api/settings endpoints"
```

---

## Task 3: Wire settings into `lib/gemini.js`

**Files:**
- Modify: `lib/gemini.js`
- Modify: `tests/lib/gemini.test.js`

- [ ] **Step 1: Write failing tests**

Add a new describe block at the bottom of `tests/lib/gemini.test.js` — these verify that custom settings values actually appear in the prompts sent to Gemini:

```javascript
describe('settings values used in prompts', () => {
  beforeEach(() => mockGetGenerativeModel.mockClear());

  it('buildSystemPrompt uses assistantName from settings', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'ok' } });
    const threadWithTz = { ...mockThread, timezone: 'America/Chicago' };
    await getNextReply(threadWithTz, 'hello', { assistantName: 'Sam', tone: 'Be terse.', maxMessageLength: 120, maxExchanges: 4 });
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Sam');
    expect(systemInstruction).toContain('Be terse.');
    expect(systemInstruction).toContain('120');
    expect(systemInstruction).toContain('4');
  });

  it('getOrganizerInitialContactMessage uses assistantName and maxMessageLength', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Hi!' } });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['Mon'], 'Approve', { assistantName: 'Sam', maxMessageLength: 100 });
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Sam');
    expect(systemInstruction).toContain('100');
  });

  it('getOrganizerUpdateReply uses assistantName and maxMessageLength', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Hi!' } });
    await getOrganizerUpdateReply('Alice', 'Bob', 'Try 3pm', { assistantName: 'Sam', maxMessageLength: 100 });
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Sam');
    expect(systemInstruction).toContain('100');
  });

  it('getOrganizerApprovalDecision uses maxMessageLength in prompt', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '{"approved":true,"contactMsg":"ok","organizerAck":"ok"}' } });
    await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday 2pm', 'Yes', { maxMessageLength: 80 });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('80');
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```
npx jest tests/lib/gemini.test.js --no-coverage
```

Expected: 4 new tests FAIL — "Sam" not found in system instruction (old code still uses hardcoded "Alex")

- [ ] **Step 3: Update `lib/gemini.js`**

Replace the entire file with this:

```javascript
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function extractJson(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : text.trim();
}

function buildSystemPrompt(organizerName, contactName, directorAlternatives = [], timezone, settings = {}) {
  const tz = timezone || process.env.TIMEZONE || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const name   = settings.assistantName    || 'Alex';
  const tone   = settings.tone             || 'Be conversational and polite.';
  const maxLen = settings.maxMessageLength || 160;
  const maxEx  = settings.maxExchanges     || 6;
  const backupSection = directorAlternatives.length > 0
    ? ` The organizer has pre-approved these backup times: ${directorAlternatives.join(', ')}. Offer them if the contact declines the primary options.`
    : '';

  return `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under ${maxLen} characters. ${tone} Today's date is ${today} (timezone: ${tz}).${backupSection}

When the contact confirms one of the proposed or backup times, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}

If the contact proposes a completely different time (not one of the proposed or backup times), respond ONLY with this exact JSON and nothing else: {"status":"counter-proposal","suggestedTime":"<their suggestion in plain English>","suggestedDatetime":"YYYY-MM-DDTHH:mm:ss","reply":"<friendly message under ${maxLen} chars saying you will check with ${organizerName} and get back to them>"}

If they decline without proposing an alternative, suggest up to 2 options from the backup times (if any) or two new times at different times of day. After no more than ${maxEx} exchanges with no agreement, send a final message saying you will follow up another time.`;
}

async function getNextReply(thread, incomingMessage, settings = {}) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildSystemPrompt(thread.organizerName, thread.contactName, thread.directorAlternatives, thread.timezone, settings)
  });

  const mapped = thread.conversationHistory.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));
  const firstUser = mapped.findIndex(m => m.role === 'user');
  const history = firstUser === -1 ? [] : mapped.slice(firstUser);

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(incomingMessage);
  return result.response.text();
}

async function getOrganizerInitialContactMessage(organizerName, contactName, proposedTimes, organizerMessage, settings = {}) {
  const name   = settings.assistantName    || 'Alex';
  const maxLen = settings.maxMessageLength || 160;
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Keep all messages under ${maxLen} characters. Be warm and conversational — never robotic or template-like.`
  });

  const prompt = `${organizerName} originally proposed these times to meet with ${contactName}: ${proposedTimes.join(', ')}. The organizer just replied: "${organizerMessage}". Based on what the organizer said, write a brief, friendly SMS to ${contactName}: if the organizer approved the original times, ask which works; if the organizer suggested different or modified times, offer only those new times and ask if they work. Do not mention any times the organizer declined. Keep under ${maxLen} characters.`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

async function getOrganizerApprovalDecision(organizerName, contactName, pendingContactSuggestion, organizerMessage, settings = {}) {
  const maxLen = settings.maxMessageLength || 160;
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a scheduling assistant. Analyze an organizer's reply and determine whether they are approving a proposed meeting time or declining it.`
  });

  const prompt = `${contactName} proposed this meeting time: "${pendingContactSuggestion}". ${organizerName} replied: "${organizerMessage}".

Is ${organizerName} approving this specific time, or are they declining or suggesting something different?

Reply ONLY with this JSON (no markdown, no other text):
{"approved":true or false,"contactMsg":"<friendly SMS under ${maxLen} chars to ${contactName}>","organizerAck":"<friendly SMS under ${maxLen} chars acknowledging ${organizerName}>"}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    return JSON.parse(extractJson(text));
  } catch (_) {
    return {
      approved: false,
      contactMsg: `${organizerName} has an update on our scheduling — I'll be in touch shortly.`,
      organizerAck: `Got it! I'll follow up with ${contactName}.`
    };
  }
}

async function getOrganizerUpdateReply(organizerName, contactName, organizerMessage, settings = {}) {
  const name   = settings.assistantName    || 'Alex';
  const maxLen = settings.maxMessageLength || 160;
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Keep all messages under ${maxLen} characters. Be conversational and polite.`
  });
  const prompt = `${organizerName} just updated their availability and said: "${organizerMessage}". Write a brief, friendly SMS to ${contactName} sharing this update and asking if the new time works for them.`;
  const result = await model.generateContent(prompt);
  return result.response.text();
}

module.exports = { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply };
```

- [ ] **Step 4: Run all Gemini tests to verify they pass**

```
npx jest tests/lib/gemini.test.js --no-coverage
```

Expected: all tests PASS (existing tests still pass because `settings = {}` default means fallback to 'Alex', 160, etc.)

- [ ] **Step 5: Commit**

```bash
git add lib/gemini.js tests/lib/gemini.test.js
git commit -m "feat: gemini functions accept settings param for name, tone, limits"
```

---

## Task 4: Wire settings into `api/sms-reply.js`

**Files:**
- Modify: `api/sms-reply.js`
- Modify: `tests/api/sms-reply.test.js`

- [ ] **Step 1: Write failing tests**

Add to `tests/api/sms-reply.test.js` — at the top, add settings mock alongside existing mocks:

```javascript
// Add to the jest.mock block at the top (alongside existing mocks):
jest.mock('../../lib/settings', () => ({
  getSettings: jest.fn()
}));
```

Add import after existing imports:

```javascript
const { getSettings } = require('../../lib/settings');
```

Add to `beforeEach` in the top-level scope (add after existing beforeEach setups, or add a new global beforeEach):

```javascript
beforeEach(() => {
  getSettings.mockResolvedValue({
    assistantName: 'Alex',
    tone: 'Be conversational and polite.',
    maxMessageLength: 160,
    maxExchanges: 6,
    holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
    confirmationMessage: "Your meeting with {organizerName} is confirmed! You'll receive details soon."
  });
});
```

Add a new describe block for template substitution:

```javascript
describe('SMS template substitution', () => {
  it('substitutes {organizerName} in confirmationMessage', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch soon.",
      confirmationMessage: 'Your meeting with {organizerName} is set!'
    });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-06-01T14:00:00"}');
    const res = await post({ From: '+15551234567', Body: 'Monday works!' });
    expect(sendSms).not.toHaveBeenCalled(); // confirmation goes via TwiML
    expect(res.text).toContain('Alice'); // {organizerName} replaced with thread.organizerName
  });

  it('substitutes {contactName} and {organizerName} in holdingMessage', async () => {
    getThread.mockResolvedValue({ ...baseThread, status: 'waiting_organizer_initial' });
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: 'Hi {contactName}, {organizerName} will be in touch!',
      confirmationMessage: 'Confirmed!'
    });
    const res = await post({ From: '+15551234567', Body: 'Hello' });
    expect(res.text).toContain('Bob');
    expect(res.text).toContain('Alice');
  });
});
```

- [ ] **Step 2: Run new tests to verify they fail**

```
npx jest tests/api/sms-reply.test.js --no-coverage 2>&1 | tail -20
```

Expected: new template substitution tests FAIL; existing tests may also fail due to missing `getSettings` mock

- [ ] **Step 3: Update `api/sms-reply.js`**

Make the following changes to `api/sms-reply.js`:

**3a.** Add import at the top (after the existing requires):

```javascript
const { getSettings } = require('../lib/settings');
```

**3b.** Update `truncate` to accept an optional limit:

```javascript
function truncate(text, limit = 160) {
  return text.length > limit ? text.substring(0, limit - 3) + '...' : text;
}
```

**3c.** Add `applyTemplate` helper after `truncate`:

```javascript
function applyTemplate(template, vars) {
  return template
    .replace(/\{contactName\}/g, vars.contactName || '')
    .replace(/\{organizerName\}/g, vars.organizerName || '');
}
```

**3d.** Load settings at the top of the request handler and pass to sub-handlers. Replace the existing `app.post('/api/sms-reply', ...)` handler with:

```javascript
app.post('/api/sms-reply', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  const from = req.body.From;
  const incomingMessage = req.body.Body;

  let thread;
  try {
    thread = await getThread(from);
  } catch (err) {
    console.error('[sms-reply] getThread error:', err.message);
    return res.send('<Response></Response>');
  }

  if (!thread) {
    console.log(`[sms-reply] no thread for ${from}`);
    return res.send(twimlReply("Sorry, I don't have an active scheduling request for this number."));
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('[sms-reply] getSettings error (using defaults):', err.message);
    settings = {
      assistantName: 'Alex', tone: 'Be conversational and polite.',
      maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
      confirmationMessage: "Your meeting with {organizerName} is confirmed! You'll receive details soon."
    };
  }

  const role = thread.organizerPhone && from === thread.organizerPhone ? 'organizer' : 'contact';
  console.log(`[sms-reply] from=${from} role=${role} status=${thread.status} waitingApproval=${thread.waitingForOrganizerApproval} msg="${incomingMessage}"`);

  if (thread.status === 'confirmed') {
    console.log('[sms-reply] thread already confirmed, ignoring');
    return res.send('<Response></Response>');
  }

  if (thread.organizerPhone && from === thread.organizerPhone) {
    return handleOrganizerReply(thread, incomingMessage, res, settings);
  }
  return handleContactReply(thread, incomingMessage, res, settings);
});
```

**3e.** Update `handleContactReply` signature and body — replace the existing function:

```javascript
async function handleContactReply(thread, incomingMessage, res, settings) {
  if (thread.status === 'waiting_organizer_initial') {
    const msg = applyTemplate(settings.holdingMessage, {
      contactName: thread.contactName,
      organizerName: thread.organizerName
    });
    return res.send(twimlReply(msg));
  }

  try {
    const reply = await getNextReply(thread, incomingMessage, settings);
    console.log(`[sms-reply] gemini raw reply: ${reply}`);

    let parsed = null;
    try { parsed = JSON.parse(extractJson(reply)); } catch (_) {}
    console.log(`[sms-reply] parsed action: ${parsed?.status ?? 'conversational'}`);

    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.status = 'confirmed';
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      try {
        await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail, thread.timezone);
      } catch (calErr) {
        console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
      }
      await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, parsed.datetime);

      const confirmMsg = truncate(
        applyTemplate(settings.confirmationMessage, {
          contactName: thread.contactName,
          organizerName: thread.organizerName
        }),
        settings.maxMessageLength
      );
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveBoth(thread);

      return res.send(twimlReply(confirmMsg));

    } else if (parsed?.status === 'counter-proposal' && parsed?.suggestedTime) {
      thread.attempts += 1;
      thread.waitingForOrganizerApproval = true;
      thread.pendingContactSuggestion = parsed.suggestedTime;
      thread.pendingContactDatetime = parsed.suggestedDatetime || null;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      const holdingMsg = parsed.reply || `I'll check with ${thread.organizerName} and get back to you!`;
      const smsSafe = truncate(holdingMsg, settings.maxMessageLength);
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);

      if (thread.organizerPhone) {
        console.log(`[sms-reply] pinging organizer ${thread.organizerPhone} with counter-proposal`);
        const counterMsg = `${thread.contactName} suggests: ${parsed.suggestedTime}. Reply YES to approve or reply with alternative times.`;
        thread.organizerConversationHistory = thread.organizerConversationHistory || [];
        thread.organizerConversationHistory.push({ role: 'model', content: counterMsg });
        await saveBoth(thread);
        await sendSms(thread.organizerPhone, counterMsg);
      }

      return res.send(twimlReply(smsSafe));

    } else {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      const smsSafe = truncate(reply, settings.maxMessageLength);
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);
      return res.send(twimlReply(smsSafe));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing contact reply:', err.message);
    return res.send('<Response></Response>');
  }
}
```

**3f.** Update `handleOrganizerReply` signature — add `settings` as 4th param and thread it through:

```javascript
async function handleOrganizerReply(thread, incomingMessage, res, settings) {
  if (thread.status === 'waiting_organizer_initial') {
    return handleOrganizerInitialReview(thread, incomingMessage, res, settings);
  }

  if (!thread.waitingForOrganizerApproval) {
    try {
      thread.directorAlternatives = [...(thread.directorAlternatives || []), incomingMessage];
      const aiMsg = await getOrganizerUpdateReply(thread.organizerName, thread.contactName, incomingMessage, settings);
      const smsSafe = truncate(aiMsg, settings.maxMessageLength);
      const ackMsg = `Got it! I've let ${thread.contactName} know about your updated availability.`;
      pushOrganizerHistory(thread, incomingMessage, ackMsg);
      await saveBoth(thread);
      await sendSms(thread.contactPhone, smsSafe);
      console.log(`[sms-reply] organizer unsolicited update — AI reply sent to contact ${thread.contactPhone}: "${smsSafe}"`);
      return res.send(twimlReply(ackMsg));
    } catch (err) {
      console.error('[sms-reply] Error handling organizer availability update:', err.message);
      return res.send('<Response></Response>');
    }
  }

  try {
    const decision = await getOrganizerApprovalDecision(
      thread.organizerName, thread.contactName,
      thread.pendingContactSuggestion, incomingMessage, settings
    );

    console.log(`[sms-reply] organizer approval decision=${decision.approved}`);
    if (decision.approved) {
      thread.status = 'confirmed';
      thread.waitingForOrganizerApproval = false;

      if (thread.pendingContactDatetime) {
        try {
          await bookCalendarEvent(thread.pendingContactDatetime, thread.contactName, thread.organizerEmail, thread.timezone);
        } catch (calErr) {
          console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
        }
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactDatetime);
      } else {
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactSuggestion);
      }

      const confirmMsg = truncate(decision.contactMsg, settings.maxMessageLength);
      const orgAck = truncate(decision.organizerAck, settings.maxMessageLength);
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      pushOrganizerHistory(thread, incomingMessage, orgAck);
      await saveBoth(thread);

      await sendSms(thread.contactPhone, confirmMsg);
      return res.send(twimlReply(orgAck));

    } else {
      thread.waitingForOrganizerApproval = false;
      thread.pendingContactSuggestion = null;
      thread.pendingContactDatetime = null;
      thread.directorAlternatives = [...(thread.directorAlternatives || []), incomingMessage];

      const contactMsg = truncate(decision.contactMsg, settings.maxMessageLength);
      const orgAck = truncate(decision.organizerAck, settings.maxMessageLength);
      pushOrganizerHistory(thread, incomingMessage, orgAck);
      await saveBoth(thread);

      console.log(`[sms-reply] forwarding organizer response to contact ${thread.contactPhone}`);
      await sendSms(thread.contactPhone, contactMsg);
      return res.send(twimlReply(orgAck));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing organizer approval:', err.message);
    return res.send(twimlReply('Sorry, something went wrong on our end. Please try again.'));
  }
}
```

**3g.** Update `handleOrganizerInitialReview` signature — add `settings` as 4th param:

```javascript
async function handleOrganizerInitialReview(thread, incomingMessage, res, settings) {
  try {
    const aiMsg = await getOrganizerInitialContactMessage(
      thread.organizerName, thread.contactName,
      thread.proposedTimes, incomingMessage, settings
    );
    const smsBody = truncate(aiMsg, settings.maxMessageLength);

    const reply = `Got it! I've reached out to ${thread.contactName} with your availability.`;

    thread.status = 'pending';
    thread.conversationHistory.push({ role: 'model', content: smsBody });
    pushOrganizerHistory(thread, incomingMessage, reply);
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

- [ ] **Step 4: Run the full test suite**

```
npx jest --no-coverage
```

Expected: all tests PASS (new template substitution tests + all existing tests)

- [ ] **Step 5: Commit**

```bash
git add api/sms-reply.js tests/api/sms-reply.test.js
git commit -m "feat: load settings per request, apply SMS templates, pass to Gemini"
```

---

## Task 5: Frontend settings panel

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add CSS for the settings button, backdrop, and slide-in panel**

In `public/index.html`, add the following CSS inside the `<style>` block, just before the closing `</style>` tag (around line 522):

```css
    /* ── Settings panel ─────────────────────────────────────────────────── */
    .settings-btn {
      background: none;
      border: 1.5px solid #d1d1d6;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 0.8rem;
      font-weight: 500;
      color: #555;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .settings-btn:hover { background: #f5f5f7; }

    .settings-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.3);
      z-index: 99;
    }
    .settings-backdrop.open { display: block; }

    .settings-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 360px;
      max-width: 100vw;
      background: #fff;
      box-shadow: -4px 0 24px rgba(0,0,0,0.12);
      z-index: 100;
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.25s ease;
      overflow-y: auto;
    }
    .settings-panel.open { transform: translateX(0); }

    .settings-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px 16px;
      border-bottom: 1px solid #e5e5ea;
      position: sticky;
      top: 0;
      background: #fff;
      z-index: 1;
    }
    .settings-panel-title { font-size: 1rem; font-weight: 700; color: #111; }
    .settings-close-btn {
      background: none;
      border: none;
      font-size: 1.25rem;
      color: #888;
      cursor: pointer;
      line-height: 1;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .settings-close-btn:hover { background: #f5f5f7; color: #111; }

    .settings-panel-body { padding: 20px 24px; flex: 1; }

    .settings-section-label {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #888;
      margin: 0 0 10px;
    }
    .settings-section-label + * { }
    .settings-section { margin-bottom: 24px; }

    .settings-field { margin-bottom: 14px; }
    .settings-field label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: #333;
      margin-bottom: 4px;
    }
    .settings-field .hint {
      font-size: 0.72rem;
      color: #888;
      margin: 3px 0 0;
    }
    .settings-field input,
    .settings-field textarea {
      width: 100%;
      border: 1.5px solid #d1d1d6;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 0.85rem;
      font-family: inherit;
      color: #111;
      background: #fff;
      resize: vertical;
    }
    .settings-field input:focus,
    .settings-field textarea:focus {
      outline: none;
      border-color: #007aff;
    }
    .settings-field input[type="number"] { width: 90px; }

    .settings-panel-footer {
      padding: 16px 24px;
      border-top: 1px solid #e5e5ea;
      position: sticky;
      bottom: 0;
      background: #fff;
    }
    .settings-save-btn {
      width: 100%;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 11px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
    }
    .settings-save-btn:hover { background: #333; }
    .settings-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
```

- [ ] **Step 2: Wrap the h1 and add the ⚙ button**

Find this in `public/index.html` (around line 528):

```html
<div class="card">
  <h1>SMS Scheduling</h1>
  <p class="subtitle">Send an AI-powered scheduling request via SMS</p>
```

Replace with:

```html
<div class="card">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
    <h1 style="margin-bottom:0">SMS Scheduling</h1>
    <button type="button" id="openSettingsBtn" class="settings-btn">⚙ Settings</button>
  </div>
  <p class="subtitle">Send an AI-powered scheduling request via SMS</p>
```

- [ ] **Step 3: Add panel and backdrop HTML**

Find the closing `</div><!-- /.workspace -->` tag at the very end of the body (last line before `</body>`) and add the panel and backdrop just before it:

```html
<!-- ── Settings backdrop ── -->
<div class="settings-backdrop" id="settingsBackdrop"></div>

<!-- ── Settings panel ── -->
<div class="settings-panel" id="settingsPanel" role="dialog" aria-label="AI Settings">
  <div class="settings-panel-header">
    <span class="settings-panel-title">AI Settings</span>
    <button type="button" class="settings-close-btn" id="closeSettingsBtn" aria-label="Close">✕</button>
  </div>

  <div class="settings-panel-body">

    <div class="settings-section">
      <p class="settings-section-label">AI Behavior</p>

      <div class="settings-field">
        <label for="s_assistantName">Assistant name</label>
        <input type="text" id="s_assistantName" maxlength="40" />
      </div>

      <div class="settings-field">
        <label for="s_tone">Tone / personality</label>
        <textarea id="s_tone" rows="3" maxlength="300"></textarea>
        <p class="hint">Describe the assistant's voice, e.g. "Be warm, concise, and professional."</p>
      </div>

      <div class="settings-field">
        <label for="s_maxMessageLength">Max message length (chars)</label>
        <input type="number" id="s_maxMessageLength" min="50" max="320" />
      </div>

      <div class="settings-field">
        <label for="s_maxExchanges">Max exchanges before giving up</label>
        <input type="number" id="s_maxExchanges" min="2" max="20" />
      </div>
    </div>

    <div class="settings-section">
      <p class="settings-section-label">SMS Templates</p>

      <div class="settings-field">
        <label for="s_holdingMessage">Holding message</label>
        <textarea id="s_holdingMessage" rows="3" maxlength="320"></textarea>
        <p class="hint">Sent to the contact while waiting for organizer review. Supports {contactName} and {organizerName}.</p>
      </div>

      <div class="settings-field">
        <label for="s_confirmationMessage">Confirmation message</label>
        <textarea id="s_confirmationMessage" rows="3" maxlength="320"></textarea>
        <p class="hint">Sent to the contact when the meeting is confirmed. Supports {contactName} and {organizerName}.</p>
      </div>
    </div>

  </div>

  <div class="settings-panel-footer">
    <button type="button" class="settings-save-btn" id="saveSettingsBtn">Save settings</button>
  </div>
</div>
```

- [ ] **Step 4: Add the settings panel JavaScript**

Find the closing `</script>` tag in `public/index.html` (the last one, near the bottom) and add the following JS just before it:

```javascript
  // ── Settings panel ─────────────────────────────────────────────────────
  function openSettings() {
    document.getElementById('settingsPanel').classList.add('open');
    document.getElementById('settingsBackdrop').classList.add('open');
    loadSettings();
  }

  function closeSettings() {
    document.getElementById('settingsPanel').classList.remove('open');
    document.getElementById('settingsBackdrop').classList.remove('open');
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const s = await res.json();
      document.getElementById('s_assistantName').value      = s.assistantName      ?? '';
      document.getElementById('s_tone').value               = s.tone               ?? '';
      document.getElementById('s_maxMessageLength').value   = s.maxMessageLength   ?? 160;
      document.getElementById('s_maxExchanges').value       = s.maxExchanges       ?? 6;
      document.getElementById('s_holdingMessage').value     = s.holdingMessage     ?? '';
      document.getElementById('s_confirmationMessage').value = s.confirmationMessage ?? '';
    } catch (_) {}
  }

  async function saveSettings() {
    const btn = document.getElementById('saveSettingsBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const body = {
        assistantName:       document.getElementById('s_assistantName').value.trim(),
        tone:                document.getElementById('s_tone').value.trim(),
        maxMessageLength:    parseInt(document.getElementById('s_maxMessageLength').value, 10),
        maxExchanges:        parseInt(document.getElementById('s_maxExchanges').value, 10),
        holdingMessage:      document.getElementById('s_holdingMessage').value.trim(),
        confirmationMessage: document.getElementById('s_confirmationMessage').value.trim()
      };
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Settings saved!', 'success');
        closeSettings();
      } else {
        showToast(data.error || 'Failed to save settings.', 'error');
      }
    } catch (_) {
      showToast('Could not reach the server.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save settings';
    }
  }

  document.getElementById('openSettingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsBackdrop').addEventListener('click', closeSettings);
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
```

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```
npx jest --no-coverage
```

Expected: all tests PASS (frontend changes don't affect backend tests)

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "feat: add settings slide-in panel with AI behavior and SMS template fields"
```

---

## Task 6: Final — run full suite and push

- [ ] **Step 1: Run the complete test suite**

```
npx jest --no-coverage
```

Expected: all tests PASS

- [ ] **Step 2: Push to GitHub**

```bash
git push origin master
```

---

## Self-Review

**Spec coverage:**
- ✅ `lib/settings.js` with DEFAULTS, `getSettings`, `saveSettings`, validation — Task 1
- ✅ `api/settings.js` GET + POST — Task 2
- ✅ Gemini functions accept `settings` — Task 3
- ✅ `applyTemplate()` helper — Task 4
- ✅ `truncate` uses `settings.maxMessageLength` — Task 4
- ✅ Holding message template — Task 4
- ✅ Confirmation message template — Task 4
- ✅ Settings load per request; fallback to defaults on error — Task 4
- ✅ ⚙ button in header — Task 5
- ✅ Slide-in panel with backdrop — Task 5
- ✅ Two sections (AI Behavior / SMS Templates) — Task 5
- ✅ Fetch on open, POST on save, toast on success — Task 5
- ✅ `{contactName}` / `{organizerName}` placeholder hint text — Task 5
- ✅ Tests: `tests/lib/settings.test.js`, `tests/api/settings.test.js`, gemini + sms-reply updates — Tasks 1–4

**Placeholder scan:** No TBDs or "implement later" patterns.

**Type consistency:** `getSettings()` returns the full settings object; `saveSettings(partial)` accepts partial; all Gemini functions use `settings = {}` default; `handleContactReply`, `handleOrganizerReply`, `handleOrganizerInitialReview` all receive `settings` as 4th param consistently.
