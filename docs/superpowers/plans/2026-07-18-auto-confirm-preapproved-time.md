# Auto-Confirm on Pre-Approved Exact Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip the redundant final "Reply YES to confirm" organizer message when the organizer already unambiguously named the exact time the contact just agreed to, controlled by a new settings toggle.

**Architecture:** A new nullable thread field (`organizerPreApprovedTime`) tracks the one exact time an organizer has most recently and unambiguously authorized. It's set from three places (backup times at initiate, initial review, unsolicited updates) via structured JSON responses from Gemini (extending the existing `extractJson` pattern already used elsewhere in `lib/gemini.js`). At contact-confirmation time, that value is fed back into the confirmation prompt, and Gemini's own confirmed-status response is extended with a `matchesOrganizerPreApproval` boolean. `api/sms-reply.js` only skips the organizer approval hold when that boolean is true **and** the new `autoConfirmPreApprovedTimes` setting is on.

**Tech Stack:** Node.js/Express API routes, `@google/generative-ai` (Gemini 2.5 Flash), Jest + Supertest for tests, Upstash Redis via existing `lib/kv.js` (unchanged).

## Global Constraints

- New settings field: `autoConfirmPreApprovedTimes` (boolean), default `true` — added to `lib/settings.js` `DEFAULTS`/`RULES` following the exact pattern of the existing `demoMode` field.
- New thread field: `organizerPreApprovedTime` (`string | null`) — plain-language text, never parsed programmatically.
- Auto-confirm only fires when `settings.autoConfirmPreApprovedTimes === true` AND Gemini's parsed confirmed-status response has `matchesOrganizerPreApproval === true`. Any parse failure, missing field, or falsy value must fail closed to the existing always-ask-organizer behavior — never fail open into auto-confirming.
- Reuse existing helpers (`extractJson`, `truncate`, `applyTemplate`, `demoSendSms`, `orgPrelude`, `pushOrganizerHistory`, `saveBoth`, `formatConfirmedTime`) — do not introduce new abstractions for logic that already exists.
- Every task must leave `npm test` fully green before moving to the next task.
- No changes to the counter-proposal approval flow (`getOrganizerApprovalDecision` / the `waitingForOrganizerApproval` branch of `handleOrganizerReply`) — it already finalizes immediately on organizer approval and is out of scope.

---

### Task 1: Add `autoConfirmPreApprovedTimes` setting

**Files:**
- Modify: `lib/settings.js:10-28`
- Test: `tests/lib/settings.test.js`

**Interfaces:**
- Produces: `DEFAULTS.autoConfirmPreApprovedTimes` (boolean, `true`), validated as `{ type: 'boolean' }` in `RULES`. Consumed by `api/sms-reply.js` in Task 7 as `settings.autoConfirmPreApprovedTimes`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/settings.test.js`, inside the existing `describe('saveSettings', ...)` block (after the `'saves demoMode boolean and returns it'` test, before its closing `});`):

```javascript
  it('saves autoConfirmPreApprovedTimes boolean and returns it', async () => {
    redis._mockGet.mockResolvedValue(null);
    redis._mockSet.mockResolvedValue('OK');
    const result = await saveSettings({ autoConfirmPreApprovedTimes: false });
    expect(result.autoConfirmPreApprovedTimes).toBe(false);
  });

  it('throws validation error when autoConfirmPreApprovedTimes is not a boolean', async () => {
    await expect(saveSettings({ autoConfirmPreApprovedTimes: 'yes' }))
      .rejects.toThrow(/autoConfirmPreApprovedTimes/);
  });
```

Add to the existing `describe('DEFAULTS', ...)` block (after the `'demoMode defaults to false'` test):

```javascript
  it('autoConfirmPreApprovedTimes defaults to true', () => {
    expect(DEFAULTS.autoConfirmPreApprovedTimes).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/settings.test.js -v`
Expected: FAIL — `expected undefined to be true` / `expected undefined to be false` / validation error not thrown.

- [ ] **Step 3: Implement**

In `lib/settings.js`, change:

```javascript
const DEFAULTS = {
  assistantName: 'Alex',
  tone: 'Be conversational and polite.',
  maxMessageLength: 160,
  maxExchanges: 6,
  holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
  confirmationMessage: "Your meeting with {organizerName} is confirmed for {confirmedDatetime}! You'll receive details soon.",
  demoMode: false
};

const RULES = {
  assistantName:       { type: 'string',  min: 1,  max: 40  },
  tone:                { type: 'string',  min: 1,  max: 300 },
  maxMessageLength:    { type: 'integer', min: 50, max: 320 },
  maxExchanges:        { type: 'integer', min: 2,  max: 20  },
  holdingMessage:      { type: 'string',  min: 1,  max: 320 },
  confirmationMessage: { type: 'string',  min: 1,  max: 320 },
  demoMode:            { type: 'boolean' }
};
```

to:

```javascript
const DEFAULTS = {
  assistantName: 'Alex',
  tone: 'Be conversational and polite.',
  maxMessageLength: 160,
  maxExchanges: 6,
  holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
  confirmationMessage: "Your meeting with {organizerName} is confirmed for {confirmedDatetime}! You'll receive details soon.",
  demoMode: false,
  autoConfirmPreApprovedTimes: true
};

const RULES = {
  assistantName:       { type: 'string',  min: 1,  max: 40  },
  tone:                { type: 'string',  min: 1,  max: 300 },
  maxMessageLength:    { type: 'integer', min: 50, max: 320 },
  maxExchanges:        { type: 'integer', min: 2,  max: 20  },
  holdingMessage:      { type: 'string',  min: 1,  max: 320 },
  confirmationMessage: { type: 'string',  min: 1,  max: 320 },
  demoMode:            { type: 'boolean' },
  autoConfirmPreApprovedTimes: { type: 'boolean' }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/settings.test.js tests/api/settings.test.js -v`
Expected: PASS (all tests in both files — `tests/api/settings.test.js` isn't touched but must stay green since it exercises the same module).

- [ ] **Step 5: Commit**

```bash
git add lib/settings.js tests/lib/settings.test.js
git commit -m "feat: add autoConfirmPreApprovedTimes setting"
```

---

### Task 2: Add settings-panel toggle for the new setting

**Files:**
- Modify: `public/index.html:1027-1030` (new field), `public/index.html:1471` (load), `public/index.html:1492` (save)

**Interfaces:**
- Consumes: `autoConfirmPreApprovedTimes` field from `GET /api/settings` response (Task 1).
- Produces: same field in the `POST /api/settings` request body.

- [ ] **Step 1: Add the checkbox markup**

In `public/index.html`, find this block (inside the "AI Behavior" settings section):

```html
      <div class="settings-field">
        <label for="s_maxExchanges">Max exchanges before giving up</label>
        <input type="number" id="s_maxExchanges" min="2" max="20" />
      </div>
    </div>
```

Replace with:

```html
      <div class="settings-field">
        <label for="s_maxExchanges">Max exchanges before giving up</label>
        <input type="number" id="s_maxExchanges" min="2" max="20" />
      </div>

      <div class="settings-field">
        <div class="toggle-row">
          <label for="s_autoConfirmPreApprovedTimes">Skip final confirmation for pre-approved times</label>
          <label class="toggle-switch">
            <input type="checkbox" id="s_autoConfirmPreApprovedTimes" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="hint">When the organizer already named one exact time and the contact agrees to it, book immediately instead of asking the organizer to confirm again.</p>
      </div>
    </div>
```

- [ ] **Step 2: Wire it into `loadSettings()`**

Find this line in `public/index.html`:

```javascript
      document.getElementById('s_demoMode').checked          = s.demoMode           ?? false;
```

Add immediately after it:

```javascript
      document.getElementById('s_autoConfirmPreApprovedTimes').checked = s.autoConfirmPreApprovedTimes ?? true;
```

- [ ] **Step 3: Wire it into `saveSettings()`**

Find this line in `public/index.html`:

```javascript
        demoMode:            document.getElementById('s_demoMode').checked
      };
```

Replace with:

```javascript
        demoMode:            document.getElementById('s_demoMode').checked,
        autoConfirmPreApprovedTimes: document.getElementById('s_autoConfirmPreApprovedTimes').checked
      };
```

- [ ] **Step 4: Manually verify in a browser**

There is no automated test harness for `public/index.html` in this repo (no existing tests reference it). Run `vercel dev` (or `npm run dev`), open the app, open the ⚙ settings panel, and confirm: the new toggle appears under "AI Behavior", defaults to checked (on) on first load, and its state persists after clicking "Save settings" and reopening the panel.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: add settings toggle for auto-confirming pre-approved times"
```

---

### Task 3: Structured `exactApprovedTime` output from organizer-facing Gemini calls

**Files:**
- Modify: `lib/gemini.js:100-112` (`getOrganizerInitialContactMessage`), `lib/gemini.js:148-174` (`getOrganizerUpdateReply`)
- Test: `tests/lib/gemini.test.js:147-168` and `:229-269`

**Interfaces:**
- Produces: both functions now resolve to `{ contactMessage: string, exactApprovedTime: string | null }` instead of a plain string. `exactApprovedTime` is populated only when the organizer's reply unambiguously names exactly one specific time.
- Consumed by: Task 6 (`api/sms-reply.js`'s `handleOrganizerInitialReview` and the unsolicited-update branch of `handleOrganizerReply`).

- [ ] **Step 1: Write the failing tests**

Replace the entire `describe('getOrganizerInitialContactMessage', ...)` block in `tests/lib/gemini.test.js` (currently lines 147-168) with:

```javascript
describe('getOrganizerInitialContactMessage', () => {
  it('includes the original proposed times in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday. Which works?","exactApprovedTime":null}' }
    });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday at 2pm', 'Tuesday at 10am'], 'Sounds good, go ahead');
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('Monday at 2pm');
    expect(call).toContain('Tuesday at 10am');
  });

  it('includes the full organizer message in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead — does that work?","exactApprovedTime":"3pm"}' }
    });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['1pm'], "I can't at 1pm, but 3pm works");
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain("I can't at 1pm, but 3pm works");
  });

  it('returns the generated contactMessage', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Ready to schedule with Alice?","exactApprovedTime":null}' }
    });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday'], 'Yes please');
    expect(reply.contactMessage).toBe("Hi Bob! Ready to schedule with Alice?");
  });

  it('returns exactApprovedTime when the organizer named exactly one specific time', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! 4:30 PM works for Alice — does that work for you too?","exactApprovedTime":"4:30 PM"}' }
    });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['4:30 PM'], 'Yes, 4:30 works');
    expect(reply.exactApprovedTime).toBe('4:30 PM');
  });

  it('returns null exactApprovedTime when the organizer approved multiple times', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Both Monday 2pm and Tuesday 10am work for Alice — which works for you?","exactApprovedTime":null}' }
    });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday at 2pm', 'Tuesday at 10am'], 'Both work');
    expect(reply.exactApprovedTime).toBeNull();
  });

  it('falls back to raw text as contactMessage with null exactApprovedTime when Gemini returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Sorry, I cannot help with that.' } });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday'], 'Yes please');
    expect(reply.contactMessage).toBe('Sorry, I cannot help with that.');
    expect(reply.exactApprovedTime).toBeNull();
  });
});
```

Replace the entire `describe('getOrganizerUpdateReply', ...)` block (currently lines 229-269) with:

```javascript
describe('getOrganizerUpdateReply', () => {
  it('calls generateContent with organizer update context', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead. Does that work?","exactApprovedTime":"3pm"}' }
    });
    await getOrganizerUpdateReply('Alice', 'Bob', "I can't at 1pm, but 3pm works");
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("I can't at 1pm, but 3pm works")
    );
  });

  it('returns the Gemini-generated contactMessage', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead. Does that work?","exactApprovedTime":"3pm"}' }
    });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', "3pm works instead");
    expect(reply.contactMessage).toBe("Hi Bob! Alice can do 3pm instead. Does that work?");
  });

  it('returns exactApprovedTime when the organizer named exactly one specific time', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead. Does that work?","exactApprovedTime":"3pm"}' }
    });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', '3pm works instead');
    expect(reply.exactApprovedTime).toBe('3pm');
  });

  it('returns null exactApprovedTime when the update is vague', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice has some new availability — want to hear the options?","exactApprovedTime":null}' }
    });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', "I'm generally free most afternoons");
    expect(reply.exactApprovedTime).toBeNull();
  });

  it('falls back to raw text as contactMessage with null exactApprovedTime when Gemini returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Not JSON at all' } });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', 'Try 4pm');
    expect(reply.contactMessage).toBe('Not JSON at all');
    expect(reply.exactApprovedTime).toBeNull();
  });

  it('uses gemini-2.5-flash with organizer name in system instruction', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '{"contactMessage":"Hi!","exactApprovedTime":null}' } });
    await getOrganizerUpdateReply('Alice', 'Bob', 'Try 4pm');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        systemInstruction: expect.stringContaining('Alice')
      })
    );
  });

  it('includes offeredTimes, directorMessages, and lastContactMsg from context in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '{"contactMessage":"Hi Bob!","exactApprovedTime":null}' } });
    await getOrganizerUpdateReply('Alice', 'Bob', 'Try 4pm', {}, {
      offeredTimes: ['Monday at 2pm', 'Tuesday at 10am'],
      directorMessages: ['Wednesday at 3pm'],
      rejectedTimes: ['Thursday at 5pm'],
      lastContactMsg: 'None of those work for me'
    });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('Monday at 2pm');
    expect(call).toContain('Wednesday at 3pm');
    expect(call).toContain('Thursday at 5pm');
    expect(call).toContain('None of those work for me');
  });
});
```

Leave the two tests referencing these functions inside `describe('settings values used in prompts', ...)` (near the end of the file) unchanged — they only assert on `systemInstruction`, not the return value, so they're unaffected.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/gemini.test.js -v`
Expected: FAIL — `reply.contactMessage` is `undefined` (functions still return plain strings), `reply.exactApprovedTime` is `undefined`.

- [ ] **Step 3: Implement**

In `lib/gemini.js`, replace:

```javascript
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
```

with:

```javascript
async function getOrganizerInitialContactMessage(organizerName, contactName, proposedTimes, organizerMessage, settings = {}) {
  const name   = settings.assistantName    || 'Alex';
  const maxLen = settings.maxMessageLength || 160;
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Keep all messages under ${maxLen} characters. Be warm and conversational — never robotic or template-like.`
  });

  const prompt = `${organizerName} originally proposed these times to meet with ${contactName}: ${proposedTimes.join(', ')}. The organizer just replied: "${organizerMessage}".

Based on what the organizer said, write a brief, friendly SMS to ${contactName}: if the organizer approved the original times, ask which works; if the organizer suggested different or modified times, offer only those new times and ask if they work. Do not mention any times the organizer declined. Keep under ${maxLen} characters.

Reply ONLY with this JSON (no markdown, no other text): {"contactMessage":"<the SMS text>","exactApprovedTime":"<the single specific time the organizer unambiguously approved, in plain English, or null if they gave multiple options, a range, or anything vague>"}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    const parsed = JSON.parse(extractJson(text));
    return { contactMessage: parsed.contactMessage, exactApprovedTime: parsed.exactApprovedTime || null };
  } catch (_) {
    return { contactMessage: text, exactApprovedTime: null };
  }
}
```

Replace:

```javascript
async function getOrganizerUpdateReply(organizerName, contactName, organizerMessage, settings = {}, context = {}) {
  const name   = settings.assistantName    || 'Alex';
  const maxLen = settings.maxMessageLength || 160;
  const {
    offeredTimes = [],
    directorMessages = [],
    rejectedTimes = [],
    lastContactMsg = null
  } = context;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Keep all messages under ${maxLen} characters. Be conversational and polite.`
  });

  const contextLines = [];
  if (offeredTimes.length > 0) contextLines.push(`Originally offered times: ${offeredTimes.join(', ')}.`);
  if (directorMessages.length > 0) contextLines.push(`The organizer has previously communicated: ${directorMessages.join('; ')}.`);
  if (rejectedTimes.length > 0) contextLines.push(`Times already declined: ${rejectedTimes.join(', ')} — do not offer these.`);
  if (lastContactMsg) contextLines.push(`The last message sent to ${contactName} was: "${lastContactMsg}".`);
  const contextBlock = contextLines.length > 0 ? '\n' + contextLines.join('\n') : '';

  const prompt = `${organizerName} just updated their availability: "${organizerMessage}".${contextBlock}\n\nWrite a brief, friendly SMS to ${contactName} sharing this updated availability and asking if the new time works. Under ${maxLen} characters.`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}
```

with:

```javascript
async function getOrganizerUpdateReply(organizerName, contactName, organizerMessage, settings = {}, context = {}) {
  const name   = settings.assistantName    || 'Alex';
  const maxLen = settings.maxMessageLength || 160;
  const {
    offeredTimes = [],
    directorMessages = [],
    rejectedTimes = [],
    lastContactMsg = null
  } = context;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Keep all messages under ${maxLen} characters. Be conversational and polite.`
  });

  const contextLines = [];
  if (offeredTimes.length > 0) contextLines.push(`Originally offered times: ${offeredTimes.join(', ')}.`);
  if (directorMessages.length > 0) contextLines.push(`The organizer has previously communicated: ${directorMessages.join('; ')}.`);
  if (rejectedTimes.length > 0) contextLines.push(`Times already declined: ${rejectedTimes.join(', ')} — do not offer these.`);
  if (lastContactMsg) contextLines.push(`The last message sent to ${contactName} was: "${lastContactMsg}".`);
  const contextBlock = contextLines.length > 0 ? '\n' + contextLines.join('\n') : '';

  const prompt = `${organizerName} just updated their availability: "${organizerMessage}".${contextBlock}

Write a brief, friendly SMS to ${contactName} sharing this updated availability and asking if the new time works. Under ${maxLen} characters.

Reply ONLY with this JSON (no markdown, no other text): {"contactMessage":"<the SMS text>","exactApprovedTime":"<the single specific time the organizer unambiguously approved, in plain English, or null if they gave multiple options, a range, or anything vague>"}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    const parsed = JSON.parse(extractJson(text));
    return { contactMessage: parsed.contactMessage, exactApprovedTime: parsed.exactApprovedTime || null };
  } catch (_) {
    return { contactMessage: text, exactApprovedTime: null };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/gemini.test.js -v`
Expected: PASS (all tests, including the untouched `settings values used in prompts` block).

- [ ] **Step 5: Commit**

```bash
git add lib/gemini.js tests/lib/gemini.test.js
git commit -m "feat: structured exactApprovedTime output from organizer-facing Gemini calls"
```

---

### Task 4: `matchesOrganizerPreApproval` in the contact confirmation prompt

**Files:**
- Modify: `lib/gemini.js:10-52` (`buildSystemPrompt`), `lib/gemini.js:54-98` (`getNextReply`)
- Test: `tests/lib/gemini.test.js:29-145` (`getNextReply` describe block)

**Interfaces:**
- Consumes: `thread.organizerPreApprovedTime` (set in Tasks 5 and 6).
- Produces: when `organizerPreApprovedTime` is set, `getNextReply`'s system prompt instructs Gemini to add `matchesOrganizerPreApproval: true` to its confirmed-status JSON — consumed by Task 7 as `parsed.matchesOrganizerPreApproval` in `api/sms-reply.js`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/gemini.test.js`, inside the existing `describe('getNextReply', ...)` block (after the `'returns the text response from Gemini'` test, before its closing `});`):

```javascript
  it('includes organizerPreApprovedTime in system prompt when set on the thread', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    const threadWithPreApproval = { ...mockThread, organizerPreApprovedTime: '4:30 PM' };
    await getNextReply(threadWithPreApproval, '4:30 works!');
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('4:30 PM');
    expect(systemInstruction).toContain('matchesOrganizerPreApproval');
  });

  it('omits matchesOrganizerPreApproval instructions when organizerPreApprovedTime is not set', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).not.toContain('matchesOrganizerPreApproval');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/lib/gemini.test.js -t "organizerPreApprovedTime" -v`
Expected: FAIL — `systemInstruction` doesn't contain `'4:30 PM'` or `'matchesOrganizerPreApproval'`.

- [ ] **Step 3: Implement**

In `lib/gemini.js`, replace:

```javascript
function buildSystemPrompt(organizerName, contactName, directorAlternatives = [], timezone, settings = {}, context = {}) {
  const tz = timezone || process.env.TIMEZONE || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const name   = settings.assistantName    || 'Alex';
  const tone   = settings.tone             || 'Be conversational and polite.';
  const maxLen = settings.maxMessageLength || 160;
  const maxEx  = settings.maxExchanges     || 6;
  const {
    offeredTimes = [],
    proposedTimes = [],
    directorMessages = [],
    rejectedTimes = [],
    lastContactMsg = null
  } = context;

  // Use offeredTimes when available; fall back to proposedTimes for older threads.
  const primaryTimes = offeredTimes.length > 0 ? offeredTimes : proposedTimes;

  const backupSection = directorAlternatives.length > 0
    ? ` The organizer pre-approved these backup times: ${directorAlternatives.join('; ')}. Offer them if the contact declines the primary options. IMPORTANT: If the contact accepts or agrees to any of these organizer-communicated times, return the confirmed JSON immediately — do not treat it as a counter-proposal.`
    : '';
  const offeredSection = primaryTimes.length > 0
    ? ` You have proposed these times to ${contactName}: ${primaryTimes.join(', ')}. Only offer dates/times consistent with what the organizer has communicated — do not invent new dates.`
    : '';
  const orgMsgSection = directorMessages.length > 0
    ? ` The organizer has since communicated: ${directorMessages.join('; ')}. Use these as the authoritative available times. IMPORTANT: If the contact accepts any of these, return the confirmed JSON immediately.`
    : '';
  const rejectedSection = rejectedTimes.length > 0
    ? ` These times have already been declined — do not offer them again: ${rejectedTimes.join(', ')}.`
    : '';
  const sentSection = lastContactMsg
    ? ` Your most recent message to ${contactName} was: "${lastContactMsg}". Stay consistent with this.`
    : '';

  return `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under ${maxLen} characters. ${tone} Today's date is ${today} (timezone: ${tz}).${backupSection}${offeredSection}${orgMsgSection}${rejectedSection}${sentSection}

When the contact confirms one of the proposed or organizer-communicated times, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}
Critical: the datetime field must be the actual agreed date from the conversation — never today's date (${today}) unless the meeting is literally today.

If the contact proposes a completely different time (not one of the proposed or organizer-communicated times), respond ONLY with this exact JSON and nothing else: {"status":"counter-proposal","suggestedTime":"<their suggestion in plain English>","suggestedDatetime":"YYYY-MM-DDTHH:mm:ss","reply":"<friendly message under ${maxLen} chars saying you will check with ${organizerName} and get back to them>"}

If they decline without proposing an alternative, suggest up to 2 options from the organizer-communicated times (if any) or two new times at different times of day. After no more than ${maxEx} exchanges with no agreement, send a final message saying you will follow up another time.`;
}
```

with:

```javascript
function buildSystemPrompt(organizerName, contactName, directorAlternatives = [], timezone, settings = {}, context = {}) {
  const tz = timezone || process.env.TIMEZONE || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const name   = settings.assistantName    || 'Alex';
  const tone   = settings.tone             || 'Be conversational and polite.';
  const maxLen = settings.maxMessageLength || 160;
  const maxEx  = settings.maxExchanges     || 6;
  const {
    offeredTimes = [],
    proposedTimes = [],
    directorMessages = [],
    rejectedTimes = [],
    lastContactMsg = null,
    organizerPreApprovedTime = null
  } = context;

  // Use offeredTimes when available; fall back to proposedTimes for older threads.
  const primaryTimes = offeredTimes.length > 0 ? offeredTimes : proposedTimes;

  const backupSection = directorAlternatives.length > 0
    ? ` The organizer pre-approved these backup times: ${directorAlternatives.join('; ')}. Offer them if the contact declines the primary options. IMPORTANT: If the contact accepts or agrees to any of these organizer-communicated times, return the confirmed JSON immediately — do not treat it as a counter-proposal.`
    : '';
  const offeredSection = primaryTimes.length > 0
    ? ` You have proposed these times to ${contactName}: ${primaryTimes.join(', ')}. Only offer dates/times consistent with what the organizer has communicated — do not invent new dates.`
    : '';
  const orgMsgSection = directorMessages.length > 0
    ? ` The organizer has since communicated: ${directorMessages.join('; ')}. Use these as the authoritative available times. IMPORTANT: If the contact accepts any of these, return the confirmed JSON immediately.`
    : '';
  const rejectedSection = rejectedTimes.length > 0
    ? ` These times have already been declined — do not offer them again: ${rejectedTimes.join(', ')}.`
    : '';
  const sentSection = lastContactMsg
    ? ` Your most recent message to ${contactName} was: "${lastContactMsg}". Stay consistent with this.`
    : '';
  const preApprovedSection = organizerPreApprovedTime
    ? ` The organizer has already explicitly confirmed availability for exactly this time: ${organizerPreApprovedTime}. If the contact agrees to this exact time, add "matchesOrganizerPreApproval":true to your confirmed-status JSON response.`
    : '';

  return `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under ${maxLen} characters. ${tone} Today's date is ${today} (timezone: ${tz}).${backupSection}${offeredSection}${orgMsgSection}${rejectedSection}${sentSection}${preApprovedSection}

When the contact confirms one of the proposed or organizer-communicated times, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}
Critical: the datetime field must be the actual agreed date from the conversation — never today's date (${today}) unless the meeting is literally today.

If the contact proposes a completely different time (not one of the proposed or organizer-communicated times), respond ONLY with this exact JSON and nothing else: {"status":"counter-proposal","suggestedTime":"<their suggestion in plain English>","suggestedDatetime":"YYYY-MM-DDTHH:mm:ss","reply":"<friendly message under ${maxLen} chars saying you will check with ${organizerName} and get back to them>"}

If they decline without proposing an alternative, suggest up to 2 options from the organizer-communicated times (if any) or two new times at different times of day. After no more than ${maxEx} exchanges with no agreement, send a final message saying you will follow up another time.`;
}
```

In `getNextReply`, replace:

```javascript
    systemInstruction: buildSystemPrompt(
      thread.organizerName, thread.contactName,
      thread.directorAlternatives, thread.timezone, settings,
      {
        offeredTimes: thread.offeredTimes || [],
        proposedTimes: thread.proposedTimes || [],
        directorMessages: thread.directorMessages || [],
        rejectedTimes: thread.rejectedTimes || [],
        lastContactMsg
      }
    )
```

with:

```javascript
    systemInstruction: buildSystemPrompt(
      thread.organizerName, thread.contactName,
      thread.directorAlternatives, thread.timezone, settings,
      {
        offeredTimes: thread.offeredTimes || [],
        proposedTimes: thread.proposedTimes || [],
        directorMessages: thread.directorMessages || [],
        rejectedTimes: thread.rejectedTimes || [],
        lastContactMsg,
        organizerPreApprovedTime: thread.organizerPreApprovedTime || null
      }
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/lib/gemini.test.js -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/gemini.js tests/lib/gemini.test.js
git commit -m "feat: signal matchesOrganizerPreApproval in confirmation prompt"
```

---

### Task 5: Set `organizerPreApprovedTime` from single pre-approved backup time

**Files:**
- Modify: `api/initiate.js:79-102` (thread object literal)
- Test: `tests/api/initiate.test.js` (inside `describe('POST /api/initiate — new schema fields', ...)`)

**Interfaces:**
- Produces: `thread.organizerPreApprovedTime` set at thread creation — consumed downstream by Task 4/7's flow once the thread is loaded from Redis on a later request.

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/initiate.test.js`, inside the existing `describe('POST /api/initiate — new schema fields', ...)` block (after the `'offeredTimes is empty in waiting_organizer_initial branch'` test, before its closing `});`):

```javascript
  it('sets organizerPreApprovedTime when exactly one backup time is given', async () => {
    const body = { ...base, organizerPhone: '+15550009999', directorAlternatives: ['Wednesday at 3pm'] };
    await request(app).post('/api/initiate').send(body);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.organizerPreApprovedTime).toBe('Wednesday at 3pm');
  });

  it('leaves organizerPreApprovedTime null when multiple backup times are given', async () => {
    const body = { ...base, organizerPhone: '+15550009999', directorAlternatives: ['Wednesday at 3pm', 'Thursday at 11am'] };
    await request(app).post('/api/initiate').send(body);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.organizerPreApprovedTime).toBeNull();
  });

  it('leaves organizerPreApprovedTime null when no backup times are given', async () => {
    await request(app).post('/api/initiate').send(base);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.organizerPreApprovedTime).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/initiate.test.js -t "organizerPreApprovedTime" -v`
Expected: FAIL — `saved.organizerPreApprovedTime` is `undefined`.

- [ ] **Step 3: Implement**

In `api/initiate.js`, find:

```javascript
  const thread = {
    threadId: uuidv4(),
    contactName,
    contactPhone:  normalizedContactPhone,
    organizerName,
    organizerEmail,
    organizerPhone: normalizedOrganizerPhone,
    proposedTimes,
    directorAlternatives: backupTimes,
    directorMessages: [],
```

Replace with:

```javascript
  const thread = {
    threadId: uuidv4(),
    contactName,
    contactPhone:  normalizedContactPhone,
    organizerName,
    organizerEmail,
    organizerPhone: normalizedOrganizerPhone,
    proposedTimes,
    directorAlternatives: backupTimes,
    organizerPreApprovedTime: backupTimes.length === 1 ? backupTimes[0] : null,
    directorMessages: [],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/api/initiate.test.js -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add api/initiate.js tests/api/initiate.test.js
git commit -m "feat: set organizerPreApprovedTime from a single pre-approved backup time"
```

---

### Task 6: Consume structured Gemini output in organizer-side handlers

**Files:**
- Modify: `api/sms-reply.js:365-394` (unsolicited-update branch of `handleOrganizerReply`), `api/sms-reply.js:458-484` (`handleOrganizerInitialReview`)
- Test: `tests/api/sms-reply.test.js` (7 mock call sites — see Step 1)

**Interfaces:**
- Consumes: `{ contactMessage, exactApprovedTime }` return shape from Task 3.
- Produces: `thread.organizerPreApprovedTime` set (or cleared to `null`) after every organizer initial-review reply and every unsolicited update — consumed by Task 4 (via `getNextReply`) on the contact's next message.

- [ ] **Step 1: Update existing test mocks to the new return shape**

In `tests/api/sms-reply.test.js`, update these 7 call sites (all currently pass a plain string to `.mockResolvedValue`; wrap each in the new object shape, keeping the same string as `contactMessage` and adding `exactApprovedTime: null`):

Replace (around line 318):
```javascript
    getOrganizerInitialContactMessage.mockResolvedValue(
      "Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday at 10am. Which works for you?"
    );
```
with:
```javascript
    getOrganizerInitialContactMessage.mockResolvedValue({
      contactMessage: "Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday at 10am. Which works for you?",
      exactApprovedTime: null
    });
```

Replace (around line 448):
```javascript
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is now free at 3pm instead. Does that work for you?");
```
with:
```javascript
    getOrganizerUpdateReply.mockResolvedValue({
      contactMessage: "Hi Bob! Alice is now free at 3pm instead. Does that work for you?",
      exactApprovedTime: null
    });
```

Replace (around line 511):
```javascript
    getOrganizerInitialContactMessage.mockResolvedValue(
      "Hey Bob! Alice wants to meet — Monday at 2pm. Which works?"
    );
```
with:
```javascript
    getOrganizerInitialContactMessage.mockResolvedValue({
      contactMessage: "Hey Bob! Alice wants to meet — Monday at 2pm. Which works?",
      exactApprovedTime: null
    });
```

Replace (around line 519):
```javascript
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is free at 3pm instead.");
```
with:
```javascript
    getOrganizerUpdateReply.mockResolvedValue({
      contactMessage: "Hi Bob! Alice is free at 3pm instead.",
      exactApprovedTime: null
    });
```

Replace (around line 783):
```javascript
    getOrganizerInitialContactMessage.mockResolvedValue('Hi Jane! Alice can do Mon Jun 2 or Tue Jun 3 — which works?');
```
with:
```javascript
    getOrganizerInitialContactMessage.mockResolvedValue({
      contactMessage: 'Hi Jane! Alice can do Mon Jun 2 or Tue Jun 3 — which works?',
      exactApprovedTime: null
    });
```

Replace (around line 837):
```javascript
    getOrganizerUpdateReply.mockResolvedValue("Hi! Alice updated availability.");
```
with:
```javascript
    getOrganizerUpdateReply.mockResolvedValue({ contactMessage: "Hi! Alice updated availability.", exactApprovedTime: null });
```

Replace (around line 847):
```javascript
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is free Thursday instead.");
```
with:
```javascript
    getOrganizerUpdateReply.mockResolvedValue({ contactMessage: "Hi Bob! Alice is free Thursday instead.", exactApprovedTime: null });
```

Then add two new tests. In the `describe('organizer messages — initial review', ...)` block (after the `'sets thread status to pending after initial review'` test):

```javascript
  it('sets organizerPreApprovedTime from the exactApprovedTime Gemini returns', async () => {
    setupThread({ ...waitingThread });
    getOrganizerInitialContactMessage.mockResolvedValue({
      contactMessage: "Hi Bob! 4:30 PM works for Alice — does that work for you too?",
      exactApprovedTime: '4:30 PM'
    });
    await post({ From: '+15550009999', Body: 'Yes, 4:30 works' });
    expect(saveThreadById.mock.calls[0][1]).toEqual(
      expect.objectContaining({ organizerPreApprovedTime: '4:30 PM' })
    );
  });
```

In the `describe('organizer messages — unsolicited availability update', ...)` block (after the `'adds organizer update to directorMessages'` test):

```javascript
  it('sets organizerPreApprovedTime from the exactApprovedTime Gemini returns', async () => {
    setupThread({ ...baseThread });
    getOrganizerUpdateReply.mockResolvedValue({
      contactMessage: "Hi Bob! Alice is now free at 3pm instead. Does that work for you?",
      exactApprovedTime: '3pm'
    });
    await post({ From: '+15550009999', Body: "I can only do 3pm now" });
    expect(saveThreadById.mock.calls[0][1]).toEqual(
      expect.objectContaining({ organizerPreApprovedTime: '3pm' })
    );
  });

  it('clears organizerPreApprovedTime to null when the update is vague', async () => {
    setupThread({ ...baseThread, organizerPreApprovedTime: '2pm' });
    getOrganizerUpdateReply.mockResolvedValue({
      contactMessage: "Hi Bob! Alice has some new availability.",
      exactApprovedTime: null
    });
    await post({ From: '+15550009999', Body: "I'm generally free most afternoons" });
    expect(saveThreadById.mock.calls[0][1]).toEqual(
      expect.objectContaining({ organizerPreApprovedTime: null })
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/sms-reply.test.js -v`
Expected: FAIL — the 7 updated mocks now return objects, but the handlers still treat them as strings (`aiMsg.length` / `truncate(aiMsg, ...)` will throw or produce `"[object Object]"`), and the 3 new tests fail because `thread.organizerPreApprovedTime` is never set.

- [ ] **Step 3: Implement**

In `api/sms-reply.js`, replace the unsolicited-update branch inside `handleOrganizerReply`:

```javascript
  if (!thread.waitingForOrganizerApproval) {
    try {
      thread.directorMessages = [...(thread.directorMessages || []), incomingMessage];
      const aiMsg = await getOrganizerUpdateReply(
        thread.organizerName, thread.contactName, incomingMessage, settings,
        {
          offeredTimes: thread.offeredTimes || [],
          directorMessages: thread.directorMessages || [],
          rejectedTimes: thread.rejectedTimes || [],
          lastContactMsg: lastModelMsg(thread)
        }
      );
      const smsSafe = truncate(aiMsg, settings.maxMessageLength);
      const ackMsg = `Got it! I've let ${thread.contactName} know about your updated availability.`;
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      pushOrganizerHistory(thread, incomingMessage, ackMsg);
      await saveBoth(thread);
      await demoSendSms(thread.contactPhone, smsSafe, settings.demoMode);
      console.log(`[sms-reply] organizer unsolicited update — AI reply sent to contact ${thread.contactPhone}: "${smsSafe}"`);
      return res.send(twimlReply(ackMsg));
    } catch (err) {
      console.error('[sms-reply] Error handling organizer availability update:', err.message);
      return res.send('<Response></Response>');
    }
  }
```

with:

```javascript
  if (!thread.waitingForOrganizerApproval) {
    try {
      thread.directorMessages = [...(thread.directorMessages || []), incomingMessage];
      const { contactMessage, exactApprovedTime } = await getOrganizerUpdateReply(
        thread.organizerName, thread.contactName, incomingMessage, settings,
        {
          offeredTimes: thread.offeredTimes || [],
          directorMessages: thread.directorMessages || [],
          rejectedTimes: thread.rejectedTimes || [],
          lastContactMsg: lastModelMsg(thread)
        }
      );
      const smsSafe = truncate(contactMessage, settings.maxMessageLength);
      const ackMsg = `Got it! I've let ${thread.contactName} know about your updated availability.`;
      thread.organizerPreApprovedTime = exactApprovedTime;
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      pushOrganizerHistory(thread, incomingMessage, ackMsg);
      await saveBoth(thread);
      await demoSendSms(thread.contactPhone, smsSafe, settings.demoMode);
      console.log(`[sms-reply] organizer unsolicited update — AI reply sent to contact ${thread.contactPhone}: "${smsSafe}"`);
      return res.send(twimlReply(ackMsg));
    } catch (err) {
      console.error('[sms-reply] Error handling organizer availability update:', err.message);
      return res.send('<Response></Response>');
    }
  }
```

Replace `handleOrganizerInitialReview`:

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
    thread.directorMessages = [...(thread.directorMessages || []), incomingMessage];
    thread.offeredTimes = thread.proposedTimes || [];
    thread.conversationHistory.push({ role: 'model', content: smsBody });
    pushOrganizerHistory(thread, incomingMessage, reply);
    await saveBoth(thread);

    await demoSendSms(thread.contactPhone, smsBody, settings.demoMode);
    console.log(`[sms-reply] initial contact message sent to ${thread.contactPhone}: "${smsBody}"`);

    return res.send(twimlReply(reply));

  } catch (err) {
    console.error('[sms-reply] Error processing organizer initial review:', err.message);
    return res.send(twimlReply('Sorry, something went wrong sending the message. Please try again.'));
  }
}
```

with:

```javascript
async function handleOrganizerInitialReview(thread, incomingMessage, res, settings) {
  try {
    const { contactMessage, exactApprovedTime } = await getOrganizerInitialContactMessage(
      thread.organizerName, thread.contactName,
      thread.proposedTimes, incomingMessage, settings
    );
    const smsBody = truncate(contactMessage, settings.maxMessageLength);

    const reply = `Got it! I've reached out to ${thread.contactName} with your availability.`;

    thread.status = 'pending';
    thread.directorMessages = [...(thread.directorMessages || []), incomingMessage];
    thread.offeredTimes = thread.proposedTimes || [];
    thread.organizerPreApprovedTime = exactApprovedTime;
    thread.conversationHistory.push({ role: 'model', content: smsBody });
    pushOrganizerHistory(thread, incomingMessage, reply);
    await saveBoth(thread);

    await demoSendSms(thread.contactPhone, smsBody, settings.demoMode);
    console.log(`[sms-reply] initial contact message sent to ${thread.contactPhone}: "${smsBody}"`);

    return res.send(twimlReply(reply));

  } catch (err) {
    console.error('[sms-reply] Error processing organizer initial review:', err.message);
    return res.send(twimlReply('Sorry, something went wrong sending the message. Please try again.'));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/api/sms-reply.test.js -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add api/sms-reply.js tests/api/sms-reply.test.js
git commit -m "feat: track organizerPreApprovedTime from organizer replies"
```

---

### Task 7: Skip final organizer confirmation when Gemini reports a match

**Files:**
- Modify: `api/sms-reply.js:277-325` (`handleContactReply`'s confirmed branch)
- Test: `tests/api/sms-reply.test.js`

**Interfaces:**
- Consumes: `settings.autoConfirmPreApprovedTimes` (Task 1), `parsed.matchesOrganizerPreApproval` (Task 4, arrives via the mocked `getNextReply` JSON string in tests).

- [ ] **Step 1: Write the failing tests**

In `tests/api/sms-reply.test.js`, find the top-level `beforeEach` (near the top of the file, right after `setupThread`):

```javascript
beforeEach(() => {
  getSettings.mockResolvedValue({
    assistantName: 'Alex',
    tone: 'Be conversational and polite.',
    maxMessageLength: 160,
    maxExchanges: 6,
    holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
    confirmationMessage: "Your meeting with {organizerName} is confirmed for {confirmedDatetime}! You'll receive details soon.",
    demoMode: false
  });
  // Default to a genuine Twilio request so existing tests exercise business logic,
  // not the auth gate — see the dedicated 'Twilio signature verification' describe below.
  isValidTwilioRequest.mockReturnValue(true);
});
```

Replace with:

```javascript
beforeEach(() => {
  getSettings.mockResolvedValue({
    assistantName: 'Alex',
    tone: 'Be conversational and polite.',
    maxMessageLength: 160,
    maxExchanges: 6,
    holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
    confirmationMessage: "Your meeting with {organizerName} is confirmed for {confirmedDatetime}! You'll receive details soon.",
    demoMode: false,
    autoConfirmPreApprovedTimes: true
  });
  // Default to a genuine Twilio request so existing tests exercise business logic,
  // not the auth gate — see the dedicated 'Twilio signature verification' describe below.
  isValidTwilioRequest.mockReturnValue(true);
});
```

Then add a new describe block at the end of the file (after the last existing `describe` block's closing `});`):

```javascript
describe('auto-confirm on pre-approved exact time', () => {
  it('books immediately and sends organizer an FYI (not a request) when the setting is on and Gemini reports a match', async () => {
    setupThread({ ...baseThread, organizerPreApprovedTime: '4:30 PM' });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-07-18T16:30:00","matchesOrganizerPreApproval":true}');
    const res = await post({ From: '+15551234567', Body: 'yes' });
    expect(bookCalendarEvent).toHaveBeenCalledWith('2026-07-18T16:30:00', 'Bob', 'alice@example.com', 'America/Chicago');
    expect(sendOrganizerEmail).toHaveBeenCalled();
    expect(res.text).toContain('confirmed for');
    expect(sendSms).toHaveBeenCalledWith('+15550009999', expect.stringContaining('no action needed'));
    expect(sendSms).not.toHaveBeenCalledWith('+15550009999', expect.stringContaining('Reply YES'));
  });

  it('does not wait for organizer approval when auto-confirming', async () => {
    setupThread({ ...baseThread, organizerPreApprovedTime: '4:30 PM' });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-07-18T16:30:00","matchesOrganizerPreApproval":true}');
    await post({ From: '+15551234567', Body: 'yes' });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.status).toBe('confirmed');
    expect(saved.waitingForOrganizerApproval).toBe(false);
  });

  it('falls back to asking the organizer when the setting is off, even if Gemini reports a match', async () => {
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch.", confirmationMessage: 'Confirmed!', demoMode: false,
      autoConfirmPreApprovedTimes: false
    });
    setupThread({ ...baseThread, organizerPreApprovedTime: '4:30 PM' });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-07-18T16:30:00","matchesOrganizerPreApproval":true}');
    await post({ From: '+15551234567', Body: 'yes' });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.waitingForOrganizerApproval).toBe(true);
    expect(bookCalendarEvent).not.toHaveBeenCalled();
  });

  it('asks the organizer to confirm when Gemini does not report a match, even with the setting on', async () => {
    setupThread({ ...baseThread, organizerPreApprovedTime: null });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.waitingForOrganizerApproval).toBe(true);
    expect(bookCalendarEvent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/api/sms-reply.test.js -t "auto-confirm on pre-approved" -v`
Expected: FAIL — all four new tests fail because `handleContactReply` still always sets `waitingForOrganizerApproval = true` whenever `thread.organizerPhone` is set, regardless of `matchesOrganizerPreApproval`.

- [ ] **Step 3: Implement**

In `api/sms-reply.js`, replace:

```javascript
    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      if (thread.organizerPhone) {
        // Always require explicit organizer sign-off before finalizing, regardless of
        // how availability was communicated (specific times or an open window).
        thread.waitingForOrganizerApproval = true;
        thread.pendingContactSuggestion = formatConfirmedTime(parsed.datetime);
        thread.pendingContactDatetime = parsed.datetime;

        const holdMsg = truncate(
          `Just confirming with ${thread.organizerName} — I'll let you know shortly!`,
          settings.maxMessageLength
        );
        thread.conversationHistory.push({ role: 'model', content: holdMsg });

        const orgMsg = orgPrelude(thread.contactName, `agreed: ${formatConfirmedTime(parsed.datetime)}`) +
          `${thread.contactName} agreed to ${formatConfirmedTime(parsed.datetime)}. Reply YES to confirm or suggest an alternative.`;
        thread.organizerConversationHistory = thread.organizerConversationHistory || [];
        thread.organizerConversationHistory.push({ role: 'model', content: orgMsg });
        await saveBoth(thread);
        await demoSendSms(thread.organizerPhone, truncate(orgMsg, settings.maxMessageLength), settings.demoMode);
        console.log(`[sms-reply] contact agreed — awaiting organizer final confirm for thread ${thread.threadId}`);
        return res.send(twimlReply(holdMsg));
      }

      // No organizer phone — confirm immediately
      thread.status = 'confirmed';
      thread.confirmedDatetime = parsed.datetime;

      try {
        await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail, thread.timezone);
      } catch (calErr) {
        console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
      }
      await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, parsed.datetime, thread.timezone);

      const confirmMsg = truncate(
        applyTemplate(settings.confirmationMessage, {
          contactName: thread.contactName,
          organizerName: thread.organizerName,
          confirmedDatetime: formatConfirmedTime(parsed.datetime)
        }),
        settings.maxMessageLength
      );
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveBoth(thread);
      return res.send(twimlReply(confirmMsg));
```

with:

```javascript
    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      const autoConfirmEligible = Boolean(thread.organizerPhone)
        && settings.autoConfirmPreApprovedTimes === true
        && parsed.matchesOrganizerPreApproval === true;

      if (thread.organizerPhone && !autoConfirmEligible) {
        // Require explicit organizer sign-off before finalizing, unless the organizer
        // already unambiguously pre-approved this exact time (see autoConfirmEligible above).
        thread.waitingForOrganizerApproval = true;
        thread.pendingContactSuggestion = formatConfirmedTime(parsed.datetime);
        thread.pendingContactDatetime = parsed.datetime;

        const holdMsg = truncate(
          `Just confirming with ${thread.organizerName} — I'll let you know shortly!`,
          settings.maxMessageLength
        );
        thread.conversationHistory.push({ role: 'model', content: holdMsg });

        const orgMsg = orgPrelude(thread.contactName, `agreed: ${formatConfirmedTime(parsed.datetime)}`) +
          `${thread.contactName} agreed to ${formatConfirmedTime(parsed.datetime)}. Reply YES to confirm or suggest an alternative.`;
        thread.organizerConversationHistory = thread.organizerConversationHistory || [];
        thread.organizerConversationHistory.push({ role: 'model', content: orgMsg });
        await saveBoth(thread);
        await demoSendSms(thread.organizerPhone, truncate(orgMsg, settings.maxMessageLength), settings.demoMode);
        console.log(`[sms-reply] contact agreed — awaiting organizer final confirm for thread ${thread.threadId}`);
        return res.send(twimlReply(holdMsg));
      }

      // No organizer phone, or organizer already pre-approved this exact time — confirm immediately
      thread.status = 'confirmed';
      thread.confirmedDatetime = parsed.datetime;

      try {
        await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail, thread.timezone);
      } catch (calErr) {
        console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
      }
      await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, parsed.datetime, thread.timezone);

      const confirmMsg = truncate(
        applyTemplate(settings.confirmationMessage, {
          contactName: thread.contactName,
          organizerName: thread.organizerName,
          confirmedDatetime: formatConfirmedTime(parsed.datetime)
        }),
        settings.maxMessageLength
      );
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });

      if (autoConfirmEligible) {
        const orgFyi = orgPrelude(thread.contactName, `auto-confirmed: ${formatConfirmedTime(parsed.datetime)}`) +
          `${thread.contactName} confirmed ${formatConfirmedTime(parsed.datetime)} — already booked per your earlier OK, no action needed!`;
        thread.organizerConversationHistory = thread.organizerConversationHistory || [];
        thread.organizerConversationHistory.push({ role: 'model', content: orgFyi });
        await saveBoth(thread);
        await demoSendSms(thread.organizerPhone, truncate(orgFyi, settings.maxMessageLength), settings.demoMode);
        console.log(`[sms-reply] auto-confirmed pre-approved time for thread ${thread.threadId}, organizer notified`);
      } else {
        await saveBoth(thread);
      }

      return res.send(twimlReply(confirmMsg));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/api/sms-reply.test.js -v`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add api/sms-reply.js tests/api/sms-reply.test.js
git commit -m "feat: skip final organizer confirmation for pre-approved exact times"
```

---

### Task 8: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all suites pass (no regressions across any file touched in Tasks 1-7).

- [ ] **Step 2: Manual smoke test**

Run `vercel dev`, and using demo mode (Settings → Demo Mode on) plus the demo reply buttons on the page:
1. Submit a request with one contact time and an organizer phone, no backup times.
2. As the organizer, reply with a single specific time (e.g. "4:30pm works").
3. As the contact, agree to that exact time.
4. Confirm: the contact gets a confirmation message immediately, the organizer gets an FYI (not a "Reply YES" request), and the conversation log shows `status: confirmed` without ever setting `waitingForOrganizerApproval`.
5. Repeat with Settings → "Skip final confirmation for pre-approved times" turned off, and confirm the organizer is asked to confirm again (today's behavior).

- [ ] **Step 3: Commit (only if Step 2 surfaced fixes)**

If the manual smoke test passes with no changes needed, there is nothing to commit for this task — Tasks 1-7 already committed everything. If it surfaces a bug, fix it, re-run `npm test`, and commit:

```bash
git add -A
git commit -m "fix: <describe the smoke-test fix>"
```
