const request = require('supertest');

jest.mock('../../lib/kv', () => ({
  saveThreadById: jest.fn().mockResolvedValue(undefined),
  addToPhoneIndex: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../lib/twilio', () => ({
  sendSms: jest.fn().mockResolvedValue('SM123')
}));

jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));

jest.mock('../../lib/settings', () => ({
  getSettings: jest.fn().mockResolvedValue({
    assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
    holdingMessage: "We'll be in touch.", confirmationMessage: 'Confirmed!', demoMode: false
  }),
  DEFAULTS: {
    assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
    holdingMessage: "We'll be in touch.", confirmationMessage: 'Confirmed!', demoMode: false
  }
}));

const { saveThreadById, addToPhoneIndex } = require('../../lib/kv');
const { sendSms } = require('../../lib/twilio');
const { getSettings } = require('../../lib/settings');
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
    expect(saveThreadById).toHaveBeenCalledWith('test-uuid-1234', expect.objectContaining({ status: 'pending' }));
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid-1234');
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
    expect(saveThreadById).toHaveBeenCalledWith(
      'test-uuid-1234',
      expect.objectContaining({ status: 'waiting_organizer_initial' })
    );
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid-1234');
  });

  it('adds organizer phone to phone index', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15550009999', 'test-uuid-1234');
  });

  it('organizer initial review SMS does not include prelude', async () => {
    const body = { ...base, organizerPhone: '+15550009999' };
    await request(app).post('/api/initiate').send(body);
    const orgCall = sendSms.mock.calls.find(([to]) => to === '+15550009999');
    expect(orgCall[1]).toContain('Bob');
    expect(orgCall[1]).not.toMatch(/^\[/);
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

  it('organizer FYI SMS does not include prelude', async () => {
    const body = { ...base, organizerPhone: '+15550009999', directorAlternatives: ['Wed at 3pm'] };
    await request(app).post('/api/initiate').send(body);
    const orgCall = sendSms.mock.calls.find(([to]) => to === '+15550009999');
    expect(orgCall[1]).toContain('Bob');
    expect(orgCall[1]).not.toMatch(/^\[/);
  });

  it('saves thread with status pending', async () => {
    await request(app).post('/api/initiate').send(body);
    expect(saveThreadById).toHaveBeenCalledWith('test-uuid-1234', expect.objectContaining({ status: 'pending' }));
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid-1234');
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
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid-1234');
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.any(String));
  });

  it('normalizes formatted contact phone to E.164', async () => {
    // Input includes country code 1; normalizer strips parens/spaces/dashes and prepends +
    await request(app).post('/api/initiate').send({ ...base, contactPhone: '1 (555) 123-4567' });
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15551234567', 'test-uuid-1234');
  });

  it('normalizes organizer phone without + to E.164', async () => {
    await request(app).post('/api/initiate').send({ ...base, organizerPhone: '15550009999' });
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15550009999', 'test-uuid-1234');
    expect(sendSms).toHaveBeenCalledWith('+15550009999', expect.any(String));
  });

  it('leaves already-correct E.164 phones unchanged', async () => {
    await request(app).post('/api/initiate').send({ ...base, organizerPhone: '+15550009999' });
    expect(addToPhoneIndex).toHaveBeenCalledWith('+15550009999', 'test-uuid-1234');
  });

  it('treats garbage-only organizer phone as absent and routes to no-organizer branch', async () => {
    sendSms.mockClear();
    saveThreadById.mockClear();
    addToPhoneIndex.mockClear();
    const res = await request(app).post('/api/initiate').send({ ...base, organizerPhone: '---' });
    expect(res.status).toBe(200);
    // Should NOT try to send to "+" (garbage normalised result)
    expect(sendSms).not.toHaveBeenCalledWith('+', expect.anything());
    // Should behave as no-organizer branch: SMS the contact directly
    expect(sendSms).toHaveBeenCalledWith('+15551234567', expect.any(String));
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('treats purely punctuation contact phone as invalid', async () => {
    const res = await request(app).post('/api/initiate').send({ ...base, contactPhone: '()--' });
    // Garbage contact phone should not result in a sendSms call to "+"
    expect(sendSms).not.toHaveBeenCalledWith('+', expect.anything());
  });
});

describe('POST /api/initiate — organizerConversationHistory', () => {
  beforeEach(() => {
    saveThreadById.mockClear();
    addToPhoneIndex.mockClear();
    sendSms.mockClear();
  });

  it('initializes every thread with empty organizerConversationHistory', async () => {
    await request(app).post('/api/initiate').send(base);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.organizerConversationHistory).toEqual([]);
  });

  it('pushes organizer review SMS to organizerConversationHistory in branch 1', async () => {
    const body = { ...base, organizerPhone: '+15550009999' };
    await request(app).post('/api/initiate').send(body);
    // only one saveThreadById call; organizer data is in the thread
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.organizerConversationHistory).toHaveLength(1);
    expect(saved.organizerConversationHistory[0].role).toBe('model');
    expect(saved.organizerConversationHistory[0].content).toMatch(/Reply to confirm/i);
  });

  it('puts orgFyi in organizerConversationHistory (not conversationHistory) in branch 2', async () => {
    const body = {
      ...base,
      organizerPhone: '+15550009999',
      directorAlternatives: ['Wednesday at 3pm']
    };
    await request(app).post('/api/initiate').send(body);
    // only one saveThreadById call
    const saved = saveThreadById.mock.calls[0][1];
    // conversationHistory must have exactly 1 entry (contactMsg only — no orgFyi)
    expect(saved.conversationHistory).toHaveLength(1);
    expect(saved.conversationHistory[0].role).toBe('model');
    // organizerConversationHistory must have exactly 1 entry (orgFyi)
    expect(saved.organizerConversationHistory).toHaveLength(1);
    expect(saved.organizerConversationHistory[0].role).toBe('model');
    expect(saved.organizerConversationHistory[0].content).toContain('Bob');
  });
});

describe('POST /api/initiate — new schema fields', () => {
  beforeEach(() => {
    saveThreadById.mockClear();
    addToPhoneIndex.mockClear();
    sendSms.mockClear();
  });

  it('initializes directorMessages, rejectedTimes as empty arrays', async () => {
    await request(app).post('/api/initiate').send(base);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.directorMessages).toEqual([]);
    expect(saved.rejectedTimes).toEqual([]);
  });

  it('initializes confirmedDatetime as null', async () => {
    await request(app).post('/api/initiate').send(base);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.confirmedDatetime).toBeNull();
  });

  it('sets lastActivityAt on thread creation', async () => {
    await request(app).post('/api/initiate').send(base);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.lastActivityAt).toBeDefined();
    expect(typeof saved.lastActivityAt).toBe('string');
  });

  it('sets offeredTimes to proposedTimes in no-organizer branch', async () => {
    await request(app).post('/api/initiate').send(base);
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.offeredTimes).toEqual(base.proposedTimes);
  });

  it('sets offeredTimes to backupTimes in organizer+backup branch', async () => {
    const body = { ...base, organizerPhone: '+15550009999', directorAlternatives: ['Wednesday at 3pm'] };
    await request(app).post('/api/initiate').send(body);
    // only one saveThreadById call
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.offeredTimes).toEqual(['Wednesday at 3pm']);
  });

  it('offeredTimes is empty in waiting_organizer_initial branch', async () => {
    const body = { ...base, organizerPhone: '+15550009999' };
    await request(app).post('/api/initiate').send(body);
    // only one saveThreadById call
    const saved = saveThreadById.mock.calls[0][1];
    expect(saved.offeredTimes).toEqual([]);
  });
});

describe('Demo Mode — SMS suppression', () => {
  beforeEach(() => {
    getSettings.mockResolvedValue({
      assistantName: 'Alex', tone: 'Be polite.', maxMessageLength: 160, maxExchanges: 6,
      holdingMessage: "We'll be in touch.", confirmationMessage: 'Confirmed!', demoMode: true
    });
  });

  it('does not SMS organizer when demoMode is true (branch 1)', async () => {
    const body = { ...base, organizerPhone: '+15550009999' };
    await request(app).post('/api/initiate').send(body);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('does not SMS contact or organizer when demoMode is true (branch 2)', async () => {
    const body = { ...base, organizerPhone: '+15550009999', directorAlternatives: ['Wednesday at 3pm'] };
    await request(app).post('/api/initiate').send(body);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('does not SMS contact when demoMode is true (branch 3 — no organizer phone)', async () => {
    await request(app).post('/api/initiate').send(base);
    expect(sendSms).not.toHaveBeenCalled();
  });
});
