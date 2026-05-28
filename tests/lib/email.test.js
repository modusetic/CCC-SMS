const mockSendMail = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail }))
}));

process.env.GMAIL_USER = 'sender@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'testpassword';

// Require AFTER mocking so the module-level transporter uses the mock
const { sendOrganizerEmail } = require('../../lib/email');
const nodemailer = require('nodemailer');

// Capture createTransport args before clearMocks resets call history
let capturedCreateTransportArgs;
beforeAll(() => {
  capturedCreateTransportArgs = nodemailer.createTransport.mock.calls[0]?.[0];
});

describe('sendOrganizerEmail', () => {
  it('creates Gmail transporter with correct credentials', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'msg-123' });
    await sendOrganizerEmail('org@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00', 'America/Chicago');
    expect(capturedCreateTransportArgs).toEqual({
      service: 'gmail',
      auth: { user: 'sender@gmail.com', pass: 'testpassword' }
    });
  });

  it('sends email to organizer mentioning contact name and SMS automation', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'msg-456' });
    await sendOrganizerEmail('org@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00', 'America/Chicago');

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.to).toBe('org@example.com');
    expect(mailOptions.subject).toContain('Bob');
    expect(mailOptions.text).toContain('Alice');
    expect(mailOptions.text).toContain('Bob');
    expect(mailOptions.text).toContain('SMS automation');
  });

  it('formats datetime in the provided timezone, not UTC', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'msg-789' });
    await sendOrganizerEmail('org@example.com', 'Alice', 'Bob', '2026-06-05T18:00:00', 'America/Chicago');

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.text).toContain('June');
    expect(mailOptions.text).toContain('2026');
    expect(mailOptions.text).not.toContain('UTC');
  });
});
