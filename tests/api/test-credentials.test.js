const request = require('supertest');

// Mock heavy external dependencies so the test doesn't need real credentials
jest.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: jest.fn() },
    calendar: jest.fn()
  }
}));

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ verify: jest.fn().mockResolvedValue(true) }))
}));

const app = require('../../api/test-credentials');

describe('GET /api/test-credentials', () => {
  const originalToken = process.env.DEBUG_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.DEBUG_TOKEN;
    } else {
      process.env.DEBUG_TOKEN = originalToken;
    }
  });

  it('returns 401 when DEBUG_TOKEN is set and no token is provided', async () => {
    process.env.DEBUG_TOKEN = 'secret123';
    const res = await request(app).get('/api/test-credentials');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it('returns 401 when DEBUG_TOKEN is set and wrong token is provided', async () => {
    process.env.DEBUG_TOKEN = 'secret123';
    const res = await request(app).get('/api/test-credentials?token=wrong');
    expect(res.status).toBe(401);
  });

  it('proceeds past auth when correct DEBUG_TOKEN is provided', async () => {
    process.env.DEBUG_TOKEN = 'secret123';
    // With correct token it should not return 401 (may return 500 due to missing env vars — that's fine)
    const res = await request(app).get('/api/test-credentials?token=secret123');
    expect(res.status).not.toBe(401);
  });

  it('allows unauthenticated access when DEBUG_TOKEN is not set', async () => {
    delete process.env.DEBUG_TOKEN;
    const res = await request(app).get('/api/test-credentials');
    expect(res.status).not.toBe(401);
  });
});
