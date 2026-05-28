const request = require('supertest');

jest.mock('../../lib/settings', () => ({
  getSettings: jest.fn(),
  saveSettings: jest.fn()
}));

const { getSettings, saveSettings } = require('../../lib/settings');
const app = require('../../api/settings');

beforeEach(() => {
  getSettings.mockReset();
  saveSettings.mockReset();
});

describe('GET /api/settings', () => {
  it('returns 200 with current settings', async () => {
    getSettings.mockResolvedValue({ assistantName: 'Alex', maxExchanges: 6 });
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.assistantName).toBe('Alex');
  });

  it('returns 500 on Redis error without leaking detail', async () => {
    getSettings.mockRejectedValue(new Error('Redis timeout'));
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
    expect(res.body.detail).toBeUndefined();
  });
});

describe('POST /api/settings', () => {
  it('returns 200 with saved settings', async () => {
    saveSettings.mockResolvedValue({ assistantName: 'Jordan', maxExchanges: 6 });
    const res = await request(app)
      .post('/api/settings')
      .send({ assistantName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(res.body.assistantName).toBe('Jordan');
  });

  it('returns 400 on validation error', async () => {
    const err = new Error('assistantName must be at most 40 characters');
    err.isValidation = true;
    saveSettings.mockRejectedValue(err);
    const res = await request(app)
      .post('/api/settings')
      .send({ assistantName: 'x'.repeat(50) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assistantName/);
  });

  it('returns 500 on Redis error', async () => {
    saveSettings.mockRejectedValue(new Error('Redis timeout'));
    const res = await request(app)
      .post('/api/settings')
      .send({ assistantName: 'Test' });
    expect(res.status).toBe(500);
  });
});
