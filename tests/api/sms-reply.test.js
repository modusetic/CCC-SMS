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

const post = (body) => request(app).post('/api/sms-reply').type('form').send(body);

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

  it('books calendar and emails organizer on confirmed JSON', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    getNextReply.mockResolvedValue('{"status":"confirmed","datetime":"2026-05-12T14:00:00"}');
    await post({ From: '+15551234567', Body: 'Monday at 2pm works!' });
    expect(bookCalendarEvent).toHaveBeenCalledWith('2026-05-12T14:00:00', 'Bob', 'alice@example.com');
    expect(sendOrganizerEmail).toHaveBeenCalledWith('alice@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00');
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
});

describe('organizer messages — initial review', () => {
  const waitingThread = { ...baseThread, status: 'waiting_organizer_initial' };

  it('contacts the contact with proposed times when organizer replies APPROVE', async () => {
    getThread.mockResolvedValue({ ...waitingThread });
    const res = await post({ From: '+15550009999', Body: 'Approve' });
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Monday at 2pm'));
    expect(res.text).toContain('reached out');
  });

  it('contacts the contact with organizer alternative times', async () => {
    getThread.mockResolvedValue({ ...waitingThread });
    const res = await post({ From: '+15550009999', Body: 'Wednesday at 3pm or Thursday at 11am' });
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Wednesday at 3pm'));
    expect(res.text).toContain("sent");
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
});

describe('organizer messages — counter-proposal approval', () => {
  const pendingThread = {
    ...baseThread,
    waitingForOrganizerApproval: true,
    pendingContactSuggestion: 'Friday May 22 at 2pm',
    pendingContactDatetime: '2026-05-22T14:00:00'
  };

  it('confirms meeting when organizer replies YES', async () => {
    getThread.mockResolvedValue({ ...pendingThread });
    const res = await post({ From: '+15550009999', Body: 'Yes' });
    expect(bookCalendarEvent).toHaveBeenCalledWith('2026-05-22T14:00:00', 'Bob', 'alice@example.com');
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('confirmed'));
    expect(res.text).toContain('Confirmed');
  });

  it('forwards organizer alternative times to contact', async () => {
    getThread.mockResolvedValue({ ...pendingThread });
    const res = await post({ From: '+15550009999', Body: 'Monday at 3pm or Tuesday at 11am' });
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Monday at 3pm'));
    expect(bookCalendarEvent).not.toHaveBeenCalled();
    expect(res.text).toContain('forwarded');
  });

  it('does nothing if organizer replies with no pending approval', async () => {
    getThread.mockResolvedValue({ ...baseThread });
    const res = await post({ From: '+15550009999', Body: 'Hello' });
    expect(sendSms).not.toHaveBeenCalled();
    expect(res.text).toBe('<Response></Response>');
  });
});
