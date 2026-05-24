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

const base = {
  contactName: 'Bob',
  contactPhone: '+15551234567',
  organizerName: 'Alice',
  organizerEmail: 'alice@example.com',
  proposedTimes: ['Monday May 12 at 2pm', 'Tuesday May 13 at 10am']
};

describe('POST /api/initiate — no organizer phone', () => {
  it('returns 200 with threadId', async () => {
    const res = await request(app).post('/api/initiate').send(base);
    expect(res.status).toBe(200);
    expect(res.body.threadId).toBe('test-uuid-1234');
  });

  it('SMSes contact with proposed times', async () => {
    await request(app).post('/api/initiate').send(base);
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Bob'));
    expect(sendSms).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('proposed times'));
  });

  it('saves thread with status pending', async () => {
    await request(app).post('/api/initiate').send(base);
    expect(saveThread).toHaveBeenCalledWith('+15551234567', expect.objectContaining({ status: 'pending' }));
  });
});

describe('POST /api/initiate — organizer phone, no backup times', () => {
  const body = { ...base, organizerPhone: '+15550009999' };

  it('SMSes organizer with proposed times for review', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(sendSms).toHaveBeenCalledWith('+15550009999', expect.stringContaining('Monday May 12 at 2pm'));
  });

  it('does not SMS the contact', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(sendSms).not.toHaveBeenCalledWith('+15551234567', expect.anything());
  });

  it('saves thread with status waiting_organizer_initial', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(saveThread).toHaveBeenCalledWith(
      '+15551234567',
      expect.objectContaining({ status: 'waiting_organizer_initial' })
    );
  });

  it('saves thread under organizer phone too', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(saveThread).toHaveBeenCalledWith('+15550009999', expect.any(Object));
  });
});

describe('POST /api/initiate — organizer phone + backup times', () => {
  const body = {
    ...base,
    organizerPhone: '+15550009999',
    directorAlternatives: ['Wednesday at 3pm', 'Thursday at 11am']
  };

  it('SMSes contact with backup times immediately', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.stringContaining('Wednesday at 3pm'));
  });

  it('sends FYI to organizer', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(sendSms).toHaveBeenCalledWith('+15550009999', expect.stringContaining('Bob'));
  });

  it('saves thread with status pending', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(saveThread).toHaveBeenCalledWith('+15551234567', expect.objectContaining({ status: 'pending' }));
  });
});

describe('POST /api/initiate — validation', () => {
  it('returns 400 when required fields are missing', async () => {
    const res = await request(app).post('/api/initiate').send({ contactName: 'Bob' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when proposedTimes is empty', async () => {
    const res = await request(app).post('/api/initiate').send({ ...base, proposedTimes: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/initiate — phone normalization', () => {
  it('normalizes contact phone without + to E.164', async () => {
    await request(app).post('/api/initiate').send({ ...base, contactPhone: '15551234567' });
    expect(saveThread).toHaveBeenCalledWith('+15551234567', expect.any(Object));
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.any(String));
  });

  it('normalizes formatted contact phone to E.164', async () => {
    // Input includes country code 1; normalizer strips parens/spaces/dashes and prepends +
    await request(app).post('/api/initiate').send({ ...base, contactPhone: '1 (555) 123-4567' });
    expect(saveThread).toHaveBeenCalledWith('+15551234567', expect.any(Object));
  });

  it('normalizes organizer phone without + to E.164', async () => {
    await request(app).post('/api/initiate').send({ ...base, organizerPhone: '15550009999' });
    expect(saveThread).toHaveBeenCalledWith('+15550009999', expect.any(Object));
    expect(sendSms).toHaveBeenCalledWith('+15550009999', expect.any(String));
  });

  it('leaves already-correct E.164 phones unchanged', async () => {
    await request(app).post('/api/initiate').send({ ...base, organizerPhone: '+15550009999' });
    expect(saveThread).toHaveBeenCalledWith('+15550009999', expect.any(Object));
  });
});
