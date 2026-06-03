# Multi-Thread Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-thread-per-phone Redis model with a per-appointment thread model that supports multiple concurrent contacts per organizer, multiple organizers, and an organizer disambiguation flow with persistent routing state.

**Architecture:** Each thread is stored at `thread:{threadId}` in Redis. Phone numbers index into threads via `phone:{phone}` → `[threadId, ...]`. When an organizer has multiple active threads and texts in, we store their pending message at `pending:{phone}` and reply with a numbered disambiguation list; the list persists until all referenced threads are resolved. Every organizer-bound SMS includes a `[ContactName | context]` prelude. The `/api/conversation` endpoint switches to threadId-keyed lookup.

**Tech Stack:** Node.js, Express, Jest + supertest, `@upstash/redis` via `@upstash/redis` npm package, Twilio TwiML

---

## File Map

| File | Change |
|------|--------|
| `lib/kv.js` | Add `getThreadById`, `saveThreadById`, `getPhoneIndex`, `setPhoneIndex`, `addToPhoneIndex`, `removeFromPhoneIndex`, `getPendingMessage`, `setPendingMessage`, `deletePendingMessage` |
| `api/initiate.js` | Replace `saveThread(phone, thread)` pair with `saveThreadById` + `addToPhoneIndex` |
| `api/conversation.js` | Support `?threadId=` lookup via `getThreadById`; keep `?phone=` as fallback |
| `api/sms-reply.js` | Replace `getThread`/`saveBoth` with multi-thread lookup; add organizer disambiguation routing; add organizer message preludes |
| `public/index.html` | Poll `/api/conversation?threadId=` instead of `?phone=` |
| `tests/lib/kv.test.js` | Full rewrite for new functions |
| `tests/api/initiate.test.js` | Update mocks and assertions for `saveThreadById` + `addToPhoneIndex` |
| `tests/api/conversation.test.js` | Add threadId-keyed tests; update mock |
| `tests/api/sms-reply.test.js` | Update mock setup; add disambiguation and prelude tests |

---

## Task 1: Add new `lib/kv.js` functions

**Files:**
- Modify: `lib/kv.js`
- Test: `tests/lib/kv.test.js`

- [ ] **Step 1: Write failing tests for new kv functions**

Replace the entire contents of `tests/lib/kv.test.js` with:

```js
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => ({ get: mockGet, set: mockSet, del: mockDel }))
}));

process.env.KV_REST_API_URL = 'https://test.upstash.io';
process.env.KV_REST_API_TOKEN = 'test-token';

const {
  getThreadById, saveThreadById,
  getPhoneIndex, addToPhoneIndex, removeFromPhoneIndex,
  getPendingMessage, setPendingMessage, deletePendingMessage,
  getThread, saveThread, deleteThread
} = require('../../lib/kv');

const TTL = 60 * 60 * 24 * 7;

beforeEach(() => { mockGet.mockClear(); mockSet.mockClear(); mockDel.mockClear(); });

describe('getThreadById / saveThreadById', () => {
  it('getThreadById calls redis.get with thread:{id}', async () => {
    mockGet.mockResolvedValue({ threadId: 'abc-123' });
    const result = await getThreadById('abc-123');
    expect(mockGet).toHaveBeenCalledWith('thread:abc-123');
    expect(result).toEqual({ threadId: 'abc-123' });
  });

  it('getThreadById returns null when not found', async () => {
    mockGet.mockResolvedValue(null);
    expect(await getThreadById('missing')).toBeNull();
  });

  it('saveThreadById calls redis.set with thread:{id}, data, and 7-day TTL', async () => {
    mockSet.mockResolvedValue('OK');
    const thread = { threadId: 'abc-123', status: 'pending' };
    await saveThreadById('abc-123', thread);
    expect(mockSet).toHaveBeenCalledWith('thread:abc-123', thread, { ex: TTL });
  });
});

describe('phone index', () => {
  it('getPhoneIndex returns empty array when no index exists', async () => {
    mockGet.mockResolvedValue(null);
    const result = await getPhoneIndex('+15551234567');
    expect(mockGet).toHaveBeenCalledWith('phone:+15551234567');
    expect(result).toEqual([]);
  });

  it('getPhoneIndex returns stored array', async () => {
    mockGet.mockResolvedValue(['uuid-1', 'uuid-2']);
    expect(await getPhoneIndex('+15551234567')).toEqual(['uuid-1', 'uuid-2']);
  });

  it('addToPhoneIndex appends threadId to existing index', async () => {
    mockGet.mockResolvedValue(['uuid-1']);
    mockSet.mockResolvedValue('OK');
    await addToPhoneIndex('+15551234567', 'uuid-2');
    expect(mockSet).toHaveBeenCalledWith('phone:+15551234567', ['uuid-1', 'uuid-2']);
  });

  it('addToPhoneIndex creates new index when none exists', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');
    await addToPhoneIndex('+15551234567', 'uuid-1');
    expect(mockSet).toHaveBeenCalledWith('phone:+15551234567', ['uuid-1']);
  });

  it('addToPhoneIndex does not add duplicate threadId', async () => {
    mockGet.mockResolvedValue(['uuid-1']);
    await addToPhoneIndex('+15551234567', 'uuid-1');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('removeFromPhoneIndex removes the threadId', async () => {
    mockGet.mockResolvedValue(['uuid-1', 'uuid-2', 'uuid-3']);
    mockSet.mockResolvedValue('OK');
    await removeFromPhoneIndex('+15551234567', 'uuid-2');
    expect(mockSet).toHaveBeenCalledWith('phone:+15551234567', ['uuid-1', 'uuid-3']);
  });

  it('removeFromPhoneIndex deletes key when index becomes empty', async () => {
    mockGet.mockResolvedValue(['uuid-1']);
    mockDel.mockResolvedValue(1);
    await removeFromPhoneIndex('+15551234567', 'uuid-1');
    expect(mockDel).toHaveBeenCalledWith('phone:+15551234567');
  });
});

describe('pending message', () => {
  it('getPendingMessage returns stored message', async () => {
    mockGet.mockResolvedValue('Yes, Friday works');
    expect(await getPendingMessage('+15550009999')).toBe('Yes, Friday works');
    expect(mockGet).toHaveBeenCalledWith('pending:+15550009999');
  });

  it('getPendingMessage returns null when none stored', async () => {
    mockGet.mockResolvedValue(null);
    expect(await getPendingMessage('+15550009999')).toBeNull();
  });

  it('setPendingMessage stores message without TTL', async () => {
    mockSet.mockResolvedValue('OK');
    await setPendingMessage('+15550009999', 'Yes, Friday works');
    expect(mockSet).toHaveBeenCalledWith('pending:+15550009999', 'Yes, Friday works');
  });

  it('deletePendingMessage removes the key', async () => {
    mockDel.mockResolvedValue(1);
    await deletePendingMessage('+15550009999');
    expect(mockDel).toHaveBeenCalledWith('pending:+15550009999');
  });
});

describe('legacy helpers', () => {
  it('getThread calls redis.get with phone number directly', async () => {
    mockGet.mockResolvedValue({ threadId: 'abc' });
    await getThread('+15551234567');
    expect(mockGet).toHaveBeenCalledWith('+15551234567');
  });

  it('saveThread calls redis.set with phone, data, and 7-day TTL', async () => {
    mockSet.mockResolvedValue('OK');
    await saveThread('+15551234567', { threadId: 'abc' });
    expect(mockSet).toHaveBeenCalledWith('+15551234567', { threadId: 'abc' }, { ex: TTL });
  });

  it('deleteThread calls redis.del with phone number', async () => {
    mockDel.mockResolvedValue(1);
    await deleteThread('+15551234567');
    expect(mockDel).toHaveBeenCalledWith('+15551234567');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test tests/lib/kv.test.js
```

Expected: FAIL — `getThreadById is not a function`

- [ ] **Step 3: Implement new functions in `lib/kv.js`**

Replace the entire file:

```js
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const THREAD_TTL_SECONDS = 60 * 60 * 24 * 7;

async function getThreadById(threadId) {
  return await redis.get(`thread:${threadId}`);
}

async function saveThreadById(threadId, thread) {
  await redis.set(`thread:${threadId}`, thread, { ex: THREAD_TTL_SECONDS });
}

async function getPhoneIndex(phone) {
  const ids = await redis.get(`phone:${phone}`);
  return Array.isArray(ids) ? ids : [];
}

async function setPhoneIndex(phone, ids) {
  if (ids.length === 0) {
    await redis.del(`phone:${phone}`);
  } else {
    await redis.set(`phone:${phone}`, ids);
  }
}

async function addToPhoneIndex(phone, threadId) {
  const ids = await getPhoneIndex(phone);
  if (!ids.includes(threadId)) {
    await setPhoneIndex(phone, [...ids, threadId]);
  }
}

async function removeFromPhoneIndex(phone, threadId) {
  const ids = await getPhoneIndex(phone);
  await setPhoneIndex(phone, ids.filter(id => id !== threadId));
}

async function getPendingMessage(phone) {
  return await redis.get(`pending:${phone}`);
}

async function setPendingMessage(phone, message) {
  await redis.set(`pending:${phone}`, message);
}

async function deletePendingMessage(phone) {
  await redis.del(`pending:${phone}`);
}

// Legacy — kept during migration; removed in Task 8
async function getThread(phone) {
  return await redis.get(phone);
}

async function saveThread(phone, thread) {
  await redis.set(phone, thread, { ex: THREAD_TTL_SECONDS });
}

async function deleteThread(phone) {
  await redis.del(phone);
}

module.exports = {
  getThreadById, saveThreadById,
  getPhoneIndex, setPhoneIndex, addToPhoneIndex, removeFromPhoneIndex,
  getPendingMessage, setPendingMessage, deletePendingMessage,
  getThread, saveThread, deleteThread
};
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm test tests/lib/kv.test.js
```

Expected: PASS — all 18 tests green

- [ ] **Step 5: Commit**

```
git add lib/kv.js tests/lib/kv.test.js
git commit -m "feat: add multi-thread kv functions (getThreadById, phone index, pending message)"
```

---

## Task 2: Update `api/initiate.js` to new storage model

**Files:**
- Modify: `api/initiate.js`
- Test: `tests/api/initiate.test.js`

- [ ] **Step 1: Write failing tests**

In `tests/api/initiate.test.js`, replace the kv mock and its import:

```js
// Old:
jest.mock('../../lib/kv', () => ({
  saveThread: jest.fn().mockResolvedValue(undefined)
}));
const { saveThread } = require('../../lib/kv');

// New:
jest.mock('../../lib/kv', () => ({
  saveThreadById: jest.fn().mockResolvedValue(undefined),
  addToPhoneIndex: jest.fn().mockResolvedValue(undefined)
}));
const { saveThreadById, addToPhoneIndex } = require('../../lib/kv');
```

Then replace every assertion that references `saveThread` with the new pattern. Find each `expect(saveThread).toHaveBeenCalledWith(phone, ...)` and split it into two assertions:

```js
// Old:
expect(saveThread).toHaveBeenCalledWith('+15551234567', expect.objectContaining({ status: 'pending' }));

// New:
expect(saveThreadById).toHaveBeenCalledWith('test-uuid-1234', expect.objectContaining({ status: 'pending' }));
expect(addToPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid-1234');
```

For the branch that saves under organizer phone too, add:
```js
expect(addToPhoneIndex).toHaveBeenCalledWith('+15550009999', 'test-uuid-1234');
```

The test "saves thread under organizer phone too" becomes:
```js
it('adds organizer phone to phone index', async () => {
  await request(app).post('/api/initiate').send(body);
  expect(addToPhoneIndex).toHaveBeenCalledWith('+15550009999', 'test-uuid-1234');
});
```

The `beforeEach` cleanup blocks that call `saveThread.mockClear()` should be updated to clear both mocks:
```js
beforeEach(() => {
  saveThreadById.mockClear();
  addToPhoneIndex.mockClear();
  sendSms.mockClear();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test tests/api/initiate.test.js
```

Expected: FAIL — `saveThreadById is not a function`

- [ ] **Step 3: Update `api/initiate.js`**

Change the import at the top:
```js
// Old:
const { saveThread } = require('../lib/kv');

// New:
const { saveThreadById, addToPhoneIndex } = require('../lib/kv');
```

Replace the three save patterns:

**Branch C (waiting_organizer_initial):**
```js
// Old:
await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);

// New:
await saveThreadById(thread.threadId, thread);
await Promise.all([
  addToPhoneIndex(normalizedContactPhone, thread.threadId),
  addToPhoneIndex(normalizedOrganizerPhone, thread.threadId)
]);
```

**Branch B (organizer + backup times):**
```js
// Old:
await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);

// New:
await saveThreadById(thread.threadId, thread);
await Promise.all([
  addToPhoneIndex(normalizedContactPhone, thread.threadId),
  addToPhoneIndex(normalizedOrganizerPhone, thread.threadId)
]);
```

**Branch A (no organizer phone):**
```js
// Old:
await saveThread(normalizedContactPhone, thread);

// New:
await saveThreadById(thread.threadId, thread);
await addToPhoneIndex(normalizedContactPhone, thread.threadId);
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm test tests/api/initiate.test.js
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```
npm test
```

Expected: all suites pass (sms-reply and conversation tests still use legacy `getThread` mock — that's fine until later tasks)

- [ ] **Step 6: Commit**

```
git add api/initiate.js tests/api/initiate.test.js
git commit -m "feat: initiate saves threads by threadId and indexes by phone"
```

---

## Task 3: Update `api/conversation.js` to threadId lookup

**Files:**
- Modify: `api/conversation.js`
- Test: `tests/api/conversation.test.js`

- [ ] **Step 1: Write failing tests**

Replace the kv mock in `tests/api/conversation.test.js`:

```js
// Old:
jest.mock('../../lib/kv', () => ({ getThread: jest.fn() }));
const { getThread } = require('../../lib/kv');

// New:
jest.mock('../../lib/kv', () => ({
  getThreadById: jest.fn(),
  getThread: jest.fn()
}));
const { getThreadById, getThread } = require('../../lib/kv');
```

Add these new tests inside the describe block (the existing phone-based tests continue to pass since we keep `?phone=` as fallback):

```js
it('returns 400 when neither threadId nor phone is provided', async () => {
  const res = await request(app).get('/api/conversation');
  expect(res.status).toBe(400);
});

it('looks up thread by threadId when ?threadId= is provided', async () => {
  getThreadById.mockResolvedValue({ ...mockThread });
  const res = await request(app).get('/api/conversation?threadId=abc-123');
  expect(getThreadById).toHaveBeenCalledWith('abc-123');
  expect(res.status).toBe(200);
  expect(res.body.found).toBe(true);
});

it('returns 404 when threadId not found', async () => {
  getThreadById.mockResolvedValue(null);
  const res = await request(app).get('/api/conversation?threadId=unknown');
  expect(res.status).toBe(404);
  expect(res.body.found).toBe(false);
});

it('threadId lookup takes priority over phone when both are provided', async () => {
  getThreadById.mockResolvedValue({ ...mockThread });
  const res = await request(app).get('/api/conversation?threadId=abc-123&phone=+15551234567');
  expect(getThreadById).toHaveBeenCalledWith('abc-123');
  expect(getThread).not.toHaveBeenCalled();
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npm test tests/api/conversation.test.js
```

Expected: 4 new tests FAIL

- [ ] **Step 3: Update `api/conversation.js`**

```js
const express = require('express');
const { getThreadById, getThread } = require('../lib/kv');

const app = express();
app.use(express.json());

app.get('/api/conversation', async (req, res) => {
  const threadId = req.query.threadId;
  const raw = req.query.phone || '';
  const phone = raw.startsWith(' ') ? '+' + raw.slice(1).trim() : raw.trim();

  if (!threadId && !phone) {
    return res.status(400).json({ error: 'Missing ?threadId= or ?phone= query parameter' });
  }

  let thread;
  try {
    if (threadId) {
      thread = await getThreadById(threadId);
    } else {
      thread = await getThread(phone);
    }
  } catch (err) {
    console.error('[conversation] lookup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!thread) {
    return res.status(404).json({ found: false, ...(threadId ? { threadId } : { phone }) });
  }

  return res.status(200).json({
    found: true,
    status:                       thread.status,
    waitingForOrganizerApproval:  thread.waitingForOrganizerApproval || false,
    contactName:                  thread.contactName,
    contactPhone:                 thread.contactPhone,
    organizerName:                thread.organizerName,
    organizerPhone:               thread.organizerPhone || null,
    conversationHistory:          thread.conversationHistory || [],
    organizerConversationHistory: thread.organizerConversationHistory || []
  });
});

module.exports = app;
```

- [ ] **Step 4: Run tests**

```
npm test tests/api/conversation.test.js
```

Expected: all pass

- [ ] **Step 5: Commit**

```
git add api/conversation.js tests/api/conversation.test.js
git commit -m "feat: conversation endpoint supports ?threadId= lookup"
```

---

## Task 4: Refactor `api/sms-reply.js` — thread loading, role detection, saveBoth

**Files:**
- Modify: `api/sms-reply.js`
- Test: `tests/api/sms-reply.test.js`

This task replaces the single `getThread(from)` lookup with multi-thread loading and simplifies `saveBoth` to a single write.

- [ ] **Step 1: Update the kv mock in `tests/api/sms-reply.test.js`**

```js
// Old mock:
jest.mock('../../lib/kv', () => ({
  getThread: jest.fn(),
  saveThread: jest.fn().mockResolvedValue(undefined)
}));
const { getThread } = require('../../lib/kv');

// New mock:
jest.mock('../../lib/kv', () => ({
  getThreadById: jest.fn(),
  saveThreadById: jest.fn().mockResolvedValue(undefined),
  getPhoneIndex: jest.fn(),
  addToPhoneIndex: jest.fn().mockResolvedValue(undefined),
  removeFromPhoneIndex: jest.fn().mockResolvedValue(undefined),
  getPendingMessage: jest.fn().mockResolvedValue(null),
  setPendingMessage: jest.fn().mockResolvedValue(undefined),
  deletePendingMessage: jest.fn().mockResolvedValue(undefined)
}));
const { getThreadById, saveThreadById, getPhoneIndex, removeFromPhoneIndex,
        getPendingMessage, setPendingMessage, deletePendingMessage } = require('../../lib/kv');
```

Add a helper at the top of the test file (after imports):

```js
// Helper: simulate a single active thread for a given phone
function setupThread(thread) {
  getPhoneIndex.mockResolvedValue([thread.threadId]);
  getThreadById.mockResolvedValue({ ...thread });
}
```

Replace every `getThread.mockResolvedValue({ ...baseThread })` with `setupThread({ ...baseThread })`.

Replace every `getThread.mockResolvedValue(null)` (the "no thread" case) with:
```js
getPhoneIndex.mockResolvedValue([]);
```

Replace every reference to `saveThread` in assertions:
```js
// Old:
const { saveThread } = require('../../lib/kv');
saveThread.mockClear();
// ...
expect(saveThread).toHaveBeenCalledWith('+15551234567', expect.objectContaining({ ... }));

// New:
saveThreadById.mockClear();
// ...
expect(saveThreadById).toHaveBeenCalledWith('test-uuid', expect.objectContaining({ ... }));
```

Note: `saveThreadById` is now called once per `saveBoth` (not twice). Remove any assertions that checked the organizer phone key save — `saveBoth` now writes only by threadId.

- [ ] **Step 2: Write new failing tests for index cleanup on confirm**

Add inside `describe('contact messages — standard flow', () => {`:

```js
it('removes thread from phone index for contact and organizer on confirmation', async () => {
  setupThread({ ...baseThread });
  getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
  await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
  expect(removeFromPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid');
  expect(removeFromPhoneIndex).toHaveBeenCalledWith('+15550009999', 'test-uuid');
});
```

- [ ] **Step 3: Run tests to confirm failures**

```
npm test tests/api/sms-reply.test.js
```

Expected: most tests fail because `getThread` is no longer mocked

- [ ] **Step 4: Update `api/sms-reply.js` — imports**

```js
// Old:
const { getThread, saveThread } = require('../lib/kv');

// New:
const {
  getThreadById, saveThreadById,
  getPhoneIndex, removeFromPhoneIndex,
  getPendingMessage, setPendingMessage, deletePendingMessage
} = require('../lib/kv');
```

- [ ] **Step 5: Add `loadActiveThreadsForPhone` helper**

Add after the existing helper functions (after `lastModelMsg`):

```js
async function loadActiveThreadsForPhone(phone) {
  const ids = await getPhoneIndex(phone);
  if (ids.length === 0) return [];
  const results = await Promise.all(ids.map(id => getThreadById(id)));
  // Prune expired (null) entries from index lazily
  const expiredIds = ids.filter((_, i) => results[i] === null);
  if (expiredIds.length > 0) {
    await Promise.all(expiredIds.map(id => removeFromPhoneIndex(phone, id)));
  }
  return results.filter(t => t !== null && t.status !== 'confirmed');
}
```

- [ ] **Step 6: Update `saveBoth` to single write + auto-remove on confirm**

```js
async function saveBoth(thread) {
  thread.lastActivityAt = new Date().toISOString();
  await saveThreadById(thread.threadId, thread);
  if (thread.status === 'confirmed') {
    await removeFromPhoneIndex(thread.contactPhone, thread.threadId);
    if (thread.organizerPhone) await removeFromPhoneIndex(thread.organizerPhone, thread.threadId);
  }
}
```

- [ ] **Step 7: Update the main `/api/sms-reply` handler**

Replace the existing thread-loading block (the `getThread` call and no-thread check) with:

```js
app.post('/api/sms-reply', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  const from = req.body.From;
  const incomingMessage = req.body.Body;

  let activeThreads;
  try {
    activeThreads = await loadActiveThreadsForPhone(from);
  } catch (err) {
    console.error('[sms-reply] loadActiveThreadsForPhone error:', err.message);
    return res.send('<Response></Response>');
  }

  if (activeThreads.length === 0) {
    console.log(`[sms-reply] no active threads for ${from}`);
    // Clean up any stale pending message
    await deletePendingMessage(from).catch(() => {});
    return res.send(twimlReply("Sorry, I don't have an active scheduling request for this number."));
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('[sms-reply] getSettings error (using defaults):', err.message);
    settings = { ...DEFAULTS };
  }

  // Role detection: organizer if this phone is the organizerPhone in any active thread
  const isOrganizer = activeThreads.some(t => t.organizerPhone === from);

  if (isOrganizer) {
    const orgThreads = activeThreads.filter(t => t.organizerPhone === from);
    console.log(`[sms-reply] from=${from} role=organizer activeOrgThreads=${orgThreads.length} msg="${incomingMessage}"`);
    return handleOrganizerRouting(from, incomingMessage, res, settings, orgThreads);
  }

  // Contact: pick most recently active thread
  const thread = activeThreads.sort(
    (a, b) => new Date(b.lastActivityAt || b.createdAt) - new Date(a.lastActivityAt || a.createdAt)
  )[0];

  console.log(`[sms-reply] from=${from} role=contact status=${thread.status} waitingApproval=${thread.waitingForOrganizerApproval} msg="${incomingMessage}"`);

  if (thread.status === 'confirmed') {
    console.log('[sms-reply] thread already confirmed, ignoring');
    return res.send('<Response></Response>');
  }

  return handleContactReply(thread, incomingMessage, res, settings);
});
```

- [ ] **Step 8: Run tests**

```
npm test tests/api/sms-reply.test.js
```

Expected: all existing tests pass; new index cleanup test passes

- [ ] **Step 9: Run full suite**

```
npm test
```

Expected: all suites pass

- [ ] **Step 10: Commit**

```
git add api/sms-reply.js tests/api/sms-reply.test.js
git commit -m "feat: sms-reply loads threads by phone index, saveBoth writes single threadId key"
```

---

## Task 5: Organizer disambiguation routing

**Files:**
- Modify: `api/sms-reply.js`
- Test: `tests/api/sms-reply.test.js`

Replace the current `handleOrganizerReply` dispatch (the `if (isOrganizer)` branch added in Task 4) with a full multi-thread routing function.

- [ ] **Step 1: Write failing tests**

Add a new describe block in `tests/api/sms-reply.test.js`:

```js
describe('organizer multi-thread routing', () => {
  const thread1 = {
    ...baseThread,
    threadId: 'uuid-1',
    contactName: 'Bob Smith',
    waitingForOrganizerApproval: true,
    pendingContactSuggestion: 'Friday May 30 at 2pm',
    pendingContactDatetime: '2026-05-30T14:00:00'
  };
  const thread2 = {
    ...baseThread,
    threadId: 'uuid-2',
    contactName: 'Jane Doe',
    status: 'waiting_organizer_initial',
    proposedTimes: ['Mon Jun 2 at 10am', 'Tue Jun 3 at 3pm']
  };

  beforeEach(() => {
    saveThreadById.mockClear();
    getPendingMessage.mockResolvedValue(null);
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: true,
      contactMsg: 'Meeting confirmed!',
      organizerAck: "Confirmed! I've let Bob know."
    });
    getOrganizerInitialContactMessage.mockResolvedValue('Hi Jane! Alice can do Mon Jun 2 or Tue Jun 3 — which works?');
  });

  it('auto-routes to the single waiting thread without disambiguation', async () => {
    getPhoneIndex.mockResolvedValue(['uuid-1']);
    getThreadById.mockResolvedValue({ ...thread1 });
    await post({ From: '+15550009999', Body: 'Yes that works' });
    expect(getOrganizerApprovalDecision).toHaveBeenCalled();
    expect(setPendingMessage).not.toHaveBeenCalled();
  });

  it('sends disambiguation list when 2 threads are waiting', async () => {
    getPhoneIndex.mockResolvedValue(['uuid-1', 'uuid-2']);
    getThreadById
      .mockResolvedValueOnce({ ...thread1 })
      .mockResolvedValueOnce({ ...thread2 });
    const res = await post({ From: '+15550009999', Body: 'Yes that works' });
    expect(setPendingMessage).toHaveBeenCalledWith('+15550009999', 'Yes that works');
    expect(res.text).toContain('Bob Smith');
    expect(res.text).toContain('Jane Doe');
    expect(res.text).toContain('1.');
    expect(res.text).toContain('2.');
  });

  it('routes pending message to selected thread when organizer replies with number', async () => {
    getPendingMessage.mockResolvedValue('Yes that works');
    getPhoneIndex.mockResolvedValue(['uuid-1', 'uuid-2']);
    getThreadById
      .mockResolvedValueOnce({ ...thread1 })
      .mockResolvedValueOnce({ ...thread2 });
    await post({ From: '+15550009999', Body: '1' });
    expect(deletePendingMessage).toHaveBeenCalledWith('+15550009999');
    expect(getOrganizerApprovalDecision).toHaveBeenCalled();
  });

  it('re-shows disambiguation list on invalid selection', async () => {
    getPendingMessage.mockResolvedValue('Yes that works');
    getPhoneIndex.mockResolvedValue(['uuid-1', 'uuid-2']);
    getThreadById
      .mockResolvedValueOnce({ ...thread1 })
      .mockResolvedValueOnce({ ...thread2 });
    const res = await post({ From: '+15550009999', Body: '9' });
    expect(deletePendingMessage).not.toHaveBeenCalled();
    expect(res.text).toContain('Bob Smith');
    expect(res.text).toContain('Jane Doe');
  });

  it('shows all active threads when none are waiting (unsolicited update)', async () => {
    const pendingThread = { ...baseThread, threadId: 'uuid-1', contactName: 'Bob Smith' };
    const pendingThread2 = { ...baseThread, threadId: 'uuid-2', contactName: 'Jane Doe' };
    getPhoneIndex.mockResolvedValue(['uuid-1', 'uuid-2']);
    getThreadById
      .mockResolvedValueOnce(pendingThread)
      .mockResolvedValueOnce(pendingThread2);
    getOrganizerUpdateReply.mockResolvedValue("Hi! Alice updated availability.");
    const res = await post({ From: '+15550009999', Body: "I'm free Thursday instead" });
    expect(setPendingMessage).toHaveBeenCalledWith('+15550009999', "I'm free Thursday instead");
    expect(res.text).toContain('Bob Smith');
    expect(res.text).toContain('Jane Doe');
  });

  it('auto-routes unsolicited update when only one active thread exists', async () => {
    getPhoneIndex.mockResolvedValue(['uuid-1']);
    getThreadById.mockResolvedValue({ ...baseThread, threadId: 'uuid-1' });
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is free Thursday instead.");
    await post({ From: '+15550009999', Body: "I'm free Thursday instead" });
    expect(getOrganizerUpdateReply).toHaveBeenCalled();
    expect(setPendingMessage).not.toHaveBeenCalled();
  });

  it('disambiguation list includes pending time for waitingForOrganizerApproval threads', async () => {
    getPhoneIndex.mockResolvedValue(['uuid-1', 'uuid-2']);
    getThreadById
      .mockResolvedValueOnce({ ...thread1 })
      .mockResolvedValueOnce({ ...thread2 });
    const res = await post({ From: '+15550009999', Body: 'Yes' });
    expect(res.text).toContain('Friday May 30 at 2pm');
  });

  it('disambiguation list includes proposed times for waiting_organizer_initial threads', async () => {
    getPhoneIndex.mockResolvedValue(['uuid-1', 'uuid-2']);
    getThreadById
      .mockResolvedValueOnce({ ...thread1 })
      .mockResolvedValueOnce({ ...thread2 });
    const res = await post({ From: '+15550009999', Body: 'Yes' });
    expect(res.text).toContain('Mon Jun 2 at 10am');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm test tests/api/sms-reply.test.js -- --testNamePattern="organizer multi-thread"
```

Expected: all 8 new tests FAIL

- [ ] **Step 3: Add helpers to `api/sms-reply.js`**

Add after the `loadActiveThreadsForPhone` function:

```js
function buildDisambiguationList(threads) {
  const items = threads.map((t, i) => {
    let context;
    if (t.waitingForOrganizerApproval) {
      context = `approving: ${t.pendingContactSuggestion}`;
    } else if (t.status === 'waiting_organizer_initial') {
      context = `initial review — proposed: ${(t.proposedTimes || []).join(', ')}`;
    } else {
      const lastMsg = (t.directorMessages || []).slice(-1)[0];
      context = lastMsg
        ? `last update: ${lastMsg}`
        : `pending — proposed: ${(t.proposedTimes || []).join(', ')}`;
    }
    return `${i + 1}. ${t.contactName} — ${context}`;
  });
  return `You have ${threads.length} active conversations. Which are you responding to?\n${items.join('\n')}`;
}
```

- [ ] **Step 4: Add `handleOrganizerRouting` to `api/sms-reply.js`**

Add this function (before the existing `handleOrganizerReply`):

```js
async function handleOrganizerRouting(organizerPhone, incomingMessage, res, settings, orgThreads) {
  const pendingMsg = await getPendingMessage(organizerPhone);

  const waitingThreads = orgThreads.filter(
    t => t.status === 'waiting_organizer_initial' || t.waitingForOrganizerApproval
  );

  // Mid-disambiguation: organizer is selecting from a previously shown list
  if (pendingMsg !== null) {
    const listThreads = waitingThreads.length >= 2 ? waitingThreads : orgThreads;
    const num = parseInt(incomingMessage.trim(), 10);
    if (num >= 1 && num <= listThreads.length) {
      await deletePendingMessage(organizerPhone);
      return handleOrganizerReply(listThreads[num - 1], pendingMsg, res, settings);
    }
    // Invalid selection — re-show list
    return res.send(twimlReply(buildDisambiguationList(listThreads)));
  }

  // 1 waiting → auto-route
  if (waitingThreads.length === 1) {
    return handleOrganizerReply(waitingThreads[0], incomingMessage, res, settings);
  }

  // 2+ waiting → disambiguation
  if (waitingThreads.length >= 2) {
    await setPendingMessage(organizerPhone, incomingMessage);
    return res.send(twimlReply(buildDisambiguationList(waitingThreads)));
  }

  // 0 waiting: unsolicited update
  if (orgThreads.length === 1) {
    // Only one active thread — route directly
    return handleOrganizerReply(orgThreads[0], incomingMessage, res, settings);
  }

  // Multiple active, none waiting — disambiguation across all active
  await setPendingMessage(organizerPhone, incomingMessage);
  return res.send(twimlReply(buildDisambiguationList(orgThreads)));
}
```

- [ ] **Step 5: Run tests**

```
npm test tests/api/sms-reply.test.js
```

Expected: all tests pass

- [ ] **Step 6: Run full suite**

```
npm test
```

Expected: all suites pass

- [ ] **Step 7: Commit**

```
git add api/sms-reply.js tests/api/sms-reply.test.js
git commit -m "feat: organizer disambiguation routing with persistent pending message"
```

---

## Task 6: Organizer message preludes

Every SMS sent TO the organizer (outbound via `demoSendSms`) should begin with `[ContactName | context]` so the organizer immediately knows which scheduling conversation the message is about.

**Files:**
- Modify: `api/initiate.js`
- Modify: `api/sms-reply.js`
- Test: `tests/api/initiate.test.js`
- Test: `tests/api/sms-reply.test.js`

- [ ] **Step 1: Write failing tests**

In `tests/api/initiate.test.js`, add inside `describe('POST /api/initiate — organizer phone, no backup times')`:

```js
it('organizer initial review SMS includes contact name prelude', async () => {
  const body = { ...base, organizerPhone: '+15550009999' };
  await request(app).post('/api/initiate').send(body);
  expect(sendSms).toHaveBeenCalledWith('+15550009999',
    expect.stringMatching(/^\[Bob/)
  );
});
```

In `tests/api/initiate.test.js`, add inside `describe('POST /api/initiate — organizer phone + backup times')`:

```js
it('organizer FYI SMS includes contact name prelude', async () => {
  const body = { ...base, organizerPhone: '+15550009999', directorAlternatives: ['Wed at 3pm'] };
  await request(app).post('/api/initiate').send(body);
  expect(sendSms).toHaveBeenCalledWith('+15550009999',
    expect.stringMatching(/^\[Bob/)
  );
});
```

In `tests/api/sms-reply.test.js`, add inside `describe('contact messages — standard flow')`:

```js
it('counter-proposal ping to organizer includes contact name prelude', async () => {
  setupThread({ ...baseThread });
  getNextReply.mockResolvedValue(JSON.stringify({
    status: 'counter-proposal',
    suggestedTime: 'Friday May 22 at 2pm',
    suggestedDatetime: '2026-05-22T14:00:00',
    reply: "I'll check with Alice and get back to you!"
  }));
  await post({ From: '+15551234567', Body: 'Can I do Friday?' });
  expect(sendSms).toHaveBeenCalledWith('+15550009999',
    expect.stringMatching(/^\[Bob/)
  );
});

it('confirmation SMS to organizer includes contact name prelude', async () => {
  setupThread({ ...baseThread });
  getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
  await post({ From: '+15551234567', Body: 'Monday works!' });
  expect(sendSms).toHaveBeenCalledWith('+15550009999',
    expect.stringMatching(/^\[Bob/)
  );
});
```

- [ ] **Step 2: Run to confirm they fail**

```
npm test tests/api/initiate.test.js tests/api/sms-reply.test.js -- --testNamePattern="prelude"
```

Expected: 4 new tests FAIL

- [ ] **Step 3: Add `orgPrelude` helper to `api/sms-reply.js`**

Add after the `worksQ` helper:

```js
function orgPrelude(contactName, context) {
  return `[${contactName} | ${context}] `;
}
```

- [ ] **Step 4: Apply prelude in `api/sms-reply.js`**

**Counter-proposal ping** (in `handleContactReply`):
```js
// Old:
const counterMsg = `${thread.contactName} suggests: ${parsed.suggestedTime}. Reply YES to approve or reply with alternative times.`;

// New:
const counterMsg = orgPrelude(thread.contactName, `pending: ${parsed.suggestedTime}`) +
  `${thread.contactName} suggests: ${parsed.suggestedTime}. Reply YES to approve or reply with alternative times.`;
```

**Confirmation notification to organizer** (in `handleContactReply`):
```js
// Old:
const orgConfirmMsg = truncate(
  `${thread.contactName} confirmed! Meeting on ${formatConfirmedTime(parsed.datetime)}.`,
  settings.maxMessageLength
);

// New:
const orgConfirmMsg = orgPrelude(thread.contactName, `confirmed: ${formatConfirmedTime(parsed.datetime)}`) +
  `Meeting confirmed for ${formatConfirmedTime(parsed.datetime)}.`;
```

**Confirmation notification when organizer approves counter-proposal** (in `handleOrganizerReply`):

The confirmation is sent to the contact via `demoSendSms(thread.contactPhone, confirmMsg)` — no prelude needed there.
The organizer gets `twimlReply(orgAck)` which is already contextual. No change needed.

- [ ] **Step 5: Add `orgPrelude` helper to `api/initiate.js`**

Add after the `worksQ` helper in `api/initiate.js`:

```js
function orgPrelude(contactName, context) {
  return `[${contactName} | ${context}] `;
}
```

- [ ] **Step 6: Apply prelude in `api/initiate.js`**

**Branch C — initial review ping to organizer:**
```js
// Old:
const smsBody = truncate(
  `${contactName} wants to schedule. Proposed ${timeWord(n)}: ${listTimes(proposedTimes)}. Reply to confirm or suggest different times.`
);

// New:
const smsBody = truncate(
  orgPrelude(contactName, `proposed: ${listTimes(proposedTimes)}`) +
  `${contactName} wants to schedule. Proposed ${timeWord(n)}: ${listTimes(proposedTimes)}. Reply to confirm or suggest different times.`
);
```

**Branch B — FYI to organizer:**
```js
// Old:
const orgFyi = truncate(
  `Scheduling started with ${contactName}. I've sent them your available ${timeWord(n)} and will let you know when confirmed.`
);

// New:
const orgFyi = truncate(
  orgPrelude(contactName, `proposed: ${listTimes(backupTimes)}`) +
  `Scheduling started with ${contactName}. I've sent them your available ${timeWord(n)} and will let you know when confirmed.`
);
```

- [ ] **Step 7: Run tests**

```
npm test tests/api/initiate.test.js tests/api/sms-reply.test.js
```

Expected: all tests pass

- [ ] **Step 8: Run full suite**

```
npm test
```

Expected: all suites pass

- [ ] **Step 9: Commit**

```
git add api/initiate.js api/sms-reply.js tests/api/initiate.test.js tests/api/sms-reply.test.js
git commit -m "feat: add [ContactName | context] prelude to all organizer-bound SMS"
```

---

## Task 7: Update `public/index.html` to poll by threadId

The frontend currently polls `/api/conversation?phone=...`. Since `/api/initiate` already returns `threadId` in its response, the frontend can poll by threadId directly — more accurate and faster when a contact has multiple threads.

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Find the polling code**

In `public/index.html`, locate the `pollConversation` function and the `startPolling` call. The current polling URL looks like:

```js
const res = await fetch(`/api/conversation?phone=${encodeURIComponent(currentContactPhone)}`);
```

- [ ] **Step 2: Add threadId storage and update polling URL**

Add a module-level variable alongside `currentContactPhone`:
```js
let currentThreadId = null;
```

In the `startPolling` function, add a `threadId` parameter and store it:
```js
function startPolling(contactPhone, organizerPhone, threadId) {
  currentContactPhone = contactPhone;
  activeOrganizerPhone = organizerPhone;
  currentThreadId = threadId;
  // ... rest of existing polling setup
}
```

Update the fetch URL in `pollConversation`:
```js
// Old:
const url = `/api/conversation?phone=${encodeURIComponent(currentContactPhone)}`;

// New:
const url = currentThreadId
  ? `/api/conversation?threadId=${encodeURIComponent(currentThreadId)}`
  : `/api/conversation?phone=${encodeURIComponent(currentContactPhone)}`;
```

In the form submission handler where `startPolling` is called, pass the threadId from the initiate response:
```js
// After: const data = await res.json();
startPolling(contactPhone, organizerPhone, data.threadId);
```

- [ ] **Step 3: Manually verify in browser**

Start the dev server (`npm start` or `node server.js`), submit a scheduling form, confirm the conversation log still polls and updates correctly.

- [ ] **Step 4: Commit**

```
git add public/index.html
git commit -m "feat: conversation log polls by threadId instead of phone"
```

---

## Task 8: Remove legacy kv functions

With all callers updated, remove the deprecated `getThread`, `saveThread`, `deleteThread` from `lib/kv.js`.

**Files:**
- Modify: `lib/kv.js`
- Modify: `tests/lib/kv.test.js`

- [ ] **Step 1: Confirm no remaining callers**

```
grep -r "getThread\b" api/ lib/ public/ --include="*.js"
grep -r "saveThread\b" api/ lib/ public/ --include="*.js"
```

Expected: zero matches (only test files may still reference them — those will be cleaned up here)

- [ ] **Step 2: Remove legacy tests from `tests/lib/kv.test.js`**

Delete the entire `describe('legacy helpers', ...)` block.

- [ ] **Step 3: Remove legacy functions from `lib/kv.js`**

Delete the three legacy functions and their entries from `module.exports`:

```js
// DELETE these:
async function getThread(phone) { ... }
async function saveThread(phone, thread) { ... }
async function deleteThread(phone) { ... }

// UPDATE module.exports to remove: getThread, saveThread, deleteThread
module.exports = {
  getThreadById, saveThreadById,
  getPhoneIndex, setPhoneIndex, addToPhoneIndex, removeFromPhoneIndex,
  getPendingMessage, setPendingMessage, deletePendingMessage
};
```

- [ ] **Step 4: Run full test suite**

```
npm test
```

Expected: all tests pass; no references to legacy functions remain

- [ ] **Step 5: Commit**

```
git add lib/kv.js tests/lib/kv.test.js
git commit -m "chore: remove legacy getThread/saveThread/deleteThread from kv.js"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|-------------|------|
| Each appointment gets its own Redis thread | Task 1, 2 |
| Phone → [threadId] index | Task 1, 2 |
| Contact multi-thread routing (most recent) | Task 4 |
| Organizer auto-route when 1 waiting | Task 5 |
| Organizer disambiguation list when 2+ waiting | Task 5 |
| Disambiguation list shows contact + context + times | Task 5 |
| Persistent pending message (no TTL) | Task 1, 5 |
| Pending message cleared on selection | Task 5 |
| Pending message cleared when all threads resolved | Task 4 (saveBoth + loadActive) |
| Remove thread from index on confirmation | Task 4 |
| Organizer message prelude [Name \| context] | Task 6 |
| Prelude on counter-proposal ping | Task 6 |
| Prelude on confirmation notification | Task 6 |
| Prelude on initial review ping | Task 6 |
| Prelude on organizer FYI | Task 6 |
| `/api/conversation` threadId lookup | Task 3 |
| Frontend polls by threadId | Task 7 |
| Legacy kv functions removed | Task 8 |

No gaps found.
