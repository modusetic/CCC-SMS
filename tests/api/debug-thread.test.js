const request = require('supertest');

jest.mock('../../lib/kv', () => ({
  getPhoneIndex: jest.fn(),
  getThreadById: jest.fn()
}));
const { getPhoneIndex, getThreadById } = require('../../lib/kv');
const app = require('../../api/debug-thread');

const TOKEN = 'test-debug-token';
const get = (path) => request(app).get(path).set('x-debug-token', TOKEN);

const mockThread = {
  threadId: 'abc-123',
  createdAt: '2026-05-24T10:00:00.000Z',
  status: 'waiting_organizer_initial',
  contactName: 'Roman DAD',
  contactPhone: '+18324075300',
  organizerName: 'Alice',
  organizerEmail: 'alice@example.com',
  organizerPhone: '+18325176982',
  proposedTimes: ['Sunday May 24 at 1pm'],
  directorAlternatives: [],
  attempts: 0,
  waitingForOrganizerApproval: false,
  pendingContactSuggestion: null,
  conversationHistory: [
    { role: 'model', content: 'Roman DAD wants to schedule...' },
    { role: 'user', content: 'I can\'t at 1pm, but does 3pm work?' }
  ]
};

function setupPhoneThread(thread) {
  getPhoneIndex.mockResolvedValue([thread.threadId]);
  getThreadById.mockResolvedValue({ ...thread });
}

describe('GET /api/debug-thread', () => {
  beforeEach(() => { getPhoneIndex.mockReset(); getThreadById.mockReset(); });

  it('returns 400 when phone param is missing', async () => {
    const res = await get('/api/debug-thread');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  it('returns 404 when no thread found for phone', async () => {
    getPhoneIndex.mockResolvedValue([]);
    const res = await get('/api/debug-thread?phone=+19999999999');
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });

  it('returns thread summary when found', async () => {
    setupPhoneThread({ ...mockThread });
    const res = await get('/api/debug-thread?phone=+18325176982');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.contactName).toBe('Roman DAD');
    expect(res.body.status).toBe('waiting_organizer_initial');
  });

  it('includes conversationHistoryLength and last two messages', async () => {
    setupPhoneThread({ ...mockThread });
    const res = await get('/api/debug-thread?phone=+18325176982');
    expect(res.body.conversationHistoryLength).toBe(2);
    expect(res.body.lastTwoMessages).toHaveLength(2);
  });

  it('returns 500 on Redis error', async () => {
    getPhoneIndex.mockRejectedValue(new Error('Redis timeout'));
    const res = await get('/api/debug-thread?phone=+18325176982');
    expect(res.status).toBe(500);
    expect(res.body.detail).toBe('Redis timeout');
  });

  it('restores + sign when browser URL-encodes it as a space', async () => {
    // Browsers send ?phone=+18325176982 which Express decodes as ' 18325176982'
    setupPhoneThread({ ...mockThread });
    const res = await get('/api/debug-thread?phone=%2018325176982');
    expect(getPhoneIndex).toHaveBeenCalledWith('+18325176982');
    expect(res.status).toBe(200);
  });

  describe('authentication', () => {
    const originalToken = process.env.DEBUG_TOKEN;

    afterEach(() => {
      process.env.DEBUG_TOKEN = originalToken;
    });

    it('returns 401 when no token is provided in the request', async () => {
      setupPhoneThread({ ...mockThread });
      const res = await request(app).get('/api/debug-thread?phone=+18325176982');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/unauthorized/i);
    });

    it('returns 401 when the wrong token is provided', async () => {
      setupPhoneThread({ ...mockThread });
      const res = await request(app).get('/api/debug-thread?phone=+18325176982&token=wrong');
      expect(res.status).toBe(401);
    });

    it('returns 200 when the correct token is provided', async () => {
      setupPhoneThread({ ...mockThread });
      const res = await request(app).get(`/api/debug-thread?phone=+18325176982&token=${TOKEN}`);
      expect(res.status).toBe(200);
    });

    it('returns 401 when DEBUG_TOKEN env var is unset, even with a token provided (fail closed)', async () => {
      delete process.env.DEBUG_TOKEN;
      setupPhoneThread({ ...mockThread });
      const res = await request(app).get(`/api/debug-thread?phone=+18325176982&token=${TOKEN}`);
      expect(res.status).toBe(401);
    });
  });
});
