jest.mock('@upstash/redis', () => {
  const mockGet = jest.fn();
  const mockSet = jest.fn();
  return {
    Redis: jest.fn(() => ({ get: mockGet, set: mockSet })),
    _mockGet: mockGet,
    _mockSet: mockSet
  };
});

process.env.KV_REST_API_URL = 'https://test.upstash.io';
process.env.KV_REST_API_TOKEN = 'test-token';

const { getSettings, saveSettings, DEFAULTS } = require('../../lib/settings');
const redis = require('@upstash/redis');

beforeEach(() => {
  redis._mockGet.mockReset();
  redis._mockSet.mockReset();
});

describe('getSettings', () => {
  it('returns DEFAULTS when Redis key is absent', async () => {
    redis._mockGet.mockResolvedValue(null);
    const result = await getSettings();
    expect(result).toEqual(DEFAULTS);
  });

  it('merges stored partial values over defaults', async () => {
    redis._mockGet.mockResolvedValue({ assistantName: 'Jordan' });
    const result = await getSettings();
    expect(result.assistantName).toBe('Jordan');
    expect(result.maxMessageLength).toBe(160);
    expect(result.maxExchanges).toBe(6);
  });
});

describe('saveSettings', () => {
  it('saves merged object to Redis and returns it', async () => {
    redis._mockGet.mockResolvedValue(null);
    redis._mockSet.mockResolvedValue('OK');
    const result = await saveSettings({ assistantName: 'Jordan' });
    expect(result.assistantName).toBe('Jordan');
    expect(result.maxMessageLength).toBe(160);
    expect(redis._mockSet).toHaveBeenCalledWith(
      'global:settings',
      expect.objectContaining({ assistantName: 'Jordan' })
    );
  });

  it('strips unknown keys', async () => {
    redis._mockGet.mockResolvedValue(null);
    redis._mockSet.mockResolvedValue('OK');
    const result = await saveSettings({ assistantName: 'Jordan', hackerField: 'evil' });
    expect(result).not.toHaveProperty('hackerField');
  });

  it('throws validation error when assistantName is too long', async () => {
    await expect(saveSettings({ assistantName: 'x'.repeat(41) }))
      .rejects.toThrow(/assistantName/);
  });

  it('throws validation error when maxExchanges is out of range', async () => {
    await expect(saveSettings({ maxExchanges: 100 }))
      .rejects.toThrow(/maxExchanges/);
  });

  it('throws validation error when maxMessageLength is wrong type', async () => {
    await expect(saveSettings({ maxMessageLength: 'lots' }))
      .rejects.toThrow(/maxMessageLength/);
  });

  it('validation error has isValidation flag set', async () => {
    const err = await saveSettings({ maxExchanges: 99 }).catch(e => e);
    expect(err.isValidation).toBe(true);
  });

  it('saves demoMode boolean and returns it', async () => {
    redis._mockGet.mockResolvedValue(null);
    redis._mockSet.mockResolvedValue('OK');
    const result = await saveSettings({ demoMode: true });
    expect(result.demoMode).toBe(true);
  });

  it('throws validation error when demoMode is not a boolean', async () => {
    await expect(saveSettings({ demoMode: 'yes' }))
      .rejects.toThrow(/demoMode/);
  });

  it('saves autoConfirmPreApprovedTimes boolean and returns it', async () => {
    redis._mockGet.mockResolvedValue(null);
    redis._mockSet.mockResolvedValue('OK');
    const result = await saveSettings({ autoConfirmPreApprovedTimes: false });
    expect(result.autoConfirmPreApprovedTimes).toBe(false);
  });

  it('throws validation error when autoConfirmPreApprovedTimes is not a boolean', async () => {
    await expect(saveSettings({ autoConfirmPreApprovedTimes: 'yes' }))
      .rejects.toThrow(/autoConfirmPreApprovedTimes/);
  });
});

describe('DEFAULTS', () => {
  it('demoMode defaults to false', () => {
    expect(DEFAULTS.demoMode).toBe(false);
  });

  it('autoConfirmPreApprovedTimes defaults to true', () => {
    expect(DEFAULTS.autoConfirmPreApprovedTimes).toBe(true);
  });
});
