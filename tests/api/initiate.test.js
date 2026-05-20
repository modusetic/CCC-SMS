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
        organizerPhone: null,
        proposedTimes: ['Monday May 12 at 2pm', 'Tuesday May 13 at 10am'],
        directorAlternatives: [],
        status: 'pending',
        waitingForOrganizerApproval: false,
        pendingContactSuggestion: null,
        pendingContactDatetime: null,
        attempts: 0,
        conversationHistory: expect.any(Array),
        createdAt: expect.any(String)
      })
    );
  });

  it('also saves thread under organizerPhone when provided', async () => {
    await request(app).post('/api/initiate').send({
      ...validBody,
      organizerPhone: '+15550009999'
    });
    expect(saveThread).toHaveBeenCalledWith('+15550009999', expect.any(Object));
  });

  it('stores directorAlternatives in thread when provided', async () => {
    await request(app).post('/api/initiate').send({
      ...validBody,
      directorAlternatives: ['Wednesday at 3pm', 'Thursday at 11am']
    });
    expect(saveThread).toHaveBeenCalledWith(
      '+15551234567',
      expect.objectContaining({
        directorAlternatives: ['Wednesday at 3pm', 'Thursday at 11am']
      })
    );
  });

  it('sends the first SMS via Twilio containing contact name', async () => {
    await request(app).post('/api/initiate').send(validBody);
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Bob'));
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/api/initiate').send({ contactName: 'Bob' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when proposedTimes is an empty array', async () => {
    const res = await request(app).post('/api/initiate').send({ ...validBody, proposedTimes: [] });
    expect(res.status).toBe(400);
  });
});
