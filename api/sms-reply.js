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

function truncate(text) {
  return text.length > 160 ? text.substring(0, 157) + '...' : text;
}

function listTimes(times) {
  return times.length === 1
    ? times[0]
    : times.map((t, i) => `${i + 1}. ${t}`).join(', ');
}

function worksQ(count) {
  return count === 1 ? 'Does this work for you?' : 'Which works?';
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
  if (thread.status === 'waiting_organizer_initial') {
    return res.send(twimlReply("Thanks for reaching out! We'll be in touch soon to confirm your appointment."));
  }

  try {
    const reply = await getNextReply(thread, incomingMessage);

    let parsed = null;
    try { parsed = JSON.parse(reply.trim()); } catch (_) {}

    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.status = 'confirmed';
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      try {
        await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail);
      } catch (calErr) {
        console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
      }
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
      const smsSafe = truncate(holdingMsg);
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);

      if (thread.organizerPhone) {
        await sendSms(thread.organizerPhone,
          `${thread.contactName} suggests: ${parsed.suggestedTime}. Reply YES to approve or reply with alternative times.`
        );
      }

      return res.send(twimlReply(smsSafe));

    } else {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      const smsSafe = truncate(reply);
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
  if (thread.status === 'waiting_organizer_initial') {
    return handleOrganizerInitialReview(thread, incomingMessage, res);
  }

  if (!thread.waitingForOrganizerApproval) {
    return res.send('<Response></Response>');
  }

  try {
    const isApproval = /\b(yes|approve|ok|confirm|confirmed|sounds good|great|perfect)\b/i.test(incomingMessage);

    if (isApproval) {
      thread.status = 'confirmed';
      thread.waitingForOrganizerApproval = false;

      if (thread.pendingContactDatetime) {
        try {
          await bookCalendarEvent(thread.pendingContactDatetime, thread.contactName, thread.organizerEmail);
        } catch (calErr) {
          console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
        }
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

      const contactMsg = truncate(`Update from ${thread.organizerName}: ${incomingMessage}. Does any of these work?`);
      thread.conversationHistory.push({ role: 'model', content: contactMsg });
      await saveBoth(thread);

      await sendSms(thread.contactPhone, contactMsg);
      return res.send(twimlReply(`Got it! I've forwarded your suggestion to ${thread.contactName}.`));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing organizer approval:', err.message);
    return res.send('<Response></Response>');
  }
}

async function handleOrganizerInitialReview(thread, incomingMessage, res) {
  try {
    const isApproval = /\b(yes|approve|ok|confirm|confirmed|sounds good|great|perfect)\b/i.test(incomingMessage);

    let smsBody;
    if (isApproval) {
      const n = thread.proposedTimes.length;
      smsBody = truncate(
        `Hi ${thread.contactName}! You can schedule for: ${listTimes(thread.proposedTimes)}. ${worksQ(n)}`
      );
    } else {
      smsBody = truncate(
        `Hi ${thread.contactName}! ${thread.organizerName} is available for: ${incomingMessage}. Which works?`
      );
    }

    thread.status = 'pending';
    thread.conversationHistory.push({ role: 'model', content: smsBody });
    await saveBoth(thread);

    await sendSms(thread.contactPhone, smsBody);

    const reply = isApproval
      ? `Got it! I've reached out to ${thread.contactName} with the proposed times.`
      : `Got it! I've sent ${thread.contactName} your available times.`;
    return res.send(twimlReply(reply));

  } catch (err) {
    console.error('[sms-reply] Error processing organizer initial review:', err.message);
    return res.send('<Response></Response>');
  }
}

module.exports = app;
