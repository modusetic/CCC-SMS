const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => ({ get: mockGet, set: mockSet, del: mockDel }))
}));

process.env.KV_REST_API_URL = 'https://test.upstash.io';
process.env.KV_REST_API_TOKEN = 'test-token';

const {
  getThreadById, saveThreadById,
  getPhoneIndex, addToPhoneIndex, removeFromPhoneIndex,
  getPendingMessage, setPendingMessage, deletePendingMessage,
  getThread, saveThread, deleteThread
} = require('../../lib/kv');

const TTL = 60 * 60 * 24 * 7;

beforeEach(() => { mockGet.mockClear(); mockSet.mockClear(); mockDel.mockClear(); });

describe('getThreadById / saveThreadById', () => {
  it('getThreadById calls redis.get with thread:{id}', async () => {
    mockGet.mockResolvedValue({ threadId: 'abc-123' });
    const result = await getThreadById('abc-123');
    expect(mockGet).toHaveBeenCalledWith('thread:abc-123');
    expect(result).toEqual({ threadId: 'abc-123' });
  });

  it('getThreadById returns null when not found', async () => {
    mockGet.mockResolvedValue(null);
    expect(await getThreadById('missing')).toBeNull();
  });

  it('saveThreadById calls redis.set with thread:{id}, data, and 7-day TTL', async () => {
    mockSet.mockResolvedValue('OK');
    const thread = { threadId: 'abc-123', status: 'pending' };
    await saveThreadById('abc-123', thread);
    expect(mockSet).toHaveBeenCalledWith('thread:abc-123', thread, { ex: TTL });
  });
});

describe('phone index', () => {
  it('getPhoneIndex returns empty array when no index exists', async () => {
    mockGet.mockResolvedValue(null);
    const result = await getPhoneIndex('+15551234567');
    expect(mockGet).toHaveBeenCalledWith('phone:+15551234567');
    expect(result).toEqual([]);
  });

  it('getPhoneIndex returns stored array', async () => {
    mockGet.mockResolvedValue(['uuid-1', 'uuid-2']);
    expect(await getPhoneIndex('+15551234567')).toEqual(['uuid-1', 'uuid-2']);
  });

  it('addToPhoneIndex appends threadId to existing index', async () => {
    mockGet.mockResolvedValue(['uuid-1']);
    mockSet.mockResolvedValue('OK');
    await addToPhoneIndex('+15551234567', 'uuid-2');
    expect(mockSet).toHaveBeenCalledWith('phone:+15551234567', ['uuid-1', 'uuid-2']);
  });

  it('addToPhoneIndex creates new index when none exists', async () => {
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue('OK');
    await addToPhoneIndex('+15551234567', 'uuid-1');
    expect(mockSet).toHaveBeenCalledWith('phone:+15551234567', ['uuid-1']);
  });

  it('addToPhoneIndex does not add duplicate threadId', async () => {
    mockGet.mockResolvedValue(['uuid-1']);
    await addToPhoneIndex('+15551234567', 'uuid-1');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('removeFromPhoneIndex removes the threadId', async () => {
    mockGet.mockResolvedValue(['uuid-1', 'uuid-2', 'uuid-3']);
    mockSet.mockResolvedValue('OK');
    await removeFromPhoneIndex('+15551234567', 'uuid-2');
    expect(mockSet).toHaveBeenCalledWith('phone:+15551234567', ['uuid-1', 'uuid-3']);
  });

  it('removeFromPhoneIndex deletes key when index becomes empty', async () => {
    mockGet.mockResolvedValue(['uuid-1']);
    mockDel.mockResolvedValue(1);
    await removeFromPhoneIndex('+15551234567', 'uuid-1');
    expect(mockDel).toHaveBeenCalledWith('phone:+15551234567');
  });
});

describe('pending message', () => {
  it('getPendingMessage returns stored message', async () => {
    mockGet.mockResolvedValue('Yes, Friday works');
    expect(await getPendingMessage('+15550009999')).toBe('Yes, Friday works');
    expect(mockGet).toHaveBeenCalledWith('pending:+15550009999');
  });

  it('getPendingMessage returns null when none stored', async () => {
    mockGet.mockResolvedValue(null);
    expect(await getPendingMessage('+15550009999')).toBeNull();
  });

  it('setPendingMessage stores message without TTL', async () => {
    mockSet.mockResolvedValue('OK');
    await setPendingMessage('+15550009999', 'Yes, Friday works');
    expect(mockSet).toHaveBeenCalledWith('pending:+15550009999', 'Yes, Friday works');
  });

  it('deletePendingMessage removes the key', async () => {
    mockDel.mockResolvedValue(1);
    await deletePendingMessage('+15550009999');
    expect(mockDel).toHaveBeenCalledWith('pending:+15550009999');
  });
});

describe('legacy helpers', () => {
  it('getThread calls redis.get with phone number directly', async () => {
    mockGet.mockResolvedValue({ threadId: 'abc' });
    await getThread('+15551234567');
    expect(mockGet).toHaveBeenCalledWith('+15551234567');
  });

  it('saveThread calls redis.set with phone, data, and 7-day TTL', async () => {
    mockSet.mockResolvedValue('OK');
    await saveThread('+15551234567', { threadId: 'abc' });
    expect(mockSet).toHaveBeenCalledWith('+15551234567', { threadId: 'abc' }, { ex: TTL });
  });

  it('deleteThread calls redis.del with phone number', async () => {
    mockDel.mockResolvedValue(1);
    await deleteThread('+15551234567');
    expect(mockDel).toHaveBeenCalledWith('+15551234567');
  });
});
