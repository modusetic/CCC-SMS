const { google } = require('googleapis');

async function bookCalendarEvent(datetime, contactName, organizerEmail, timezone) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  const calendar = google.calendar({ version: 'v3', auth });

  const tz = timezone || process.env.TIMEZONE || 'America/New_York';

  // Pass datetime as-is (naive local time, no Z suffix) with an explicit timeZone so
  // Google Calendar interprets it in the correct local timezone rather than UTC.
  // For the end time, temporarily append Z to do UTC-safe math, then strip it back.
  const endMs = new Date(datetime + 'Z').getTime() + 30 * 60 * 1000;
  const endDatetime = new Date(endMs).toISOString().replace(/\.\d{3}Z$/, '');

  // Note: service accounts cannot add attendees without Domain-Wide Delegation.
  // The organizer is notified separately via email; the event is created directly
  // on the shared calendar (GOOGLE_CALENDAR_ID) so it appears on their calendar.
  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: {
      summary: `Meeting with ${contactName}`,
      description: 'Scheduled via SMS automation.',
      start: { dateTime: datetime, timeZone: tz },
      end: { dateTime: endDatetime, timeZone: tz }
    }
  });

  return response.data;
}

module.exports = { bookCalendarEvent };
