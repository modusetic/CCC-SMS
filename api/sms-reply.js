const express = require('express');
const { getThread, saveThread } = require('../lib/kv');
const { getNextReply } = require('../lib/gemini');
const { bookCalendarEvent } = require('../lib/calendar');
const { sendOrganizerEmail } = require('../lib/email');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function twimlReply(message) {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Response><Message>${safe}</Message></Response>`;
}

app.post('/api/sms-reply', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  const from = req.body.From;
  const incomingMessage = req.body.Body;

  let thread;
  try {
    thread = await getThread(from);
  } catch (err) {
    console.error('[sms-reply] getThread error:', err.message);
    return res.send('<Response></Response>');
  }

  if (!thread) {
    return res.send(twimlReply("Sorry, I don't have an active scheduling request for this number."));
  }

  if (thread.status === 'confirmed') {
    return res.send('<Response></Response>');
  }

  try {
    const reply = await getNextReply(thread, incomingMessage);

    let parsed = null;
    try {
      parsed = JSON.parse(reply.trim());
    } catch (_) {}

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
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveThread(from, thread);

      return res.send(twimlReply(confirmMsg));
    } else {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      const smsSafeReply = reply.length > 160 ? reply.substring(0, 157) + '...' : reply;
      thread.conversationHistory.push({ role: 'model', content: smsSafeReply });
      await saveThread(from, thread);
      return res.send(twimlReply(smsSafeReply));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing reply:', err.message);
    return res.send('<Response></Response>');
  }
});

module.exports = app;
