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
