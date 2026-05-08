const mockInsert = jest.fn();
const mockAuth = {};

jest.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => mockAuth)
    },
    calendar: jest.fn(() => ({
      events: { insert: mockInsert }
    }))
  }
}));

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project'
});
process.env.GOOGLE_CALENDAR_ID = 'test@group.calendar.google.com';

const { bookCalendarEvent } = require('../../lib/calendar');

describe('bookCalendarEvent', () => {
  it('creates a calendar event with correct title and description', async () => {
    mockInsert.mockResolvedValue({
      data: { id: 'event-abc', htmlLink: 'https://calendar.google.com/event?id=abc' }
    });

    const result = await bookCalendarEvent(
      '2026-05-12T14:00:00',
      'Jane Doe',
      'organizer@example.com'
    );

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'test@group.calendar.google.com',
        resource: expect.objectContaining({
          summary: 'Meeting with Jane Doe',
          description: 'Scheduled via SMS automation.',
          start: expect.objectContaining({ dateTime: expect.any(String) }),
          end: expect.objectContaining({ dateTime: expect.any(String) })
        })
      })
    );
    expect(result).toEqual({ id: 'event-abc', htmlLink: 'https://calendar.google.com/event?id=abc' });
  });

  it('sets end time exactly 30 minutes after start time', async () => {
    mockInsert.mockResolvedValue({ data: { id: 'event-xyz' } });

    await bookCalendarEvent('2026-05-12T14:00:00', 'John', 'org@example.com');

    const call = mockInsert.mock.calls[0][0];
    const start = new Date(call.resource.start.dateTime);
    const end = new Date(call.resource.end.dateTime);
    expect(end - start).toBe(30 * 60 * 1000);
  });
});
