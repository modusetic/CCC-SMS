const mockCreate = jest.fn();

jest.mock('twilio', () => {
  return jest.fn(() => ({
    messages: { create: mockCreate }
  }));
});

process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.TWILIO_PHONE_NUMBER = '+15550000000';

const { sendSms } = require('../../lib/twilio');

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
