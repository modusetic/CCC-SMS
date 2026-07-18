const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSms(to, body) {
  const message = await client.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to
  });
  return message.sid;
}

// Verifies the request actually came from Twilio using the shared auth token
// and the X-Twilio-Signature header — prevents anyone who discovers the
// webhook URL from spoofing SMS replies via From/Body form fields.
function isValidTwilioRequest(req) {
  const signature = req.header('X-Twilio-Signature');
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) return false;
  const url = `https://${req.headers.host}${req.originalUrl}`;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);
}

module.exports = { sendSms, isValidTwilioRequest };
