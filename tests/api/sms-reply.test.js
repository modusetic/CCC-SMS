const request = require('supertest');

const baseThread = {
  threadId: 'test-uuid',
  contactName: 'Bob',
  contactPhone: '+15551234567',
  organizerName: 'Alice',
  organizerEmail: 'alice@example.com',
  organizerPhone: '+15550009999',
  proposedTimes: ['Monday at 2pm', 'Tuesday at 10am'],
  directorAlternatives: [],
  directorMessages: [],
  rejectedTimes: [],
  offeredTimes: ['Monday at 2pm', 'Tuesday at 10am'],
  confirmedDatetime: null,
  lastActivityAt: '2026-05-07T10:00:00.000Z',
  timezone: 'America/Chicago',
  status: 'pending',
  waitingForOrganizerApproval: false,
  pendingContactSuggestion: null,
  pendingContactDatetime: null,
  attempts: 0,
  conversationHistory: [{ role: 'model', content: 'Hi Bob! Which time works?' }],
  createdAt: '2026-05-07T10:00:00.000Z'
};

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

jest.mock('../../lib/twilio', () => ({
  sendSms: jest.fn().mockResolvedValue('SM123')
}));

jest.mock('../../lib/gemini', () => ({
  getNextReply: jest.fn(),
  getOrganizerInitialContactMessage: jest.fn(),
  getOrganizerApprovalDecision: jest.fn(),
  getOrganizerUpdateReply: jest.fn()
}));

jest.mock('../../lib/calendar', () => ({
  bookCalendarEvent: jest.fn().mockResolvedValue({ id: 'cal-event-1' })
}));

jest.mock('../../lib/email', () => ({
  sendOrganizerEmail: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../lib/settings', () => ({
  getSettings: jest.fn()
}));

const { getThreadById, saveThreadById, getPhoneIndex, removeFromPhoneIndex,
        getPendingMessage, setPendingMessage, deletePendingMessage } = require('../../lib/kv');
const { sendSms } = require('../../lib/twilio');
const { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply } = require('../../lib/gemini');
const { bookCalendarEvent } = require('../../lib/calendar');
const { sendOrganizerEmail } = require('../../lib/email');
const { getSettings } = require('../../lib/settings');
const app = require('../../api/sms-reply');

const post = (body) => request(app).post('/api/sms-reply').type('form').send(body);

function setupThread(thread) {
  getPhoneIndex.mockResolvedValue([thread.threadId]);
  getThreadById.mockResolvedValue({ ...thread });
}

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
});

describe('contact messages — standard flow', () => {
  it('responds 200 with TwiML', async () => {
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('How about Wednesday?');
    const res = await post({ From: '+15551234567', Body: 'Monday does not work' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');
  });

  it('returns polite TwiML when no thread found', async () => {
    getPhoneIndex.mockResolvedValue([]);
    const res = await post({ From: '+15559999999', Body: 'Hello' });
    expect(res.text).toContain("don't have an active scheduling request");
  });

  it('returns Gemini reply in TwiML for conversational response', async () => {
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('How about Wednesday at 3pm?');
    const res = await post({ From: '+15551234567', Body: 'Monday does not work' });
    expect(res.text).toContain('How about Wednesday at 3pm?');
  });

  it('holds contact with polite message when organizer has not yet reviewed', async () => {
    setupThread({ ...baseThread, status: 'waiting_organizer_initial' });
    const res = await post({ From: '+15551234567', Body: 'Hello' });
    expect(res.text).toContain("be in touch soon");
    expect(getNextReply).not.toHaveBeenCalled();
  });

  it('falls back to defaults when getSettings fails and still responds', async () => {
    setupThread({ ...baseThread });
    getSettings.mockRejectedValue(new Error('Redis timeout'));
    getNextReply.mockResolvedValue('How about Wednesday?');
    const res = await post({ From: '+15551234567', Body: 'Monday does not work' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');
  });

  it('does not SMS organizer when demoMode is true', async () => {
    setupThread({ ...baseThread });
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch.", confirmationMessage: 'Confirmed!', demoMode: true
    });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('SMSes organizer with confirmed time when contact confirms directly', async () => {
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(sendSms).toHaveBeenCalledWith('+15550009999', expect.stringContaining('May 12 at 2:00 PM'));
  });

  it('books calendar and emails organizer on confirmed JSON', async () => {
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(bookCalendarEvent).toHaveBeenCalledWith('2026-05-12T14:00:00', 'Bob', 'alice@example.com', 'America/Chicago');
    expect(sendOrganizerEmail).toHaveBeenCalledWith('alice@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00', 'America/Chicago');
  });

  it('returns confirmation TwiML to contact after booking', async () => {
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    const res = await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(res.text).toContain('confirmed');
  });

  it('SMSes organizer and sends holding reply on counter-proposal', async () => {
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue(JSON.stringify({
      status: 'counter-proposal',
      suggestedTime: 'Friday May 22 at 2pm',
      suggestedDatetime: '2026-05-22T14:00:00',
      reply: "I'll check with Alice and get back to you!"
    }));
    const res = await post({ From: '+15551234567', Body: 'Can I do Friday at 2pm?' });
    expect(res.text).toContain("I'll check with Alice");
    expect(sendSms).toHaveBeenCalledWith('+15550009999', expect.stringContaining('Friday May 22 at 2pm'));
  });

  it('records counter-proposal ping in organizerConversationHistory', async () => {
    saveThreadById.mockClear();
    setupThread({ ...baseThread, organizerConversationHistory: [] });
    getNextReply.mockResolvedValue(JSON.stringify({
      status: 'counter-proposal',
      suggestedTime: 'Friday May 22 at 2pm',
      suggestedDatetime: '2026-05-22T14:00:00',
      reply: "I'll check with Alice and get back to you!"
    }));
    await post({ From: '+15551234567', Body: 'Can I do Friday at 2pm?' });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(1);
    expect(saved.organizerConversationHistory[0].role).toBe('model');
    expect(saved.organizerConversationHistory[0].content).toContain('Friday May 22 at 2pm');
  });

  it('removes thread from phone index for contact and organizer on confirmation', async () => {
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(removeFromPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid');
    expect(removeFromPhoneIndex).toHaveBeenCalledWith('+15550009999', 'test-uuid');
  });
});

describe('organizer messages — initial review', () => {
  const waitingThread = { ...baseThread, status: 'waiting_organizer_initial' };

  beforeEach(() => {
    getOrganizerInitialContactMessage.mockResolvedValue(
      "Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday at 10am. Which works for you?"
    );
  });

  it('calls Gemini with organizer name, contact name, proposed times, and full message', async () => {
    setupThread({ ...waitingThread });
    await post({ From: '+15550009999', Body: 'Approve' });
    expect(getOrganizerInitialContactMessage).toHaveBeenCalledWith(
      'Alice', 'Bob', expect.any(Array), 'Approve', expect.any(Object)
    );
  });

  it('passes the full organizer message to Gemini regardless of content', async () => {
    setupThread({ ...waitingThread });
    await post({ From: '+15550009999', Body: "I can't June 1st but June 5 at 5pm works" });
    expect(getOrganizerInitialContactMessage).toHaveBeenCalledWith(
      'Alice', 'Bob', expect.any(Array), "I can't June 1st but June 5 at 5pm works", expect.any(Object)
    );
  });

  it('sends the Gemini-generated message to the contact', async () => {
    setupThread({ ...waitingThread });
    await post({ From: '+15550009999', Body: 'Approve' });
    expect(sendSms).toHaveBeenCalledWith('+15551234567',
      "Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday at 10am. Which works for you?"
    );
  });

  it('acknowledges the organizer', async () => {
    setupThread({ ...waitingThread });
    const res = await post({ From: '+15550009999', Body: 'Approve' });
    expect(res.text).toContain('Bob');
  });

  it('stores organizer initial review message in directorMessages', async () => {
    setupThread({ ...waitingThread });
    await post({ From: '+15550009999', Body: 'I can only meet June 13 at 5pm' });
    expect(saveThreadById.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        directorMessages: expect.arrayContaining(['I can only meet June 13 at 5pm'])
      })
    );
  });

  it('sets thread status to pending after initial review', async () => {
    setupThread({ ...waitingThread });
    await post({ From: '+15550009999', Body: 'Yes' });
    expect(saveThreadById.mock.calls[0][1]).toEqual(
      expect.objectContaining({ status: 'pending' })
    );
  });

  it('returns polite error TwiML to organizer when Gemini throws during initial review', async () => {
    setupThread({ ...waitingThread });
    getOrganizerInitialContactMessage.mockRejectedValue(new Error('Gemini API error'));
    const res = await post({ From: '+15550009999', Body: 'Approve' });
    expect(res.status).toBe(200);
    // Must not be an empty silent response
    expect(res.text).not.toBe('<Response></Response>');
    // Must contain a polite error message the organizer can read
    expect(res.text).toContain('went wrong');
  });
});

describe('organizer messages — counter-proposal approval', () => {
  const pendingThread = {
    ...baseThread,
    waitingForOrganizerApproval: true,
    pendingContactSuggestion: 'Friday May 22 at 2pm',
    pendingContactDatetime: '2026-05-22T14:00:00'
  };

  it('confirms meeting when Gemini decides the organizer approved', async () => {
    setupThread({ ...pendingThread });
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: true,
      contactMsg: "Great news! Your meeting is confirmed for Friday May 22 at 2pm.",
      organizerAck: "Confirmed! I've let Bob know."
    });
    const res = await post({ From: '+15550009999', Body: 'Yes that works' });
    expect(bookCalendarEvent).toHaveBeenCalledWith('2026-05-22T14:00:00', 'Bob', 'alice@example.com', 'America/Chicago');
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('confirmed'));
    expect(res.text).toContain('Confirmed');
  });

  it('correctly handles "Would 5pm be OK?" as a non-approval', async () => {
    setupThread({ ...pendingThread });
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: false,
      contactMsg: "Alice is free June 5 at 5pm instead — does that work for you?",
      organizerAck: "Got it! I've forwarded your message to Bob."
    });
    const res = await post({ From: '+15550009999', Body: "I can't June 1st but June 5 may work. Not at 4pm though. Would 5pm be OK?" });
    expect(bookCalendarEvent).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('5pm'));
    expect(res.text).toContain('forwarded');
  });

  it('forwards organizer alternative times to contact', async () => {
    setupThread({ ...pendingThread });
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: false,
      contactMsg: "Alice suggests Monday at 3pm instead — does that work?",
      organizerAck: "Got it! I've forwarded your message to Bob."
    });
    const res = await post({ From: '+15550009999', Body: 'Monday at 3pm or Tuesday at 11am' });
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Monday at 3pm'));
    expect(bookCalendarEvent).not.toHaveBeenCalled();
    expect(res.text).toContain('forwarded');
  });

  it('saves contactMsg to conversationHistory when organizer rejects counter-proposal', async () => {
    saveThreadById.mockClear();
    setupThread({ ...pendingThread, conversationHistory: [] });
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: false,
      contactMsg: "Alice suggests Monday at 3pm instead.",
      organizerAck: "Got it! I've forwarded your message to Bob."
    });
    await post({ From: '+15550009999', Body: 'Monday at 3pm instead' });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.conversationHistory).toHaveLength(1);
    expect(saved.conversationHistory[0]).toEqual({ role: 'model', content: "Alice suggests Monday at 3pm instead." });
  });

});

describe('organizer messages — unsolicited availability update', () => {
  beforeEach(() => {
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is now free at 3pm instead. Does that work for you?");
  });

  it('uses Gemini to craft a message to the contact', async () => {
    setupThread({ ...baseThread });
    await post({ From: '+15550009999', Body: "I can't May 26 at 2pm but I can at 3pm" });
    expect(getOrganizerUpdateReply).toHaveBeenCalledWith(
      'Alice',
      'Bob',
      "I can't May 26 at 2pm but I can at 3pm",
      expect.any(Object),
      expect.any(Object)  // context: { proposedTimes, directorAlternatives, lastContactMsg }
    );
  });

  it('sends Gemini reply to the contact', async () => {
    setupThread({ ...baseThread });
    await post({ From: '+15550009999', Body: "I can't May 26 at 2pm but I can at 3pm" });
    expect(sendSms).toHaveBeenCalledWith('+15551234567', "Hi Bob! Alice is now free at 3pm instead. Does that work for you?");
  });

  it('acknowledges the organizer by contact name', async () => {
    setupThread({ ...baseThread });
    const res = await post({ From: '+15550009999', Body: "Only available Thursday at noon" });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Bob');
  });

  it('adds organizer update to directorMessages', async () => {
    setupThread({ ...baseThread });
    await post({ From: '+15550009999', Body: 'Try Friday at 4pm instead' });
    expect(saveThreadById.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        directorMessages: expect.arrayContaining(['Try Friday at 4pm instead'])
      })
    );
  });

  it('saves AI reply to conversationHistory when organizer sends unsolicited update', async () => {
    saveThreadById.mockClear();
    setupThread({ ...baseThread, conversationHistory: [] });
    await post({ From: '+15550009999', Body: "I can't May 26 at 2pm but I can at 3pm" });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.conversationHistory).toHaveLength(1);
    expect(saved.conversationHistory[0]).toEqual({
      role: 'model',
      content: "Hi Bob! Alice is now free at 3pm instead. Does that work for you?"
    });
  });
});

describe('organizer messages — organizerConversationHistory tracking', () => {
  const waitingThread = { ...baseThread, status: 'waiting_organizer_initial' };
  const pendingThread = {
    ...baseThread,
    waitingForOrganizerApproval: true,
    pendingContactSuggestion: 'Friday May 22 at 2pm',
    pendingContactDatetime: '2026-05-22T14:00:00'
  };

  beforeEach(() => {
    saveThreadById.mockClear();
    sendSms.mockClear();
    getOrganizerInitialContactMessage.mockResolvedValue(
      "Hey Bob! Alice wants to meet — Monday at 2pm. Which works?"
    );
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: true,
      contactMsg: "Great news! Your meeting is confirmed.",
      organizerAck: "Confirmed! I've let Bob know."
    });
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is free at 3pm instead.");
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on initial review approval', async () => {
    setupThread({ ...waitingThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: 'Approve' });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: 'Approve' });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
    expect(saved.organizerConversationHistory[1].content).toContain('Bob');
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on counter-proposal approval', async () => {
    setupThread({ ...pendingThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: 'Yes' });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: 'Yes' });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
    expect(saved.organizerConversationHistory[1].content).toMatch(/confirmed/i);
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on rejection/alternatives', async () => {
    setupThread({ ...pendingThread, organizerConversationHistory: [] });
    getOrganizerApprovalDecision.mockResolvedValueOnce({
      approved: false,
      contactMsg: "Alice suggests Monday at 3pm instead.",
      organizerAck: "Got it! I've forwarded your message to Bob."
    });
    await post({ From: '+15550009999', Body: 'Monday at 3pm instead' });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: 'Monday at 3pm instead' });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
    expect(saved.organizerConversationHistory[1].content).toMatch(/forwarded/i);
  });

  it('pushes organizer reply and system ack to organizerConversationHistory on unsolicited update', async () => {
    setupThread({ ...baseThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: "I can't Monday, try 3pm" });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
    expect(saved.organizerConversationHistory[0]).toEqual({ role: 'user', content: "I can't Monday, try 3pm" });
    expect(saved.organizerConversationHistory[1].role).toBe('model');
  });

  it('exercises defensive guard when organizerConversationHistory is undefined', async () => {
    // Thread has no organizerConversationHistory at all (simulates old threads from before schema update)
    const threadWithoutHistory = { ...baseThread, organizerConversationHistory: undefined };
    setupThread(threadWithoutHistory);
    getNextReply.mockResolvedValue('How about Wednesday?');
    // Just make sure it doesn't throw
    const res = await post({ From: '+15550009999', Body: "I can't Monday, try 3pm" });
    expect(res.status).toBe(200);
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
  });

  it('saves updated organizerConversationHistory in thread', async () => {
    setupThread({ ...baseThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: "I can't Monday, try 3pm" });
    const saved = saveThreadById.mock.calls.slice(-1)[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
  });
});

describe('contact texts while waiting for organizer approval (counter-proposal hold)', () => {
  const pendingApprovalThread = {
    ...baseThread,
    waitingForOrganizerApproval: true,
    pendingContactSuggestion: 'Friday May 22 at 2pm',
    pendingContactDatetime: '2026-05-22T14:00:00'
  };

  it('returns a hold message without calling Gemini', async () => {
    setupThread({ ...pendingApprovalThread });
    const res = await post({ From: '+15551234567', Body: 'Any update?' });
    expect(res.status).toBe(200);
    expect(getNextReply).not.toHaveBeenCalled();
    expect(res.text).toContain('checking with Alice');
  });

  it('does not increment attempts or modify thread', async () => {
    saveThreadById.mockClear();
    setupThread({ ...pendingApprovalThread });
    await post({ From: '+15551234567', Body: 'Any update?' });
    expect(saveThreadById).not.toHaveBeenCalled();
  });
});

describe('maxExchanges hard stop', () => {
  it('sends final give-up message when attempts reaches maxExchanges', async () => {
    setupThread({ ...baseThread, attempts: 6 });
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch.", confirmationMessage: 'Confirmed!', demoMode: false
    });
    const res = await post({ From: '+15551234567', Body: 'Still nothing works for me' });
    expect(getNextReply).not.toHaveBeenCalled();
    expect(res.text).toContain('Alice');
    expect(res.text).toContain('will be in touch');
  });

  it('does not send final message when attempts is one below maxExchanges', async () => {
    setupThread({ ...baseThread, attempts: 5 });
    getNextReply.mockResolvedValue('How about Thursday?');
    const res = await post({ From: '+15551234567', Body: 'Wednesday also does not work' });
    expect(getNextReply).toHaveBeenCalled();
    expect(res.text).toContain('Thursday');
  });

  it('saves the final message to conversationHistory', async () => {
    saveThreadById.mockClear();
    setupThread({ ...baseThread, attempts: 6, conversationHistory: [] });
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch.", confirmationMessage: 'Confirmed!', demoMode: false
    });
    await post({ From: '+15551234567', Body: 'Nothing works' });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.conversationHistory).toHaveLength(1);
    expect(saved.conversationHistory[0].role).toBe('model');
  });
});

describe('contact messages during waiting_organizer_initial are recorded', () => {
  it('saves contact message and holding response to conversationHistory', async () => {
    saveThreadById.mockClear();
    setupThread({ ...baseThread, status: 'waiting_organizer_initial', conversationHistory: [] });
    await post({ From: '+15551234567', Body: 'I prefer mornings' });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.conversationHistory).toHaveLength(2);
    expect(saved.conversationHistory[0]).toEqual({ role: 'user', content: 'I prefer mornings' });
    expect(saved.conversationHistory[1].role).toBe('model');
  });

  it('still sends the holding message TwiML response', async () => {
    setupThread({ ...baseThread, status: 'waiting_organizer_initial', conversationHistory: [] });
    const res = await post({ From: '+15551234567', Body: 'I prefer mornings' });
    expect(res.text).toContain('be in touch soon');
  });
});

describe('organizer approval decision receives context', () => {
  it('passes directorAlternatives to getOrganizerApprovalDecision', async () => {
    const threadWithAlts = {
      ...baseThread,
      waitingForOrganizerApproval: true,
      pendingContactSuggestion: 'Friday at 2pm',
      pendingContactDatetime: '2026-05-22T14:00:00',
      directorAlternatives: ['Monday at 3pm', 'Tuesday at 11am']
    };
    setupThread(threadWithAlts);
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: false,
      contactMsg: 'Alice suggests Monday at 3pm — does that work?',
      organizerAck: "Got it, I've forwarded."
    });
    await post({ From: '+15550009999', Body: "Friday doesn't work, try Monday at 3pm" });
    expect(getOrganizerApprovalDecision).toHaveBeenCalledWith(
      'Alice', 'Bob', 'Friday at 2pm',
      "Friday doesn't work, try Monday at 3pm",
      expect.any(Object),
      expect.objectContaining({ directorAlternatives: ['Monday at 3pm', 'Tuesday at 11am'] })
    );
  });
});

describe('confirmedDatetime and rejectedTimes tracking', () => {
  it('sets confirmedDatetime on thread when contact directly confirms', async () => {
    saveThreadById.mockClear();
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.confirmedDatetime).toBe('2026-05-12T14:00:00');
  });

  it('sets confirmedDatetime when organizer approves counter-proposal', async () => {
    saveThreadById.mockClear();
    const pendingThread = {
      ...baseThread,
      waitingForOrganizerApproval: true,
      pendingContactSuggestion: 'Friday May 22 at 2pm',
      pendingContactDatetime: '2026-05-22T14:00:00'
    };
    setupThread(pendingThread);
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: true,
      contactMsg: 'Meeting confirmed for Friday May 22 at 2pm!',
      organizerAck: "Confirmed! I've let Bob know."
    });
    await post({ From: '+15550009999', Body: 'Yes that works' });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.confirmedDatetime).toBe('2026-05-22T14:00:00');
  });

  it('adds pendingContactSuggestion to rejectedTimes when organizer rejects', async () => {
    saveThreadById.mockClear();
    const pendingThread = {
      ...baseThread,
      waitingForOrganizerApproval: true,
      pendingContactSuggestion: 'Friday May 22 at 2pm',
      pendingContactDatetime: '2026-05-22T14:00:00',
      rejectedTimes: []
    };
    setupThread(pendingThread);
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: false,
      contactMsg: 'Alice suggests Monday at 3pm instead.',
      organizerAck: "Got it, forwarding."
    });
    await post({ From: '+15550009999', Body: 'Not Friday, try Monday at 3pm' });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.rejectedTimes).toContain('Friday May 22 at 2pm');
  });

  it('updates lastActivityAt on saveBoth', async () => {
    saveThreadById.mockClear();
    setupThread({ ...baseThread });
    getNextReply.mockResolvedValue('How about Wednesday?');
    await post({ From: '+15551234567', Body: 'Monday does not work' });
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.lastActivityAt).toBeDefined();
    expect(saved.lastActivityAt).not.toBe('2026-05-07T10:00:00.000Z');
  });
});

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

  it('shows disambiguation list when none are waiting (unsolicited update with 2 active)', async () => {
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

  it('auto-routes pending message to single remaining waiting thread when list becomes stale', async () => {
    // Organizer had 2 waiting threads, but now only 1 remains (the other got confirmed)
    getPendingMessage.mockResolvedValue('Yes, Friday works for me');
    getPhoneIndex.mockResolvedValue(['uuid-1']); // only uuid-1 remains
    getThreadById.mockResolvedValue({
      ...baseThread,
      threadId: 'uuid-1',
      contactName: 'Bob Smith',
      waitingForOrganizerApproval: true,
      pendingContactSuggestion: 'Friday May 30 at 2pm',
      pendingContactDatetime: '2026-05-30T14:00:00'
    });
    getOrganizerApprovalDecision.mockResolvedValue({
      approved: true,
      contactMsg: 'Meeting confirmed!',
      organizerAck: "Confirmed! I've let Bob know."
    });
    await post({ From: '+15550009999', Body: 'random text' }); // any body — pending msg is used
    expect(deletePendingMessage).toHaveBeenCalledWith('+15550009999');
    expect(getOrganizerApprovalDecision).toHaveBeenCalled();
  });
});

describe('SMS template substitution', () => {
  it('substitutes {organizerName} in confirmationMessage', async () => {
    setupThread({ ...baseThread });
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch soon.",
      confirmationMessage: 'Your meeting with {organizerName} is set!'
    });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-06-01T14:00:00"}');
    const res = await post({ From: '+15551234567', Body: 'Monday works!' });
    expect(res.text).toContain('Alice'); // {organizerName} replaced with thread.organizerName
  });

  it('substitutes {confirmedDatetime} in confirmationMessage with human-readable time', async () => {
    setupThread({ ...baseThread });
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch soon.",
      confirmationMessage: 'Confirmed for {confirmedDatetime}!'
    });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    const res = await post({ From: '+15551234567', Body: 'Monday works!' });
    // formatConfirmedTime('2026-05-12T14:00:00') → 'May 12 at 2:00 PM'
    expect(res.text).toContain('May 12 at 2:00 PM');
  });

  it('substitutes {contactName} and {organizerName} in holdingMessage', async () => {
    setupThread({ ...baseThread, status: 'waiting_organizer_initial' });
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
