const express = require('express');
const {
  getThreadById, saveThreadById,
  getPhoneIndex, removeFromPhoneIndex,
  getPendingMessage, setPendingMessage, deletePendingMessage
} = require('../lib/kv');
const { sendSms, isValidTwilioRequest } = require('../lib/twilio');
const { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply } = require('../lib/gemini');
const { bookCalendarEvent } = require('../lib/calendar');
const { sendOrganizerEmail } = require('../lib/email');
const { getSettings, DEFAULTS } = require('../lib/settings');
const { checkAdminToken } = require('../lib/auth');

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

function orgPrelude(contactName, context) {
  return `[${contactName} | ${context}] `;
}

function pushOrganizerHistory(thread, userMsg, ackMsg) {
  thread.organizerConversationHistory = thread.organizerConversationHistory || [];
  thread.organizerConversationHistory.push({ role: 'user', content: userMsg });
  thread.organizerConversationHistory.push({ role: 'model', content: ackMsg });
}

async function saveBoth(thread) {
  thread.lastActivityAt = new Date().toISOString();
  await saveThreadById(thread.threadId, thread);
  if (thread.status === 'confirmed') {
    await removeFromPhoneIndex(thread.contactPhone, thread.threadId);
    if (thread.organizerPhone) await removeFromPhoneIndex(thread.organizerPhone, thread.threadId);
  }
}

// Return the last model message from conversationHistory, or null.
function lastModelMsg(thread) {
  const msgs = (thread.conversationHistory || []).filter(m => m.role === 'model');
  return msgs.length > 0 ? msgs[msgs.length - 1].content : null;
}

async function loadActiveThreadsForPhone(phone) {
  const ids = await getPhoneIndex(phone);
  if (ids.length === 0) return [];
  const results = await Promise.all(ids.map(id => getThreadById(id)));
  const expiredIds = ids.filter((_, i) => results[i] === null);
  if (expiredIds.length > 0) {
    await Promise.all(expiredIds.map(id => removeFromPhoneIndex(phone, id)));
  }
  return results.filter(t => t !== null && t.status !== 'confirmed');
}

function buildDisambiguationList(threads) {
  const items = threads.map((t, i) => {
    let context;
    if (t.waitingForOrganizerApproval) {
      context = `approving: ${t.pendingContactSuggestion}`;
    } else if (t.status === 'waiting_organizer_initial') {
      context = `initial review — proposed: ${(t.proposedTimes || []).join(', ')}`;
    } else {
      const lastMsg = (t.directorMessages || []).slice(-1)[0];
      context = lastMsg
        ? `last update: ${lastMsg}`
        : `pending — proposed: ${(t.proposedTimes || []).join(', ')}`;
    }
    return `${i + 1}. ${t.contactName} — ${context}`;
  });
  return `You have ${threads.length} active conversations. Which are you responding to?\n${items.join('\n')}`;
}

async function handleOrganizerRouting(organizerPhone, incomingMessage, res, settings, orgThreads) {
  const pendingMsg = await getPendingMessage(organizerPhone);

  const waitingThreads = orgThreads.filter(
    t => t.status === 'waiting_organizer_initial' || t.waitingForOrganizerApproval
  );

  // Mid-disambiguation: organizer is selecting from a previously shown list
  if (pendingMsg !== null) {
    // If only one thread is available now (threads resolved since list was shown),
    // auto-route the stored message rather than showing a stale list.
    const autoRoute = waitingThreads.length === 1 ? waitingThreads[0]
      : waitingThreads.length === 0 && orgThreads.length === 1 ? orgThreads[0]
      : null;
    if (autoRoute) {
      await deletePendingMessage(organizerPhone);
      return handleOrganizerReply(autoRoute, pendingMsg, res, settings);
    }

    const listThreads = waitingThreads.length >= 2 ? waitingThreads : orgThreads;
    const trimmed = incomingMessage.trim();
    const num = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : NaN;
    if (num >= 1 && num <= listThreads.length) {
      await deletePendingMessage(organizerPhone);
      return handleOrganizerReply(listThreads[num - 1], pendingMsg, res, settings);
    }
    return res.send(twimlReply(buildDisambiguationList(listThreads)));
  }

  // 1 waiting → auto-route
  if (waitingThreads.length === 1) {
    return handleOrganizerReply(waitingThreads[0], incomingMessage, res, settings);
  }

  // 2+ waiting → disambiguation
  if (waitingThreads.length >= 2) {
    await setPendingMessage(organizerPhone, incomingMessage);
    return res.send(twimlReply(buildDisambiguationList(waitingThreads)));
  }

  // 0 waiting: unsolicited update
  if (orgThreads.length === 1) {
    return handleOrganizerReply(orgThreads[0], incomingMessage, res, settings);
  }

  // Multiple active, none waiting — disambiguation across all active
  await setPendingMessage(organizerPhone, incomingMessage);
  return res.send(twimlReply(buildDisambiguationList(orgThreads)));
}

app.post('/api/sms-reply', async (req, res) => {
  res.set('Content-Type', 'text/xml');

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('[sms-reply] getSettings error (using defaults):', err.message);
    settings = { ...DEFAULTS };
  }

  // Require a genuine Twilio signature on every request. The one exception is the
  // frontend's demo-mode reply simulator, which posts to this same route — it's only
  // allowed through when demoMode is explicitly enabled AND the caller presents the
  // operator's admin token, so a stranger who finds this URL can't spoof From/Body.
  if (!isValidTwilioRequest(req) && !(settings.demoMode && checkAdminToken(req, { allowQuery: false }))) {
    console.warn('[sms-reply] rejected request with invalid Twilio signature');
    return res.send('<Response></Response>');
  }

  const from = req.body.From;
  const incomingMessage = req.body.Body;

  let activeThreads;
  try {
    activeThreads = await loadActiveThreadsForPhone(from);
  } catch (err) {
    console.error('[sms-reply] loadActiveThreadsForPhone error:', err.message);
    return res.send('<Response></Response>');
  }

  if (activeThreads.length === 0) {
    console.log(`[sms-reply] no active threads for ${from}`);
    await deletePendingMessage(from).catch(() => {});
    return res.send(twimlReply("Sorry, I don't have an active scheduling request for this number."));
  }

  const isOrganizer = activeThreads.some(t => t.organizerPhone === from);

  if (isOrganizer) {
    const orgThreads = activeThreads.filter(t => t.organizerPhone === from);
    console.log(`[sms-reply] from=${from} role=organizer activeOrgThreads=${orgThreads.length} msg="${incomingMessage}"`);
    return handleOrganizerRouting(from, incomingMessage, res, settings, orgThreads);
  }

  const thread = activeThreads.sort(
    (a, b) => new Date(b.lastActivityAt || b.createdAt) - new Date(a.lastActivityAt || a.createdAt)
  )[0];

  console.log(`[sms-reply] from=${from} role=contact status=${thread.status} waitingApproval=${thread.waitingForOrganizerApproval} msg="${incomingMessage}"`);

  if (thread.status === 'confirmed') {
    console.log('[sms-reply] thread already confirmed, ignoring');
    return res.send('<Response></Response>');
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
      thread.attempts += 1;
      thread.conversationHistory.push({ role: 'user', content: incomingMessage });

      const autoConfirmEligible = Boolean(thread.organizerPhone)
        && settings.autoConfirmPreApprovedTimes === true
        && parsed.matchesOrganizerPreApproval === true;

      if (thread.organizerPhone && !autoConfirmEligible) {
        // Require explicit organizer sign-off before finalizing, unless the organizer
        // already unambiguously pre-approved this exact time (see autoConfirmEligible above).
        thread.waitingForOrganizerApproval = true;
        thread.pendingContactSuggestion = formatConfirmedTime(parsed.datetime);
        thread.pendingContactDatetime = parsed.datetime;

        const holdMsg = truncate(
          `Just confirming with ${thread.organizerName} — I'll let you know shortly!`,
          settings.maxMessageLength
        );
        thread.conversationHistory.push({ role: 'model', content: holdMsg });

        const orgMsg = orgPrelude(thread.contactName, `agreed: ${formatConfirmedTime(parsed.datetime)}`) +
          `${thread.contactName} agreed to ${formatConfirmedTime(parsed.datetime)}. Reply YES to confirm or suggest an alternative.`;
        thread.organizerConversationHistory = thread.organizerConversationHistory || [];
        thread.organizerConversationHistory.push({ role: 'model', content: orgMsg });
        await saveBoth(thread);
        await demoSendSms(thread.organizerPhone, truncate(orgMsg, settings.maxMessageLength), settings.demoMode);
        console.log(`[sms-reply] contact agreed — awaiting organizer final confirm for thread ${thread.threadId}`);
        return res.send(twimlReply(holdMsg));
      }

      // No organizer phone, or organizer already pre-approved this exact time — confirm immediately
      thread.status = 'confirmed';
      thread.confirmedDatetime = parsed.datetime;

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

      if (autoConfirmEligible) {
        const orgFyi = orgPrelude(thread.contactName, `auto-confirmed: ${formatConfirmedTime(parsed.datetime)}`) +
          `${thread.contactName} confirmed ${formatConfirmedTime(parsed.datetime)} — already booked per your earlier OK, no action needed!`;
        thread.organizerConversationHistory = thread.organizerConversationHistory || [];
        thread.organizerConversationHistory.push({ role: 'model', content: orgFyi });
        await saveBoth(thread);
        await demoSendSms(thread.organizerPhone, truncate(orgFyi, settings.maxMessageLength), settings.demoMode);
        console.log(`[sms-reply] auto-confirmed pre-approved time for thread ${thread.threadId}, organizer notified`);
      } else {
        await saveBoth(thread);
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
        const counterMsg = orgPrelude(thread.contactName, `pending: ${parsed.suggestedTime}`) +
          `${thread.contactName} suggests: ${parsed.suggestedTime}. Reply YES to approve or reply with alternative times.`;
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
      thread.directorMessages = [...(thread.directorMessages || []), incomingMessage];
      const { contactMessage, exactApprovedTime } = await getOrganizerUpdateReply(
        thread.organizerName, thread.contactName, incomingMessage, settings,
        {
          offeredTimes: thread.offeredTimes || [],
          directorMessages: thread.directorMessages || [],
          rejectedTimes: thread.rejectedTimes || [],
          lastContactMsg: lastModelMsg(thread)
        }
      );
      const smsSafe = truncate(contactMessage, settings.maxMessageLength);
      const ackMsg = `Got it! I've let ${thread.contactName} know about your updated availability.`;
      thread.organizerPreApprovedTime = exactApprovedTime;
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
      {
        directorAlternatives: thread.directorAlternatives || [],
        directorMessages: thread.directorMessages || [],
        rejectedTimes: thread.rejectedTimes || []
      }
    );

    console.log(`[sms-reply] organizer approval decision=${decision.approved}`);
    if (decision.approved) {
      thread.status = 'confirmed';
      thread.confirmedDatetime = thread.pendingContactDatetime || thread.pendingContactSuggestion;
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
      if (thread.pendingContactSuggestion) {
        thread.rejectedTimes = [...(thread.rejectedTimes || []), thread.pendingContactSuggestion];
      }
      thread.pendingContactSuggestion = null;
      thread.pendingContactDatetime = null;
      thread.directorMessages = [...(thread.directorMessages || []), incomingMessage];

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
    const { contactMessage, exactApprovedTime } = await getOrganizerInitialContactMessage(
      thread.organizerName, thread.contactName,
      thread.proposedTimes, incomingMessage, settings
    );
    const smsBody = truncate(contactMessage, settings.maxMessageLength);

    const reply = `Got it! I've reached out to ${thread.contactName} with your availability.`;

    thread.status = 'pending';
    thread.directorMessages = [...(thread.directorMessages || []), incomingMessage];
    thread.offeredTimes = thread.proposedTimes || [];
    thread.organizerPreApprovedTime = exactApprovedTime;
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
