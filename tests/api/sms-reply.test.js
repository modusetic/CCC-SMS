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
  getThread: jest.fn(),
  saveThread: jest.fn().mockResolvedValue(undefined)
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

const { getThread } = require('../../lib/kv');
const { sendSms } = require('../../lib/twilio');
const { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply } = require('../../lib/gemini');
const { bookCalendarEvent } = require('../../lib/calendar');
const { sendOrganizerEmail } = require('../../lib/email');
const { getSettings } = require('../../lib/settings');
const app = require('../../api/sms-reply');

const post = (body) => request(app).post('/api/sms-reply').type('form').send(body);

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

describe('contact messages — standard flow', () => {
  it('responds 200 with TwiML', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('How about Wednesday?');
    const res = await post({ From: '+15551234567', Body: 'Monday does not work' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');
  });

  it('returns polite TwiML when no thread found', async () => {
    getThread.mockResolvedValue(null);
    const res = await post({ From: '+15559999999', Body: 'Hello' });
    expect(res.text).toContain("don't have an active scheduling request");
  });

  it('returns Gemini reply in TwiML for conversational response', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('How about Wednesday at 3pm?');
    const res = await post({ From: '+15551234567', Body: 'Monday does not work' });
    expect(res.text).toContain('How about Wednesday at 3pm?');
  });

  it('holds contact with polite message when organizer has not yet reviewed', async () => {
    getThread.mockResolvedValue({ ...baseThread, status: 'waiting_organizer_initial' });
    const res = await post({ From: '+15551234567', Body: 'Hello' });
    expect(res.text).toContain("be in touch soon");
    expect(getNextReply).not.toHaveBeenCalled();
  });

  it('falls back to defaults when getSettings fails and still responds', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getSettings.mockRejectedValue(new Error('Redis timeout'));
    getNextReply.mockResolvedValue('How about Wednesday?');
    const res = await post({ From: '+15551234567', Body: 'Monday does not work' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response>');
  });

  it('books calendar and emails organizer on confirmed JSON', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(bookCalendarEvent).toHaveBeenCalledWith('2026-05-12T14:00:00', 'Bob', 'alice@example.com', 'America/Chicago');
    expect(sendOrganizerEmail).toHaveBeenCalledWith('alice@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00', 'America/Chicago');
  });

  it('returns confirmation TwiML to contact after booking', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    const res = await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(res.text).toContain('confirmed');
  });

  it('SMSes organizer and sends holding reply on counter-proposal', async () => {
    getThread.mockResolvedValue({ ...baseThread });
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
    const { saveThread } = require('../../lib/kv');
    saveThread.mockClear();
    getThread.mockResolvedValue({ ...baseThread, organizerConversationHistory: [] });
    getNextReply.mockResolvedValue(JSON.stringify({
      status: 'counter-proposal',
      suggestedTime: 'Friday May 22 at 2pm',
      suggestedDatetime: '2026-05-22T14:00:00',
      reply: "I'll check with Alice and get back to you!"
    }));
    await post({ From: '+15551234567', Body: 'Can I do Friday at 2pm?' });
    const saved = saveThread.mock.calls.find(c => c[0] === '+15550009999')[1];
    expect(saved.organizerConversationHistory).toHaveLength(1);
    expect(saved.organizerConversationHistory[0].role).toBe('model');
    expect(saved.organizerConversationHistory[0].content).toContain('Friday May 22 at 2pm');
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
    getThread.mockResolvedValue({ ...waitingThread });
    await post({ From: '+15550009999', Body: 'Approve' });
    expect(getOrganizerInitialContactMessage).toHaveBeenCalledWith(
      'Alice', 'Bob', expect.any(Array), 'Approve', expect.any(Object)
    );
  });

  it('passes the full organizer message to Gemini regardless of content', async () => {
    getThread.mockResolvedValue({ ...waitingThread });
    await post({ From: '+15550009999', Body: "I can't June 1st but June 5 at 5pm works" });
    expect(getOrganizerInitialContactMessage).toHaveBeenCalledWith(
      'Alice', 'Bob', expect.any(Array), "I can't June 1st but June 5 at 5pm works", expect.any(Object)
    );
  });

  it('sends the Gemini-generated message to the contact', async () => {
    getThread.mockResolvedValue({ ...waitingThread });
    await post({ From: '+15550009999', Body: 'Approve' });
    expect(sendSms).toHaveBeenCalledWith('+15551234567',
      "Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday at 10am. Which works for you?"
    );
  });

  it('acknowledges the organizer', async () => {
    getThread.mockResolvedValue({ ...waitingThread });
    const res = await post({ From: '+15550009999', Body: 'Approve' });
    expect(res.text).toContain('Bob');
  });

  it('sets thread status to pending after initial review', async () => {
    const { saveThread } = require('../../lib/kv');
    getThread.mockResolvedValue({ ...waitingThread });
    await post({ From: '+15550009999', Body: 'Yes' });
    expect(saveThread).toHaveBeenCalledWith(
      '+15551234567',
      expect.objectContaining({ status: 'pending' })
    );
  });

  it('returns polite error TwiML to organizer when Gemini throws during initial review', async () => {
    getThread.mockResolvedValue({ ...waitingThread });
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
    getThread.mockResolvedValue({ ...pendingThread });
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
    getThread.mockResolvedValue({ ...pendingThread });
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
    getThread.mockResolvedValue({ ...pendingThread });
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

});

describe('organizer messages — unsolicited availability update', () => {
  beforeEach(() => {
    getOrganizerUpdateReply.mockResolvedValue("Hi Bob! Alice is now free at 3pm instead. Does that work for you?");
  });

  it('uses Gemini to craft a message to the contact', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    await post({ From: '+15550009999', Body: "I can't May 26 at 2pm but I can at 3pm" });
    expect(getOrganizerUpdateReply).toHaveBeenCalledWith(
      'Alice',
      'Bob',
      "I can't May 26 at 2pm but I can at 3pm",
      expect.any(Object)
    );
  });

  it('sends Gemini reply to the contact', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    await post({ From: '+15550009999', Body: "I can't May 26 at 2pm but I can at 3pm" });
    expect(sendSms).toHaveBeenCalledWith('+15551234567', "Hi Bob! Alice is now free at 3pm instead. Does that work for you?");
  });

  it('acknowledges the organizer by contact name', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    const res = await post({ From: '+15550009999', Body: "Only available Thursday at noon" });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Bob');
  });

  it('adds organizer update to directorAlternatives', async () => {
    const { saveThread } = require('../../lib/kv');
    getThread.mockResolvedValue({ ...baseThread });
    await post({ From: '+15550009999', Body: 'Try Friday at 4pm instead' });
    expect(saveThread).toHaveBeenCalledWith(
      '+15551234567',
      expect.objectContaining({
        directorAlternatives: expect.arrayContaining(['Try Friday at 4pm instead'])
      })
    );
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
    const { saveThread } = require('../../lib/kv');
    saveThread.mockClear();
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
    getOrganizerApprovalDecision.mockResolvedValueOnce({
      approved: false,
      contactMsg: "Alice suggests Monday at 3pm instead.",
      organizerAck: "Got it! I've forwarded your message to Bob."
    });
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

  it('exercises defensive guard when organizerConversationHistory is undefined', async () => {
    const { saveThread } = require('../../lib/kv');
    // Thread has no organizerConversationHistory at all (simulates old threads from before schema update)
    const threadWithoutHistory = { ...baseThread, organizerConversationHistory: undefined };
    getThread.mockResolvedValue(threadWithoutHistory);
    getNextReply.mockResolvedValue('How about Wednesday?');
    // Just make sure it doesn't throw
    const res = await post({ From: '+15550009999', Body: "I can't Monday, try 3pm" });
    expect(res.status).toBe(200);
    const saved = saveThread.mock.calls.find(c => c[0] === '+15550009999')[1];
    expect(saved.organizerConversationHistory).toHaveLength(2);
  });

  it('saves updated organizerConversationHistory under the contact phone key too', async () => {
    const { saveThread } = require('../../lib/kv');
    getThread.mockResolvedValue({ ...baseThread, organizerConversationHistory: [] });
    await post({ From: '+15550009999', Body: "I can't Monday, try 3pm" });
    const contactSaved = saveThread.mock.calls.find(c => c[0] === '+15551234567')[1];
    expect(contactSaved.organizerConversationHistory).toHaveLength(2);
  });
});

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
