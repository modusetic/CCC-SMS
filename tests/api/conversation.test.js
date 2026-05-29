const request = require('supertest');

jest.mock('../../lib/kv', () => ({
  getThreadById: jest.fn(),
  getPhoneIndex: jest.fn()
}));
const { getThreadById, getPhoneIndex } = require('../../lib/kv');
const app = require('../../api/conversation');

const mockThread = {
  threadId: 'abc-123',
  status: 'pending',
  contactName: 'Bob',
  contactPhone: '+15551234567',
  organizerName: 'Alice',
  organizerEmail: 'alice@example.com',
  organizerPhone: '+15550009999',
  waitingForOrganizerApproval: false,
  conversationHistory: [
    { role: 'model', content: 'Hi Bob! Which time works?' },
    { role: 'user',  content: 'Monday works!' }
  ],
  organizerConversationHistory: [
    { role: 'model', content: 'Bob wants to schedule. Reply APPROVE.' }
  ],
  attempts: 1,
  pendingContactSuggestion: null,
  directorAlternatives: []
};

describe('GET /api/conversation', () => {
  beforeEach(() => { getPhoneIndex.mockReset(); getThreadById.mockReset(); });

  it('returns 400 when phone param is missing', async () => {
    const res = await request(app).get('/api/conversation');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/i);
  });

  it('returns 404 with found:false when no thread exists', async () => {
    getPhoneIndex.mockResolvedValue([]);
    const res = await request(app).get('/api/conversation?phone=+19999999999');
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
    expect(res.body.phone).toBe('+19999999999');
  });

  it('returns 200 with both conversation histories when thread found', async () => {
    getPhoneIndex.mockResolvedValue(['abc-123']);
    getThreadById.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.conversationHistory).toHaveLength(2);
    expect(res.body.organizerConversationHistory).toHaveLength(1);
  });

  it('includes status, waitingForOrganizerApproval, contactName, organizerName, contactPhone, organizerPhone', async () => {
    getPhoneIndex.mockResolvedValue(['abc-123']);
    getThreadById.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.body.status).toBe('pending');
    expect(res.body.waitingForOrganizerApproval).toBe(false);
    expect(res.body.contactName).toBe('Bob');
    expect(res.body.organizerName).toBe('Alice');
    expect(res.body.contactPhone).toBe('+15551234567');
    expect(res.body.organizerPhone).toBe('+15550009999');
  });

  it('excludes sensitive fields', async () => {
    getPhoneIndex.mockResolvedValue(['abc-123']);
    getThreadById.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.body.organizerEmail).toBeUndefined();
    expect(res.body.threadId).toBeUndefined();
    expect(res.body.attempts).toBeUndefined();
    expect(res.body.directorAlternatives).toBeUndefined();
    expect(res.body.pendingContactSuggestion).toBeUndefined();
  });

  it('returns empty arrays when histories are missing (old threads)', async () => {
    getPhoneIndex.mockResolvedValue(['abc-123']);
    getThreadById.mockResolvedValue({ ...mockThread, conversationHistory: undefined, organizerConversationHistory: undefined });
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.body.conversationHistory).toEqual([]);
    expect(res.body.organizerConversationHistory).toEqual([]);
  });

  it('returns 500 on Redis error without leaking error detail', async () => {
    getPhoneIndex.mockRejectedValue(new Error('Redis timeout'));
    const res = await request(app).get('/api/conversation?phone=+15551234567');
    expect(res.status).toBe(500);
    expect(res.body.detail).toBeUndefined();
    expect(res.body.error).toBeDefined();
  });

  it('restores + sign when browser URL-encodes it as a space', async () => {
    getPhoneIndex.mockResolvedValue(['abc-123']);
    getThreadById.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?phone=%2015551234567');
    expect(getPhoneIndex).toHaveBeenCalledWith('+15551234567');
    expect(res.status).toBe(200);
  });

  it('returns 400 when neither threadId nor phone is provided', async () => {
    const res = await request(app).get('/api/conversation');
    expect(res.status).toBe(400);
  });

  it('looks up thread by threadId when ?threadId= is provided', async () => {
    getThreadById.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?threadId=abc-123');
    expect(getThreadById).toHaveBeenCalledWith('abc-123');
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
  });

  it('returns 404 when threadId not found', async () => {
    getThreadById.mockResolvedValue(null);
    const res = await request(app).get('/api/conversation?threadId=unknown');
    expect(res.status).toBe(404);
    expect(res.body.found).toBe(false);
  });

  it('threadId lookup takes priority over phone when both are provided', async () => {
    getThreadById.mockResolvedValue({ ...mockThread });
    const res = await request(app).get('/api/conversation?threadId=abc-123&phone=+15551234567');
    expect(getThreadById).toHaveBeenCalledWith('abc-123');
    expect(getPhoneIndex).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
