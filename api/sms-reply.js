const express = require('express');
const { getThread, saveThread } = require('../lib/kv');
const { sendSms } = require('../lib/twilio');
const { getNextReply } = require('../lib/gemini');
const { bookCalendarEvent } = require('../lib/calendar');
const { sendOrganizerEmail } = require('../lib/email');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post('/api/sms-reply', (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const from = req.body.From;
  const incomingMessage = req.body.Body;

  processReply(from, incomingMessage).catch(err => {
    console.error('[sms-reply] Unhandled error:', err.message);
  });
});

async function processReply(from, incomingMessage) {
  const thread = await getThread(from);

  if (!thread) {
    await sendSms(from, "Sorry, I don't have an active scheduling request for this number.");
    return;
  }

  if (thread.status === 'confirmed') {
    return;
  }

  try {
    const reply = await getNextReply(thread, incomingMessage);

    let parsed = null;
    try {
      parsed = JSON.parse(reply.trim());
    } catch (_) {
      // Conversational reply, not a JSON confirmation
    }

    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.status = 'confirmed';
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      await saveThread(from, thread);

      await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail);
      await sendOrganizerEmail(
        thread.organizerEmail,
        thread.organizerName,
        thread.contactName,
        parsed.datetime
      );

      const confirmMsg = `Your meeting with ${thread.organizerName} is confirmed! You'll receive details soon.`;
      await sendSms(from, confirmMsg);

      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveThread(from, thread);
    } else {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      const smsSafeReply = reply.length > 160 ? reply.substring(0, 157) + '...' : reply;
      thread.conversationHistory.push({ role: 'model', content: smsSafeReply });
      await saveThread(from, thread);
      await sendSms(from, smsSafeReply);
    }
  } catch (err) {
    console.error('[sms-reply] Error processing reply:', err.message);
  }
}

module.exports = app;
