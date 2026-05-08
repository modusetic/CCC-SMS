# SMS Scheduling Automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a demo-ready SMS scheduling automation that uses AI to negotiate meeting times via text message, then books the confirmed time in Google Calendar and emails the organizer.

**Architecture:** Three Vercel serverless functions handle the scheduling lifecycle. A `/api/initiate` endpoint creates a thread in Vercel KV and fires the first SMS. Inbound replies hit `/api/sms-reply`, which passes the conversation to Gemini 1.5 Flash and either continues negotiating or triggers calendar booking and organizer email when a time is confirmed. All external API interactions are wrapped in helper modules under `lib/`.

**Tech Stack:** Node.js, Express, Vercel (serverless), Twilio SMS, Google Gemini 1.5 Flash (`@google/generative-ai`), Vercel KV (`@vercel/kv`), Google Calendar API (`googleapis`), Nodemailer + Gmail SMTP, Jest + Supertest

---

## File Map

| File | Role |
|------|------|
| `package.json` | Dependencies and scripts |
| `jest.config.js` | Jest test configuration |
| `vercel.json` | Vercel deployment config |
| `.env.example` | Environment variable template |
| `lib/kv.js` | Vercel KV read/write helpers |
| `lib/twilio.js` | Twilio SMS send helper |
| `lib/calendar.js` | Google Calendar event booking |
| `lib/email.js` | Nodemailer organizer email |
| `lib/gemini.js` | Gemini AI conversation helper |
| `api/health.js` | GET /api/health — uptime check |
| `api/initiate.js` | POST /api/initiate — start scheduling thread |
| `api/sms-reply.js` | POST /api/sms-reply — Twilio webhook handler |
| `tests/lib/kv.test.js` | Unit tests for KV helpers |
| `tests/lib/twilio.test.js` | Unit tests for Twilio helper |
| `tests/lib/calendar.test.js` | Unit tests for calendar helper |
| `tests/lib/email.test.js` | Unit tests for email helper |
| `tests/lib/gemini.test.js` | Unit tests for Gemini helper |
| `tests/api/health.test.js` | Integration test for health endpoint |
| `tests/api/initiate.test.js` | Integration test for initiate endpoint |
| `tests/api/sms-reply.test.js` | Integration test for sms-reply endpoint |
| `README.md` | Setup and deployment instructions |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `jest.config.js`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "ccc-sms-scheduling",
  "version": "1.0.0",
  "description": "SMS scheduling automation with AI negotiation",
  "scripts": {
    "dev": "vercel dev",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "@vercel/kv": "^2.0.0",
    "express": "^4.19.0",
    "googleapis": "^144.0.0",
    "nodemailer": "^6.9.0",
    "twilio": "^5.3.0",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^6.3.0"
  }
}
```

- [ ] **Step 2: Create jest.config.js**

```javascript
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  clearMocks: true
};
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created with no errors, `package-lock.json` generated.

- [ ] **Step 4: Commit**

```bash
git init
git add package.json jest.config.js package-lock.json
git commit -m "feat: initialize project with dependencies"
```

---

### Task 2: Environment and Deployment Config

**Files:**
- Create: `.env.example`
- Create: `vercel.json`

- [ ] **Step 1: Create .env.example**

```
# Twilio — SMS sending and receiving
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX

# Google Gemini — AI conversation
GEMINI_API_KEY=your_gemini_api_key_here

# Google Service Account — Calendar booking
# Paste the entire JSON as a single-line string (minify with: jq -c . credentials.json)
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"..."}

# Google Calendar — which calendar to book events on
GOOGLE_CALENDAR_ID=your_calendar_id@group.calendar.google.com

# Gmail SMTP — organizer notification emails
GMAIL_USER=your_gmail_address@gmail.com
GMAIL_APP_PASSWORD=xxxx_xxxx_xxxx_xxxx

# Vercel KV — thread state persistence
KV_REST_API_URL=https://your-kv-instance.kv.vercel-storage.com
KV_REST_API_TOKEN=your_kv_token_here
```

- [ ] **Step 2: Create vercel.json**

```json
{
  "version": 2
}
```

Vercel auto-detects `/api/*.js` files as serverless functions. No additional routing config is needed.

- [ ] **Step 3: Commit**

```bash
git add .env.example vercel.json
git commit -m "feat: add environment template and vercel config"
```

---

### Task 3: Vercel KV Helper

**Files:**
- Create: `lib/kv.js`
- Create: `tests/lib/kv.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/kv.test.js`:

```javascript
jest.mock('@vercel/kv', () => ({
  kv: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn()
  }
}));

const { kv } = require('@vercel/kv');
const { getThread, saveThread, deleteThread } = require('../../lib/kv');

describe('KV helpers', () => {
  it('getThread calls kv.get with phone number', async () => {
    kv.get.mockResolvedValue({ threadId: 'abc-123' });
    const result = await getThread('+15551234567');
    expect(kv.get).toHaveBeenCalledWith('+15551234567');
    expect(result).toEqual({ threadId: 'abc-123' });
  });

  it('getThread returns null when no thread exists', async () => {
    kv.get.mockResolvedValue(null);
    const result = await getThread('+15550000000');
    expect(result).toBeNull();
  });

  it('saveThread calls kv.set with phone and thread data', async () => {
    kv.set.mockResolvedValue('OK');
    const thread = { threadId: 'abc-123', status: 'pending' };
    await saveThread('+15551234567', thread);
    expect(kv.set).toHaveBeenCalledWith('+15551234567', thread);
  });

  it('deleteThread calls kv.del with phone number', async () => {
    kv.del.mockResolvedValue(1);
    await deleteThread('+15551234567');
    expect(kv.del).toHaveBeenCalledWith('+15551234567');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/kv.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../lib/kv'`

- [ ] **Step 3: Implement lib/kv.js**

Create `lib/kv.js`:

```javascript
const { kv } = require('@vercel/kv');

async function getThread(phone) {
  return await kv.get(phone);
}

async function saveThread(phone, thread) {
  await kv.set(phone, thread);
}

async function deleteThread(phone) {
  await kv.del(phone);
}

module.exports = { getThread, saveThread, deleteThread };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/kv.test.js --no-coverage`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/kv.js tests/lib/kv.test.js
git commit -m "feat: add Vercel KV thread state helpers"
```

---

### Task 4: Twilio SMS Helper

**Files:**
- Create: `lib/twilio.js`
- Create: `tests/lib/twilio.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/twilio.test.js`:

```javascript
const mockCreate = jest.fn();

jest.mock('twilio', () => {
  return jest.fn(() => ({
    messages: { create: mockCreate }
  }));
});

process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.TWILIO_PHONE_NUMBER = '+15550000000';

const { sendSms } = require('../../lib/twilio');

describe('sendSms', () => {
  it('creates a Twilio message with correct params', async () => {
    mockCreate.mockResolvedValue({ sid: 'SM123' });
    const sid = await sendSms('+15551234567', 'Hello, test message!');
    expect(mockCreate).toHaveBeenCalledWith({
      body: 'Hello, test message!',
      from: '+15550000000',
      to: '+15551234567'
    });
    expect(sid).toBe('SM123');
  });

  it('throws when Twilio create fails', async () => {
    mockCreate.mockRejectedValue(new Error('Twilio error'));
    await expect(sendSms('+15551234567', 'Hi')).rejects.toThrow('Twilio error');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/twilio.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../lib/twilio'`

- [ ] **Step 3: Implement lib/twilio.js**

Create `lib/twilio.js`:

```javascript
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSms(to, body) {
  const message = await client.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to
  });
  return message.sid;
}

module.exports = { sendSms };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/twilio.test.js --no-coverage`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/twilio.js tests/lib/twilio.test.js
git commit -m "feat: add Twilio SMS send helper"
```

---

### Task 5: Google Calendar Helper

**Files:**
- Create: `lib/calendar.js`
- Create: `tests/lib/calendar.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/calendar.test.js`:

```javascript
const mockInsert = jest.fn();
const mockAuth = {};

jest.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => mockAuth)
    },
    calendar: jest.fn(() => ({
      events: { insert: mockInsert }
    }))
  }
}));

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project'
});
process.env.GOOGLE_CALENDAR_ID = 'test@group.calendar.google.com';

const { bookCalendarEvent } = require('../../lib/calendar');

describe('bookCalendarEvent', () => {
  it('creates a calendar event with correct title and description', async () => {
    mockInsert.mockResolvedValue({
      data: { id: 'event-abc', htmlLink: 'https://calendar.google.com/event?id=abc' }
    });

    const result = await bookCalendarEvent(
      '2026-05-12T14:00:00',
      'Jane Doe',
      'organizer@example.com'
    );

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'test@group.calendar.google.com',
        resource: expect.objectContaining({
          summary: 'Meeting with Jane Doe',
          description: 'Scheduled via SMS automation.',
          start: expect.objectContaining({ dateTime: expect.any(String) }),
          end: expect.objectContaining({ dateTime: expect.any(String) })
        })
      })
    );
    expect(result).toEqual({ id: 'event-abc', htmlLink: 'https://calendar.google.com/event?id=abc' });
  });

  it('sets end time exactly 30 minutes after start time', async () => {
    mockInsert.mockResolvedValue({ data: { id: 'event-xyz' } });

    await bookCalendarEvent('2026-05-12T14:00:00', 'John', 'org@example.com');

    const call = mockInsert.mock.calls[0][0];
    const start = new Date(call.resource.start.dateTime);
    const end = new Date(call.resource.end.dateTime);
    expect(end - start).toBe(30 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/calendar.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../lib/calendar'`

- [ ] **Step 3: Implement lib/calendar.js**

Create `lib/calendar.js`:

```javascript
const { google } = require('googleapis');

async function bookCalendarEvent(datetime, contactName, organizerEmail) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  const calendar = google.calendar({ version: 'v3', auth });

  const start = new Date(datetime);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: {
      summary: `Meeting with ${contactName}`,
      description: 'Scheduled via SMS automation.',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [{ email: organizerEmail }]
    }
  });

  return response.data;
}

module.exports = { bookCalendarEvent };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/calendar.test.js --no-coverage`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/calendar.js tests/lib/calendar.test.js
git commit -m "feat: add Google Calendar event booking helper"
```

---

### Task 6: Organizer Email Helper

**Files:**
- Create: `lib/email.js`
- Create: `tests/lib/email.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/email.test.js`:

```javascript
const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({
  createTransport: mockCreateTransport
}));

process.env.GMAIL_USER = 'sender@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'testpassword';

const { sendOrganizerEmail } = require('../../lib/email');

describe('sendOrganizerEmail', () => {
  it('creates Gmail transporter with correct credentials', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'msg-123' });
    await sendOrganizerEmail('org@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00');
    expect(mockCreateTransport).toHaveBeenCalledWith({
      service: 'gmail',
      auth: { user: 'sender@gmail.com', pass: 'testpassword' }
    });
  });

  it('sends email to organizer mentioning contact name and SMS automation', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'msg-456' });
    await sendOrganizerEmail('org@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00');

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.to).toBe('org@example.com');
    expect(mailOptions.subject).toContain('Bob');
    expect(mailOptions.text).toContain('Alice');
    expect(mailOptions.text).toContain('Bob');
    expect(mailOptions.text).toContain('SMS automation');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/email.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../lib/email'`

- [ ] **Step 3: Implement lib/email.js**

Create `lib/email.js`:

```javascript
const nodemailer = require('nodemailer');

async function sendOrganizerEmail(organizerEmail, organizerName, contactName, confirmedDatetime) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  const date = new Date(confirmedDatetime).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: organizerEmail,
    subject: `Meeting Confirmed: ${contactName}`,
    text: `Hi ${organizerName},\n\n${contactName} has confirmed a meeting with you.\n\nDate & Time: ${date}\n\nThis meeting was scheduled via SMS automation.\n\nBest,\nAlex (SMS Scheduling Assistant)`
  });
}

module.exports = { sendOrganizerEmail };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/email.test.js --no-coverage`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/email.js tests/lib/email.test.js
git commit -m "feat: add Nodemailer organizer email helper"
```

---

### Task 7: Gemini AI Conversation Helper

**Files:**
- Create: `lib/gemini.js`
- Create: `tests/lib/gemini.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/gemini.test.js`:

```javascript
const mockSendMessage = jest.fn();
const mockStartChat = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockGetGenerativeModel = jest.fn(() => ({ startChat: mockStartChat }));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(() => ({
    getGenerativeModel: mockGetGenerativeModel
  }))
}));

process.env.GEMINI_API_KEY = 'test-api-key';

const { getNextReply } = require('../../lib/gemini');

const mockThread = {
  organizerName: 'Alice',
  contactName: 'Bob',
  conversationHistory: [
    { role: 'model', content: 'Hi Bob! Available: Monday at 2pm. Which works?' },
    { role: 'user', content: 'Monday works for me!' }
  ]
};

describe('getNextReply', () => {
  it('initializes model with gemini-1.5-flash and system prompt containing organizer name', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Great, confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-1.5-flash',
        systemInstruction: expect.stringContaining('Alice')
      })
    );
  });

  it('passes conversation history in Gemini format to startChat', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    expect(mockStartChat).toHaveBeenCalledWith({
      history: [
        { role: 'model', parts: [{ text: 'Hi Bob! Available: Monday at 2pm. Which works?' }] },
        { role: 'user', parts: [{ text: 'Monday works for me!' }] }
      ]
    });
  });

  it('sends the incoming message via sendMessage', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    expect(mockSendMessage).toHaveBeenCalledWith('Monday works!');
  });

  it('returns the text response from Gemini', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Sounds great!' } });
    const reply = await getNextReply(mockThread, 'Monday at 2pm');
    expect(reply).toBe('Sounds great!');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/gemini.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../lib/gemini'`

- [ ] **Step 3: Implement lib/gemini.js**

Create `lib/gemini.js`:

```javascript
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function buildSystemPrompt(organizerName, contactName) {
  return `You are a friendly scheduling assistant named Alex working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under 160 characters. Be conversational and polite. If the contact proposes an alternative time, accept it gracefully. If they decline without proposing an alternative, suggest two new options at different times of day. After no more than 6 exchanges, if no time is agreed, send a final message saying you will follow up another time. When a specific time is confirmed by the contact, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}`;
}

async function getNextReply(thread, incomingMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: buildSystemPrompt(thread.organizerName, thread.contactName)
  });

  const history = thread.conversationHistory.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(incomingMessage);
  return result.response.text();
}

module.exports = { getNextReply };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/gemini.test.js --no-coverage`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/gemini.js tests/lib/gemini.test.js
git commit -m "feat: add Gemini 1.5 Flash conversation helper"
```

---

### Task 8: Health Check Endpoint

**Files:**
- Create: `api/health.js`
- Create: `tests/api/health.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/health.test.js`:

```javascript
const request = require('supertest');
const app = require('../../api/health');

describe('GET /api/health', () => {
  it('returns 200 with status ok and a valid ISO timestamp', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/health.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../api/health'`

- [ ] **Step 3: Implement api/health.js**

Create `api/health.js`:

```javascript
const express = require('express');
const app = express();

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/api/health.test.js --no-coverage`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add api/health.js tests/api/health.test.js
git commit -m "feat: add /api/health endpoint"
```

---

### Task 9: Initiate Endpoint

**Files:**
- Create: `api/initiate.js`
- Create: `tests/api/initiate.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/initiate.test.js`:

```javascript
const request = require('supertest');

jest.mock('../../lib/kv', () => ({
  saveThread: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../lib/twilio', () => ({
  sendSms: jest.fn().mockResolvedValue('SM123')
}));

jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

const { saveThread } = require('../../lib/kv');
const { sendSms } = require('../../lib/twilio');
const app = require('../../api/initiate');

const validBody = {
  contactName: 'Bob',
  contactPhone: '+15551234567',
  organizerName: 'Alice',
  organizerEmail: 'alice@example.com',
  proposedTimes: ['Monday May 12 at 2pm', 'Tuesday May 13 at 10am']
};

describe('POST /api/initiate', () => {
  it('returns 200 with threadId on valid input', async () => {
    const res = await request(app).post('/api/initiate').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.threadId).toBe('test-uuid-1234');
    expect(res.body.message).toBe('Scheduling initiated');
  });

  it('saves thread to KV with correct schema fields', async () => {
    await request(app).post('/api/initiate').send(validBody);
    expect(saveThread).toHaveBeenCalledWith(
      '+15551234567',
      expect.objectContaining({
        threadId: 'test-uuid-1234',
        contactName: 'Bob',
        contactPhone: '+15551234567',
        organizerName: 'Alice',
        organizerEmail: 'alice@example.com',
        proposedTimes: ['Monday May 12 at 2pm', 'Tuesday May 13 at 10am'],
        status: 'pending',
        attempts: 0,
        conversationHistory: expect.any(Array),
        createdAt: expect.any(String)
      })
    );
  });

  it('sends the first SMS via Twilio containing contact name', async () => {
    await request(app).post('/api/initiate').send(validBody);
    expect(sendSms).toHaveBeenCalledWith(
      '+15551234567',
      expect.stringContaining('Bob')
    );
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/initiate')
      .send({ contactName: 'Bob' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when proposedTimes is an empty array', async () => {
    const res = await request(app)
      .post('/api/initiate')
      .send({ ...validBody, proposedTimes: [] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/initiate.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../api/initiate'`

- [ ] **Step 3: Implement api/initiate.js**

Create `api/initiate.js`:

```javascript
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { saveThread } = require('../lib/kv');
const { sendSms } = require('../lib/twilio');

const app = express();
app.use(express.json());

app.post('/api/initiate', async (req, res) => {
  const { contactName, contactPhone, organizerName, organizerEmail, proposedTimes } = req.body;

  if (!contactName || !contactPhone || !organizerName || !organizerEmail || !proposedTimes?.length) {
    return res.status(400).json({
      error: 'Missing required fields: contactName, contactPhone, organizerName, organizerEmail, proposedTimes (non-empty array)'
    });
  }

  const thread = {
    threadId: uuidv4(),
    contactName,
    contactPhone,
    organizerName,
    organizerEmail,
    proposedTimes,
    status: 'pending',
    attempts: 0,
    conversationHistory: [],
    createdAt: new Date().toISOString()
  };

  try {
    await saveThread(contactPhone, thread);

    const timesList = proposedTimes.map((t, i) => `${i + 1}. ${t}`).join(', ');
    const full = `Hi ${contactName}! ${organizerName} would like to meet. Options: ${timesList}. Which works?`;
    const smsBody = full.length > 160 ? full.substring(0, 157) + '...' : full;

    await sendSms(contactPhone, smsBody);

    thread.conversationHistory.push({ role: 'model', content: smsBody });
    await saveThread(contactPhone, thread);

    res.status(200).json({ threadId: thread.threadId, message: 'Scheduling initiated' });
  } catch (err) {
    console.error('[initiate] Error:', err.message);
    res.status(500).json({ error: 'Failed to initiate scheduling' });
  }
});

module.exports = app;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/api/initiate.test.js --no-coverage`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add api/initiate.js tests/api/initiate.test.js
git commit -m "feat: add /api/initiate endpoint"
```

---

### Task 10: SMS Reply Endpoint

**Files:**
- Create: `api/sms-reply.js`
- Create: `tests/api/sms-reply.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/sms-reply.test.js`:

```javascript
const request = require('supertest');

const baseThread = {
  threadId: 'test-uuid',
  contactName: 'Bob',
  contactPhone: '+15551234567',
  organizerName: 'Alice',
  organizerEmail: 'alice@example.com',
  proposedTimes: ['Monday at 2pm'],
  status: 'pending',
  attempts: 0,
  conversationHistory: [
    { role: 'model', content: 'Hi Bob! Which time works?' }
  ],
  createdAt: '2026-05-07T10:00:00.000Z'
};

jest.mock('../../lib/kv', () => ({
  getThread: jest.fn(),
  saveThread: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../lib/twilio', () => ({
  sendSms: jest.fn().mockResolvedValue('SM123')
}));

jest.mock('../../lib/gemini', () => ({
  getNextReply: jest.fn()
}));

jest.mock('../../lib/calendar', () => ({
  bookCalendarEvent: jest.fn().mockResolvedValue({ id: 'cal-event-1' })
}));

jest.mock('../../lib/email', () => ({
  sendOrganizerEmail: jest.fn().mockResolvedValue(undefined)
}));

const { getThread } = require('../../lib/kv');
const { sendSms } = require('../../lib/twilio');
const { getNextReply } = require('../../lib/gemini');
const { bookCalendarEvent } = require('../../lib/calendar');
const { sendOrganizerEmail } = require('../../lib/email');
const app = require('../../api/sms-reply');

const twilioPost = (body) =>
  request(app).post('/api/sms-reply').type('form').send(body);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('POST /api/sms-reply', () => {
  it('responds immediately with empty TwiML and status 200', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('Tuesday at 10am works too!');
    const res = await twilioPost({ From: '+15551234567', Body: 'Monday works!' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');
  });

  it('sends polite message when no thread found for that number', async () => {
    getThread.mockResolvedValue(null);
    await twilioPost({ From: '+15559999999', Body: 'Hello' });
    await wait(50);
    expect(sendSms).toHaveBeenCalledWith(
      '+15559999999',
      expect.stringContaining("don't have an active scheduling request")
    );
  });

  it('sends Gemini reply as SMS for a conversational (non-JSON) response', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('How about Wednesday at 3pm?');
    await twilioPost({ From: '+15551234567', Body: 'Monday does not work' });
    await wait(50);
    expect(sendSms).toHaveBeenCalledWith('+15551234567', 'How about Wednesday at 3pm?');
  });

  it('books calendar event when Gemini returns confirmed JSON', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await twilioPost({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    await wait(50);
    expect(bookCalendarEvent).toHaveBeenCalledWith(
      '2026-05-12T14:00:00',
      'Bob',
      'alice@example.com'
    );
  });

  it('emails organizer when Gemini returns confirmed JSON', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await twilioPost({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    await wait(50);
    expect(sendOrganizerEmail).toHaveBeenCalledWith(
      'alice@example.com',
      'Alice',
      'Bob',
      '2026-05-12T14:00:00'
    );
  });

  it('sends confirmation SMS to contact after booking', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await twilioPost({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    await wait(50);
    expect(sendSms).toHaveBeenCalledWith(
      '+15551234567',
      expect.stringContaining('confirmed')
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/sms-reply.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../../api/sms-reply'`

- [ ] **Step 3: Implement api/sms-reply.js**

Create `api/sms-reply.js`:

```javascript
const express = require('express');
const { getThread, saveThread } = require('../lib/kv');
const { sendSms } = require('../lib/twilio');
const { getNextReply } = require('../lib/gemini');
const { bookCalendarEvent } = require('../lib/calendar');
const { sendOrganizerEmail } = require('../lib/email');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/api/sms-reply', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const from = req.body.From;
  const incomingMessage = req.body.Body;

  processReply(from, incomingMessage).catch(err => {
    console.error('[sms-reply] Unhandled error:', err.message);
  });
});

async function processReply(from, incomingMessage) {
  const thread = await getThread(from);

  if (!thread) {
    await sendSms(from, "Sorry, I don't have an active scheduling request for this number.");
    return;
  }

  if (thread.status === 'confirmed') {
    return;
  }

  try {
    const reply = await getNextReply(thread, incomingMessage);

    let parsed = null;
    try {
      parsed = JSON.parse(reply.trim());
    } catch (_) {
      // Conversational reply, not a JSON confirmation
    }

    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.status = 'confirmed';
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      await saveThread(from, thread);

      await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail);
      await sendOrganizerEmail(
        thread.organizerEmail,
        thread.organizerName,
        thread.contactName,
        parsed.datetime
      );

      const confirmMsg = `Your meeting with ${thread.organizerName} is confirmed! You'll receive details soon.`;
      await sendSms(from, confirmMsg);

      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveThread(from, thread);
    } else {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      thread.conversationHistory.push({ role: 'model', content: reply });
      await saveThread(from, thread);
      await sendSms(from, reply);
    }
  } catch (err) {
    console.error('[sms-reply] Error processing reply:', err.message);
  }
}

module.exports = app;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/api/sms-reply.test.js --no-coverage`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full test suite**

Run: `npx jest --no-coverage`
Expected: All 24 tests pass across all 8 suites.

- [ ] **Step 6: Commit**

```bash
git add api/sms-reply.js tests/api/sms-reply.test.js
git commit -m "feat: add /api/sms-reply Twilio webhook endpoint"
```

---

### Task 11: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md**

```markdown
# SMS Scheduling Automation

AI-powered SMS scheduling: sends proposed meeting times via text, negotiates back and forth using Gemini 1.5 Flash, books the confirmed time in Google Calendar, and emails the organizer.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/initiate` | Start a scheduling thread for a contact |
| POST | `/api/sms-reply` | Twilio webhook for inbound SMS replies |
| GET | `/api/health` | Uptime check |

## Prerequisites

- Node.js 18+
- Vercel CLI: `npm i -g vercel`
- Twilio account with a phone number
- Google Cloud project with Calendar API enabled
- Gmail account with an App Password

## Environment Variables

Copy `.env.example` to `.env.local` and fill in each value:

```bash
cp .env.example .env.local
```

### Twilio Setup

1. Create a Twilio account at twilio.com
2. Buy a phone number with SMS capability
3. Copy Account SID and Auth Token from the Twilio Console
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
5. After deploying, set the webhook URL in Twilio Console → Phone Numbers → Your Number → Messaging → Webhook URL (HTTP POST): `https://your-project.vercel.app/api/sms-reply`

### Google Service Account Setup

1. Go to Google Cloud Console → APIs & Services → Enable **Google Calendar API**
2. Go to IAM & Admin → Service Accounts → Create Service Account (no roles needed)
3. Create a JSON key and download it
4. Minify the JSON to a single line: `jq -c . credentials.json`
5. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the minified JSON string
6. Open Google Calendar → Settings → your target calendar → Share with specific people
7. Add the service account email with **Make changes to events** permission
8. Set `GOOGLE_CALENDAR_ID` to the calendar ID (found in Settings → Integrate calendar)

### Gmail App Password Setup

1. Enable 2-Step Verification on your Google account
2. Go to Google Account → Security → 2-Step Verification → App passwords
3. Create an App Password for "Mail" / "Other (custom name)"
4. Set `GMAIL_USER` (your Gmail address) and `GMAIL_APP_PASSWORD` (the 16-character password)

### Vercel KV Setup

1. Go to your Vercel dashboard → Storage → Create Database → KV
2. Connect it to your project
3. Copy `KV_REST_API_URL` and `KV_REST_API_TOKEN` from the KV dashboard

### Gemini API Key

1. Go to Google AI Studio (aistudio.google.com)
2. Create an API key (free tier is sufficient)
3. Set `GEMINI_API_KEY`

## Local Development with ngrok

1. Start the local dev server: `vercel dev`
2. In a second terminal, expose it: `ngrok http 3000`
3. Copy the ngrok HTTPS URL (e.g., `https://abc123.ngrok.io`)
4. In Twilio Console, set the webhook to: `https://abc123.ngrok.io/api/sms-reply`

## Deploy to Production

```bash
vercel --prod
```

Update your Twilio webhook to the Vercel production URL after deploying.

## Testing the Flow

**1. Trigger a scheduling request:**

```bash
curl -X POST https://your-project.vercel.app/api/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "contactName": "Bob",
    "contactPhone": "+15551234567",
    "organizerName": "Alice",
    "organizerEmail": "alice@example.com",
    "proposedTimes": ["Monday May 12 at 2pm", "Wednesday May 14 at 10am"]
  }'
```

**2.** Bob receives the SMS and replies from his phone.

**3.** The AI (Alex) negotiates back and forth until a time is confirmed.

**4.** Google Calendar event is automatically created and Alice receives an email notification.

## Running Tests

```bash
npm test
```
```

- [ ] **Step 2: Verify all tests still pass**

Run: `npx jest --no-coverage`
Expected: All 24 tests pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README with full setup and deployment instructions"
```

---

## Self-Review

### Spec Coverage

| Requirement | Task |
|-------------|------|
| `POST /api/initiate` endpoint | Task 9 |
| `POST /api/sms-reply` Twilio webhook | Task 10 |
| `GET /api/health` with timestamp | Task 8 |
| Vercel KV thread state with full schema | Tasks 3, 9 |
| Twilio inbound and outbound SMS | Tasks 4, 9, 10 |
| Gemini 1.5 Flash via `@google/generative-ai` | Tasks 7, 10 |
| Google Calendar booking via service account | Tasks 5, 10 |
| `bookCalendarEvent(datetime, contactName, organizerEmail)` signature | Tasks 5, 10 |
| Nodemailer + Gmail SMTP organizer email | Tasks 6, 10 |
| `sendOrganizerEmail(organizerEmail, organizerName, contactName, confirmedDatetime)` signature | Tasks 6, 10 |
| Thread state schema (all 10 fields) | Task 9 |
| Gemini system prompt (verbatim from spec) | Task 7 |
| `uuid` package for thread IDs | Task 9 |
| Try/catch with error logging on all external calls | Tasks 9, 10 |
| "No active scheduling request" fallback reply | Task 10 |
| `.env.example` with all 10 env vars | Task 2 |
| `vercel.json` for Vercel deployment | Task 2 |
| `README.md` with all 5 setup sections | Task 11 |

All requirements covered — no gaps.

### Placeholder Scan

No TBDs, TODOs, "implement later", "similar to Task N", or vague "add error handling" patterns found.

### Type Consistency

- `getThread(phone)` / `saveThread(phone, thread)` / `deleteThread(phone)` — consistent across Tasks 3, 9, 10
- `sendSms(to, body)` — consistent across Tasks 4, 9, 10
- `bookCalendarEvent(datetime, contactName, organizerEmail)` — consistent across Tasks 5, 10
- `sendOrganizerEmail(organizerEmail, organizerName, contactName, confirmedDatetime)` — consistent across Tasks 6, 10
- `getNextReply(thread, incomingMessage)` — consistent across Tasks 7, 10
- Thread `conversationHistory` entries always `{ role, content }` — consistent across Tasks 7, 9, 10
- Gemini history format always `{ role, parts: [{ text }] }` — only used inside `lib/gemini.js`
