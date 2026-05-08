jest.mock('@vercel/kv', () => ({
  kv: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn()
  }
}));

const { kv } = require('@vercel/kv');
const { getThread, saveThread, deleteThread } = require('../../lib/kv');

describe('KV helpers', () => {
  it('getThread calls kv.get with phone number', async () => {
    kv.get.mockResolvedValue({ threadId: 'abc-123' });
    const result = await getThread('+15551234567');
    expect(kv.get).toHaveBeenCalledWith('+15551234567');
    expect(result).toEqual({ threadId: 'abc-123' });
  });

  it('getThread returns null when no thread exists', async () => {
    kv.get.mockResolvedValue(null);
    const result = await getThread('+15550000000');
    expect(result).toBeNull();
  });

  it('saveThread calls kv.set with phone, thread data, and 7-day TTL', async () => {
    kv.set.mockResolvedValue('OK');
    const thread = { threadId: 'abc-123', status: 'pending' };
    await saveThread('+15551234567', thread);
    expect(kv.set).toHaveBeenCalledWith('+15551234567', thread, { ex: 60 * 60 * 24 * 7 });
  });

  it('deleteThread calls kv.del with phone number', async () => {
    kv.del.mockResolvedValue(1);
    await deleteThread('+15551234567');
    expect(kv.del).toHaveBeenCalledWith('+15551234567');
  });
});
