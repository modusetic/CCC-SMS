const mockCreate = jest.fn();
const mockValidateRequest = jest.fn();

jest.mock('twilio', () => {
  const fn = jest.fn(() => ({
    messages: { create: mockCreate }
  }));
  fn.validateRequest = mockValidateRequest;
  return fn;
});

process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.TWILIO_PHONE_NUMBER = '+15550000000';

const { sendSms, isValidTwilioRequest } = require('../../lib/twilio');

describe('sendSms', () => {
  it('creates a Twilio message with correct params', async () => {
    mockCreate.mockResolvedValue({ sid: 'SM123' });
    const sid = await sendSms('+15551234567', 'Hello, test message!');
    expect(mockCreate).toHaveBeenCalledWith({
      body: 'Hello, test message!',
      from: '+15550000000',
      to: '+15551234567'
    });
    expect(sid).toBe('SM123');
  });

  it('throws when Twilio create fails', async () => {
    mockCreate.mockRejectedValue(new Error('Twilio error'));
    await expect(sendSms('+15551234567', 'Hi')).rejects.toThrow('Twilio error');
  });
});

describe('isValidTwilioRequest', () => {
  function makeReq({ signature = 'sig123', host = 'example.com', originalUrl = '/api/sms-reply', body = { From: '+15551234567', Body: 'hi' } } = {}) {
    return {
      header: jest.fn().mockReturnValue(signature),
      headers: { host },
      originalUrl,
      body
    };
  }

  it('returns false when the X-Twilio-Signature header is missing', () => {
    const req = makeReq();
    req.header = jest.fn().mockReturnValue(undefined);
    expect(isValidTwilioRequest(req)).toBe(false);
    expect(mockValidateRequest).not.toHaveBeenCalled();
  });

  it('returns false when TWILIO_AUTH_TOKEN is not set', () => {
    const original = process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_AUTH_TOKEN;
    expect(isValidTwilioRequest(makeReq())).toBe(false);
    process.env.TWILIO_AUTH_TOKEN = original;
  });

  it('validates against the reconstructed HTTPS URL and forwards the result', () => {
    mockValidateRequest.mockReturnValue(true);
    const req = makeReq();
    expect(isValidTwilioRequest(req)).toBe(true);
    expect(mockValidateRequest).toHaveBeenCalledWith(
      'testtoken', 'sig123', 'https://example.com/api/sms-reply', req.body
    );
  });

  it('returns false when the signature does not match', () => {
    mockValidateRequest.mockReturnValue(false);
    expect(isValidTwilioRequest(makeReq())).toBe(false);
  });
});
