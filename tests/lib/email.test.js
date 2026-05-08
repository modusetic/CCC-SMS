const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({
  createTransport: mockCreateTransport
}));

process.env.GMAIL_USER = 'sender@gmail.com';
process.env.GMAIL_APP_PASSWORD = 'testpassword';

const { sendOrganizerEmail } = require('../../lib/email');

describe('sendOrganizerEmail', () => {
  it('creates Gmail transporter with correct credentials', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'msg-123' });
    await sendOrganizerEmail('org@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00');
    expect(mockCreateTransport).toHaveBeenCalledWith({
      service: 'gmail',
      auth: { user: 'sender@gmail.com', pass: 'testpassword' }
    });
  });

  it('sends email to organizer mentioning contact name and SMS automation', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'msg-456' });
    await sendOrganizerEmail('org@example.com', 'Alice', 'Bob', '2026-05-12T14:00:00');

    const mailOptions = mockSendMail.mock.calls[0][0];
    expect(mailOptions.to).toBe('org@example.com');
    expect(mailOptions.subject).toContain('Bob');
    expect(mailOptions.text).toContain('Alice');
    expect(mailOptions.text).toContain('Bob');
    expect(mailOptions.text).toContain('SMS automation');
  });
});
