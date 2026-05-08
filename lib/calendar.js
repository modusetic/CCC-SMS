const { google } = require('googleapis');

async function bookCalendarEvent(datetime, contactName, organizerEmail) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  const calendar = google.calendar({ version: 'v3', auth });

  const start = new Date(datetime);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const response = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: {
      summary: `Meeting with ${contactName}`,
      description: 'Scheduled via SMS automation.',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: [{ email: organizerEmail }]
    }
  });

  return response.data;
}

module.exports = { bookCalendarEvent };
