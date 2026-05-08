const nodemailer = require('nodemailer');

async function sendOrganizerEmail(organizerEmail, organizerName, contactName, confirmedDatetime) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  const date = new Date(confirmedDatetime).toLocaleString('en-US', {
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
    text: `Hi ${organizerName},\n\n${contactName} has confirmed a meeting with you.\n\nDate & Time: ${date}\n\nThis meeting was scheduled via SMS automation.\n\nBest,\nAlex (SMS Scheduling Assistant)`
  });
}

module.exports = { sendOrganizerEmail };
