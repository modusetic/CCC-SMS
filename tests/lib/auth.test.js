const { checkAdminToken, requireAdminToken } = require('../../lib/auth');

function makeReq({ header = null, query = {} } = {}) {
  return { header: jest.fn().mockReturnValue(header), query };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('checkAdminToken', () => {
  const originalToken = process.env.DEBUG_TOKEN;
  afterEach(() => { process.env.DEBUG_TOKEN = originalToken; });

  it('returns true when the header token matches DEBUG_TOKEN', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    expect(checkAdminToken(makeReq({ header: 'secret123' }))).toBe(true);
  });

  it('returns true when the query token matches DEBUG_TOKEN', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    expect(checkAdminToken(makeReq({ query: { token: 'secret123' } }))).toBe(true);
  });

  it('returns false when the token is wrong', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    expect(checkAdminToken(makeReq({ header: 'nope' }))).toBe(false);
  });

  it('returns false when no token is provided', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    expect(checkAdminToken(makeReq())).toBe(false);
  });

  it('returns false (fail closed) when DEBUG_TOKEN is unset, even if a token is provided', () => {
    delete process.env.DEBUG_TOKEN;
    expect(checkAdminToken(makeReq({ header: 'anything' }))).toBe(false);
  });

  it('returns false when the provided token has a different length than expected', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    expect(checkAdminToken(makeReq({ header: 'short' }))).toBe(false);
  });

  it('ignores the query token when allowQuery is false', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    expect(checkAdminToken(makeReq({ query: { token: 'secret123' } }), { allowQuery: false })).toBe(false);
  });

  it('still accepts the header token when allowQuery is false', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    expect(checkAdminToken(makeReq({ header: 'secret123' }), { allowQuery: false })).toBe(true);
  });
});

describe('requireAdminToken', () => {
  const originalToken = process.env.DEBUG_TOKEN;
  afterEach(() => { process.env.DEBUG_TOKEN = originalToken; });

  it('returns true and does not touch res when the token is valid', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    const res = makeRes();
    expect(requireAdminToken(makeReq({ header: 'secret123' }), res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sends 401 and returns false when the token is invalid', () => {
    process.env.DEBUG_TOKEN = 'secret123';
    const res = makeRes();
    expect(requireAdminToken(makeReq({ header: 'wrong' }), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });
});
