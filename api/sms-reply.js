const express = require('express');
const { getThread, saveThread } = require('../lib/kv');
const { sendSms } = require('../lib/twilio');
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

async function saveBoth(thread) {
  const saves = [saveThread(thread.contactPhone, thread)];
  if (thread.organizerPhone) saves.push(saveThread(thread.organizerPhone, thread));
  await Promise.all(saves);
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

  if (thread.organizerPhone && from === thread.organizerPhone) {
    return handleOrganizerReply(thread, incomingMessage, res);
  }
  return handleContactReply(thread, incomingMessage, res);
});

async function handleContactReply(thread, incomingMessage, res) {
  try {
    const reply = await getNextReply(thread, incomingMessage);

    let parsed = null;
    try { parsed = JSON.parse(reply.trim()); } catch (_) {}

    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.status = 'confirmed';
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail);
      await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, parsed.datetime);

      const confirmMsg = `Your meeting with ${thread.organizerName} is confirmed! You'll receive details soon.`;
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveBoth(thread);

      return res.send(twimlReply(confirmMsg));

    } else if (parsed?.status === 'counter-proposal' && parsed?.suggestedTime) {
      thread.attempts += 1;
      thread.waitingForOrganizerApproval = true;
      thread.pendingContactSuggestion = parsed.suggestedTime;
      thread.pendingContactDatetime = parsed.suggestedDatetime || null;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      const holdingMsg = parsed.reply || `I'll check with ${thread.organizerName} and get back to you!`;
      const smsSafe = holdingMsg.length > 160 ? holdingMsg.substring(0, 157) + '...' : holdingMsg;
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);

      if (thread.organizerPhone) {
        const orgMsg = `${thread.contactName} suggests: ${parsed.suggestedTime}. Reply YES to approve or reply with alternative times.`;
        await sendSms(thread.organizerPhone, orgMsg);
      }

      return res.send(twimlReply(smsSafe));

    } else {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      const smsSafe = reply.length > 160 ? reply.substring(0, 157) + '...' : reply;
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);
      return res.send(twimlReply(smsSafe));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing contact reply:', err.message);
    return res.send('<Response></Response>');
  }
}

async function handleOrganizerReply(thread, incomingMessage, res) {
  try {
    if (!thread.waitingForOrganizerApproval) {
      return res.send('<Response></Response>');
    }

    const isApproval = /\b(yes|approve|ok|confirm|confirmed|sounds good|great|perfect)\b/i.test(incomingMessage);

    if (isApproval) {
      thread.status = 'confirmed';
      thread.waitingForOrganizerApproval = false;

      if (thread.pendingContactDatetime) {
        await bookCalendarEvent(thread.pendingContactDatetime, thread.contactName, thread.organizerEmail);
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactDatetime);
      } else {
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactSuggestion);
      }

      const confirmMsg = `Great news! Your meeting with ${thread.organizerName} is confirmed for ${thread.pendingContactSuggestion}.`;
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveBoth(thread);

      await sendSms(thread.contactPhone, confirmMsg);
      return res.send(twimlReply(`Confirmed! I've let ${thread.contactName} know.`));

    } else {
      thread.waitingForOrganizerApproval = false;
      thread.pendingContactSuggestion = null;
      thread.pendingContactDatetime = null;

      const contactMsg = `Update from ${thread.organizerName}: ${incomingMessage}. Does any of these work?`;
      const smsSafe = contactMsg.length > 160 ? contactMsg.substring(0, 157) + '...' : contactMsg;
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);

      await sendSms(thread.contactPhone, smsSafe);
      return res.send(twimlReply(`Got it! I've forwarded your suggestion to ${thread.contactName}.`));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing organizer reply:', err.message);
    return res.send('<Response></Response>');
  }
}

module.exports = app;
