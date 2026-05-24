const request = require('supertest');

jest.mock('../../lib/kv', () => ({ getThread: jest.fn() }));
const { getThread } = require('../../lib/kv');
const app = require('../../api/debug-thread');

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

describe('GET /api/debug-thread', () => {
  it('returns 400 when phone param is missing', async () => {
    const res = await request(app).get('/api/debug-thread');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  it('returns 404 when no thread found for phone', async () => {
    getThread.mockResolvedValue(null);
    const res = await request(app).get('/api/debug-thread?phone=+19999999999');
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });

  it('returns thread summary when found', async () => {
    getThread.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/debug-thread?phone=+18325176982');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.contactName).toBe('Roman DAD');
    expect(res.body.status).toBe('waiting_organizer_initial');
  });

  it('includes conversationHistoryLength and last two messages', async () => {
    getThread.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/debug-thread?phone=+18325176982');
    expect(res.body.conversationHistoryLength).toBe(2);
    expect(res.body.lastTwoMessages).toHaveLength(2);
  });

  it('returns 500 on Redis error', async () => {
    getThread.mockRejectedValue(new Error('Redis timeout'));
    const res = await request(app).get('/api/debug-thread?phone=+18325176982');
    expect(res.status).toBe(500);
    expect(res.body.detail).toBe('Redis timeout');
  });

  it('restores + sign when browser URL-encodes it as a space', async () => {
    // Browsers send ?phone=+18325176982 which Express decodes as ' 18325176982'
    getThread.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/debug-thread?phone=%2018325176982');
    expect(getThread).toHaveBeenCalledWith('+18325176982');
    expect(res.status).toBe(200);
  });
});
