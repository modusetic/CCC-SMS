const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => ({
    get: mockGet,
    set: mockSet,
    del: mockDel
  }))
}));

process.env.KV_REST_API_URL = 'https://test.upstash.io';
process.env.KV_REST_API_TOKEN = 'test-token';

const { getThread, saveThread, deleteThread } = require('../../lib/kv');

describe('KV helpers', () => {
  it('getThread calls redis.get with phone number', async () => {
    mockGet.mockResolvedValue({ threadId: 'abc-123' });
    const result = await getThread('+15551234567');
    expect(mockGet).toHaveBeenCalledWith('+15551234567');
    expect(result).toEqual({ threadId: 'abc-123' });
  });

  it('getThread returns null when no thread exists', async () => {
    mockGet.mockResolvedValue(null);
    const result = await getThread('+15550000000');
    expect(result).toBeNull();
  });

  it('saveThread calls redis.set with phone, thread data, and 7-day TTL', async () => {
    mockSet.mockResolvedValue('OK');
    const thread = { threadId: 'abc-123', status: 'pending' };
    await saveThread('+15551234567', thread);
    expect(mockSet).toHaveBeenCalledWith('+15551234567', thread, { ex: 60 * 60 * 24 * 7 });
  });

  it('deleteThread calls redis.del with phone number', async () => {
    mockDel.mockResolvedValue(1);
    await deleteThread('+15551234567');
    expect(mockDel).toHaveBeenCalledWith('+15551234567');
  });
});
