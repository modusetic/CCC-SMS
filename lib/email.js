const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Naive datetime strings (no Z / offset) from Gemini represent local time in the thread's
// timezone. new Date() on a UTC server would misinterpret them as UTC. This converts them
// to the correct UTC instant using the Intl offset trick.
function parseLocalDatetime(datetimeStr, timezone) {
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(datetimeStr)) return new Date(datetimeStr);
  const utcGuess = new Date(datetimeStr + 'Z');
  if (isNaN(utcGuess.getTime())) return new Date(datetimeStr);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(utcGuess);
  const get = t => parseInt(parts.find(p => p.type === t).value);
  const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return new Date(utcGuess.getTime() - (localMs - utcGuess.getTime()));
}

async function sendOrganizerEmail(organizerEmail, organizerName, contactName, confirmedDatetime, timezone) {
  const tz = timezone || process.env.TIMEZONE || 'America/New_York';
  const parsed = parseLocalDatetime(confirmedDatetime, tz);
  const dateDisplay = isNaN(parsed.getTime())
    ? confirmedDatetime
    : parsed.toLocaleString('en-US', {
        timeZone: tz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: organizerEmail,
    subject: `Meeting Confirmed: ${contactName}`,
    text: `Hi ${organizerName},\n\n${contactName} has confirmed a meeting with you.\n\nDate & Time: ${dateDisplay}\n\nThis meeting was scheduled via SMS automation.\n\nBest,\nAlex (SMS Scheduling Assistant)`
  });
}

module.exports = { sendOrganizerEmail };
