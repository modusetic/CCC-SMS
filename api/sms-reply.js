const express = require('express');
const { getThread, saveThread } = require('../lib/kv');
const { sendSms } = require('../lib/twilio');
const { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply } = require('../lib/gemini');
const { bookCalendarEvent } = require('../lib/calendar');
const { sendOrganizerEmail } = require('../lib/email');
const { getSettings, DEFAULTS } = require('../lib/settings');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function twimlReply(message) {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Response><Message>${safe}</Message></Response>`;
}

// Gemini 2.5 Flash sometimes wraps JSON in ```json ... ``` — strip it before parsing
function extractJson(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : text.trim();
}

function truncate(text, limit = 160) {
  return text.length > limit ? text.substring(0, limit - 3) + '...' : text;
}

function formatConfirmedTime(datetime) {
  const match = datetime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return datetime;
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const h = parseInt(match[4], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${months[parseInt(match[2], 10) - 1]} ${parseInt(match[3], 10)} at ${h12}:${match[5]} ${ampm}`;
}

function applyTemplate(template, vars) {
  return template
    .replace(/\{contactName\}/g, () => vars.contactName || '')
    .replace(/\{organizerName\}/g, () => vars.organizerName || '')
    .replace(/\{confirmedDatetime\}/g, () => vars.confirmedDatetime || 'the agreed time');
}

async function demoSendSms(phone, message, demoMode) {
  if (demoMode) {
    console.log(`[demo] SMS suppressed → ${phone}: "${message}"`);
    return;
  }
  return sendSms(phone, message);
}

function listTimes(times) {
  return times.length === 1
    ? times[0]
    : times.map((t, i) => `${i + 1}. ${t}`).join(', ');
}

function worksQ(count) {
  return count === 1 ? 'Does this work for you?' : 'Which works?';
}

function pushOrganizerHistory(thread, userMsg, ackMsg) {
  thread.organizerConversationHistory = thread.organizerConversationHistory || [];
  thread.organizerConversationHistory.push({ role: 'user', content: userMsg });
  thread.organizerConversationHistory.push({ role: 'model', content: ackMsg });
}

async function saveBoth(thread) {
  const saves = [saveThread(thread.contactPhone, thread)];
  if (thread.organizerPhone) saves.push(saveThread(thread.organizerPhone, thread));
  await Promise.all(saves);
}

// Return the last model message from conversationHistory, or null.
function lastModelMsg(thread) {
  const msgs = (thread.conversationHistory || []).filter(m => m.role === 'model');
  return msgs.length > 0 ? msgs[msgs.length - 1].content : null;
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
    console.log(`[sms-reply] no thread for ${from}`);
    return res.send(twimlReply("Sorry, I don't have an active scheduling request for this number."));
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('[sms-reply] getSettings error (using defaults):', err.message);
    settings = { ...DEFAULTS };
  }

  const role = thread.organizerPhone && from === thread.organizerPhone ? 'organizer' : 'contact';
  console.log(`[sms-reply] from=${from} role=${role} status=${thread.status} waitingApproval=${thread.waitingForOrganizerApproval} msg="${incomingMessage}"`);

  if (thread.status === 'confirmed') {
    console.log('[sms-reply] thread already confirmed, ignoring');
    return res.send('<Response></Response>');
  }

  if (thread.organizerPhone && from === thread.organizerPhone) {
    return handleOrganizerReply(thread, incomingMessage, res, settings);
  }
  return handleContactReply(thread, incomingMessage, res, settings);
});

async function handleContactReply(thread, incomingMessage, res, settings) {
  // Contact texts while organizer is still reviewing the initial proposed times.
  // Record the message so context isn't lost when the organizer approves later.
  if (thread.status === 'waiting_organizer_initial') {
    const msg = truncate(
      applyTemplate(settings.holdingMessage, {
        contactName: thread.contactName,
        organizerName: thread.organizerName
      }),
      settings.maxMessageLength
    );
    thread.conversationHistory.push({ role: 'user', content: incomingMessage });
    thread.conversationHistory.push({ role: 'model', content: msg });
    await saveBoth(thread);
    return res.send(twimlReply(msg));
  }

  // Contact texts while we're waiting for the organizer to approve their counter-proposal.
  // Send a brief hold; don't call Gemini (it has no new info to act on).
  if (thread.waitingForOrganizerApproval) {
    const holdMsg = truncate(
      `Still checking with ${thread.organizerName} — I'll get back to you shortly!`,
      settings.maxMessageLength
    );
    return res.send(twimlReply(holdMsg));
  }

  // Hard stop once the exchange limit is reached.
  if (thread.attempts >= settings.maxExchanges) {
    const finalMsg = truncate(
      `I've had trouble finding a time that works for everyone. ${thread.organizerName} will be in touch with you directly to sort this out. Thanks for your patience!`,
      settings.maxMessageLength
    );
    thread.conversationHistory.push({ role: 'model', content: finalMsg });
    await saveBoth(thread);
    return res.send(twimlReply(finalMsg));
  }

  try {
    const reply = await getNextReply(thread, incomingMessage, settings);
    console.log(`[sms-reply] gemini raw reply: ${reply}`);

    let parsed = null;
    try { parsed = JSON.parse(extractJson(reply)); } catch (_) {}
    console.log(`[sms-reply] parsed action: ${parsed?.status ?? 'conversational'}`);

    if (parsed?.status === 'confirmed' && parsed?.datetime) {
      thread.status = 'confirmed';
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      try {
        await bookCalendarEvent(parsed.datetime, thread.contactName, thread.organizerEmail, thread.timezone);
      } catch (calErr) {
        console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
      }
      await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, parsed.datetime, thread.timezone);

      const confirmMsg = truncate(
        applyTemplate(settings.confirmationMessage, {
          contactName: thread.contactName,
          organizerName: thread.organizerName,
          confirmedDatetime: formatConfirmedTime(parsed.datetime)
        }),
        settings.maxMessageLength
      );
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      await saveBoth(thread);

      if (thread.organizerPhone) {
        const orgConfirmMsg = truncate(
          `${thread.contactName} confirmed! Meeting on ${formatConfirmedTime(parsed.datetime)}.`,
          settings.maxMessageLength
        );
        await demoSendSms(thread.organizerPhone, orgConfirmMsg, settings.demoMode);
      }

      return res.send(twimlReply(confirmMsg));

    } else if (parsed?.status === 'counter-proposal' && parsed?.suggestedTime) {
      thread.attempts += 1;
      thread.waitingForOrganizerApproval = true;
      thread.pendingContactSuggestion = parsed.suggestedTime;
      thread.pendingContactDatetime = parsed.suggestedDatetime || null;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      const holdingMsg = parsed.reply || `I'll check with ${thread.organizerName} and get back to you!`;
      const smsSafe = truncate(holdingMsg, settings.maxMessageLength);
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);

      if (thread.organizerPhone) {
        console.log(`[sms-reply] pinging organizer ${thread.organizerPhone} with counter-proposal`);
        const counterMsg = `${thread.contactName} suggests: ${parsed.suggestedTime}. Reply YES to approve or reply with alternative times.`;
        thread.organizerConversationHistory = thread.organizerConversationHistory || [];
        thread.organizerConversationHistory.push({ role: 'model', content: counterMsg });
        await saveBoth(thread);
        await demoSendSms(thread.organizerPhone, counterMsg, settings.demoMode);
      }

      return res.send(twimlReply(smsSafe));

    } else {
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });
      const smsSafe = truncate(reply, settings.maxMessageLength);
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      await saveBoth(thread);
      return res.send(twimlReply(smsSafe));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing contact reply:', err.message);
    return res.send('<Response></Response>');
  }
}

async function handleOrganizerReply(thread, incomingMessage, res, settings) {
  if (thread.status === 'waiting_organizer_initial') {
    return handleOrganizerInitialReview(thread, incomingMessage, res, settings);
  }

  if (!thread.waitingForOrganizerApproval) {
    try {
      thread.directorAlternatives = [...(thread.directorAlternatives || []), incomingMessage];
      const aiMsg = await getOrganizerUpdateReply(
        thread.organizerName, thread.contactName, incomingMessage, settings,
        {
          proposedTimes: thread.proposedTimes || [],
          directorAlternatives: thread.directorAlternatives || [],
          lastContactMsg: lastModelMsg(thread)
        }
      );
      const smsSafe = truncate(aiMsg, settings.maxMessageLength);
      const ackMsg = `Got it! I've let ${thread.contactName} know about your updated availability.`;
      thread.conversationHistory.push({ role: 'model', content: smsSafe });
      pushOrganizerHistory(thread, incomingMessage, ackMsg);
      await saveBoth(thread);
      await demoSendSms(thread.contactPhone, smsSafe, settings.demoMode);
      console.log(`[sms-reply] organizer unsolicited update — AI reply sent to contact ${thread.contactPhone}: "${smsSafe}"`);
      return res.send(twimlReply(ackMsg));
    } catch (err) {
      console.error('[sms-reply] Error handling organizer availability update:', err.message);
      return res.send('<Response></Response>');
    }
  }

  try {
    const decision = await getOrganizerApprovalDecision(
      thread.organizerName, thread.contactName,
      thread.pendingContactSuggestion, incomingMessage, settings,
      { directorAlternatives: thread.directorAlternatives || [] }
    );

    console.log(`[sms-reply] organizer approval decision=${decision.approved}`);
    if (decision.approved) {
      thread.status = 'confirmed';
      thread.waitingForOrganizerApproval = false;

      if (thread.pendingContactDatetime) {
        try {
          await bookCalendarEvent(thread.pendingContactDatetime, thread.contactName, thread.organizerEmail, thread.timezone);
        } catch (calErr) {
          console.error('[sms-reply] Calendar booking failed (non-fatal):', calErr.message);
        }
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactDatetime, thread.timezone);
      } else {
        await sendOrganizerEmail(thread.organizerEmail, thread.organizerName, thread.contactName, thread.pendingContactSuggestion, thread.timezone);
      }

      const confirmMsg = truncate(decision.contactMsg, settings.maxMessageLength);
      const orgAck = truncate(decision.organizerAck, settings.maxMessageLength);
      thread.conversationHistory.push({ role: 'model', content: confirmMsg });
      pushOrganizerHistory(thread, incomingMessage, orgAck);
      await saveBoth(thread);

      await demoSendSms(thread.contactPhone, confirmMsg, settings.demoMode);
      return res.send(twimlReply(orgAck));

    } else {
      thread.waitingForOrganizerApproval = false;
      thread.pendingContactSuggestion = null;
      thread.pendingContactDatetime = null;
      thread.directorAlternatives = [...(thread.directorAlternatives || []), incomingMessage];

      const contactMsg = truncate(decision.contactMsg, settings.maxMessageLength);
      const orgAck = truncate(decision.organizerAck, settings.maxMessageLength);
      thread.conversationHistory.push({ role: 'model', content: contactMsg });
      pushOrganizerHistory(thread, incomingMessage, orgAck);
      await saveBoth(thread);

      console.log(`[sms-reply] forwarding organizer response to contact ${thread.contactPhone}`);
      await demoSendSms(thread.contactPhone, contactMsg, settings.demoMode);
      return res.send(twimlReply(orgAck));
    }
  } catch (err) {
    console.error('[sms-reply] Error processing organizer approval:', err.message);
    return res.send(twimlReply('Sorry, something went wrong on our end. Please try again.'));
  }
}

async function handleOrganizerInitialReview(thread, incomingMessage, res, settings) {
  try {
    const aiMsg = await getOrganizerInitialContactMessage(
      thread.organizerName, thread.contactName,
      thread.proposedTimes, incomingMessage, settings
    );
    const smsBody = truncate(aiMsg, settings.maxMessageLength);

    const reply = `Got it! I've reached out to ${thread.contactName} with your availability.`;

    thread.status = 'pending';
    thread.directorAlternatives = [...(thread.directorAlternatives || []), incomingMessage];
    thread.conversationHistory.push({ role: 'model', content: smsBody });
    pushOrganizerHistory(thread, incomingMessage, reply);
    await saveBoth(thread);

    await demoSendSms(thread.contactPhone, smsBody, settings.demoMode);
    console.log(`[sms-reply] initial contact message sent to ${thread.contactPhone}: "${smsBody}"`);

    return res.send(twimlReply(reply));

  } catch (err) {
    console.error('[sms-reply] Error processing organizer initial review:', err.message);
    return res.send(twimlReply('Sorry, something went wrong sending the message. Please try again.'));
  }
}

module.exports = app;
