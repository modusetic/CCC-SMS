const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { saveThread } = require('../lib/kv');
const { sendSms } = require('../lib/twilio');

const app = express();
app.use(express.json());

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

function timeWord(count) {
  return count === 1 ? 'time' : 'times';
}

// Normalize a phone number to E.164 (+digits).
// Handles: '+18325176982', '18325176982', '(832) 517-6982', '832-517-6982'.
// Twilio always sends E.164 in webhooks, so Redis keys must match that format.
// Returns null for garbage input (fewer than 7 digits) so callers treat it as absent.
function normalizePhone(phone) {
  if (!phone) return null;
  const stripped = phone.trim().replace(/[^\d+]/g, ''); // keep digits and +
  // Require at least 7 digits — rejects '---', '()', '+', etc. which would
  // otherwise produce a truthy "+" string and cause a stuck Redis thread.
  if (stripped.replace(/[^0-9]/g, '').length < 7) return null;
  return stripped.startsWith('+') ? stripped : `+${stripped}`;
}

app.post('/api/initiate', async (req, res) => {
  const {
    contactName,
    contactPhone,
    organizerName,
    organizerEmail,
    organizerPhone,
    proposedTimes,
    directorAlternatives,
    timezone
  } = req.body;

  if (!contactName || !contactPhone || !organizerName || !organizerEmail || !proposedTimes?.length) {
    return res.status(400).json({
      error: 'Missing required fields: contactName, contactPhone, organizerName, organizerEmail, proposedTimes (non-empty array)'
    });
  }

  const normalizedContactPhone  = normalizePhone(contactPhone);
  const normalizedOrganizerPhone = normalizePhone(organizerPhone);
  const hasOrganizerPhone = Boolean(normalizedOrganizerPhone);
  const backupTimes = Array.isArray(directorAlternatives) ? directorAlternatives : [];
  const hasBackupTimes = backupTimes.length > 0;

  const thread = {
    threadId: uuidv4(),
    contactName,
    contactPhone:  normalizedContactPhone,
    organizerName,
    organizerEmail,
    organizerPhone: normalizedOrganizerPhone,
    proposedTimes,
    directorAlternatives: backupTimes,
    timezone: timezone || process.env.TIMEZONE || 'America/New_York',
    status: 'pending',
    waitingForOrganizerApproval: false,
    pendingContactSuggestion: null,
    pendingContactDatetime: null,
    attempts: 0,
    conversationHistory: [],
    organizerConversationHistory: [],
    createdAt: new Date().toISOString()
  };

  try {
    if (hasOrganizerPhone && !hasBackupTimes) {
      // Contact's proposed times go to organizer for review first; contact waits.
      // Save BEFORE sending so Redis is always consistent with what was texted.
      thread.status = 'waiting_organizer_initial';
      const n = proposedTimes.length;
      const smsBody = truncate(
        `${contactName} wants to schedule. Proposed ${timeWord(n)}: ${listTimes(proposedTimes)}. Reply to confirm or suggest different times.`
      );
      thread.organizerConversationHistory.push({ role: 'model', content: smsBody });
      await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);
      console.log(`[initiate] thread ${thread.threadId} saved (waiting_organizer_initial) contact=${normalizedContactPhone} organizer=${normalizedOrganizerPhone}`);
      await sendSms(normalizedOrganizerPhone, smsBody);

    } else if (hasOrganizerPhone && hasBackupTimes) {
      // Organizer pre-approved backup times — send to contact immediately, FYI to organizer.
      // Build messages and push to history first, then save, then send.
      const n = backupTimes.length;
      const contactMsg = truncate(
        `Hi ${contactName}! ${organizerName} is available for: ${listTimes(backupTimes)}. ${worksQ(n)}`
      );
      thread.conversationHistory.push({ role: 'model', content: contactMsg });
      const orgFyi = truncate(
        `Scheduling started with ${contactName}. I've sent them your available ${timeWord(n)} and will let you know when confirmed.`
      );
      // orgFyi goes to organizerConversationHistory — NOT conversationHistory.
      // Putting it in conversationHistory would create two consecutive 'model' entries
      // which breaks Gemini's multi-turn API.
      thread.organizerConversationHistory.push({ role: 'model', content: orgFyi });
      await Promise.all([saveThread(normalizedContactPhone, thread), saveThread(normalizedOrganizerPhone, thread)]);
      console.log(`[initiate] thread ${thread.threadId} saved (pending+backupTimes) contact=${normalizedContactPhone} organizer=${normalizedOrganizerPhone}`);
      await sendSms(normalizedContactPhone, contactMsg);
      await sendSms(normalizedOrganizerPhone, orgFyi);

    } else {
      // No organizer phone — send contact the proposed times directly.
      const n = proposedTimes.length;
      const label = n === 1 ? 'Available time' : 'Options';
      const smsBody = truncate(
        `Hi ${contactName}! ${organizerName} would like to meet. ${label}: ${listTimes(proposedTimes)}. ${worksQ(n)}`
      );
      thread.conversationHistory.push({ role: 'model', content: smsBody });
      await saveThread(normalizedContactPhone, thread);
      console.log(`[initiate] thread ${thread.threadId} saved (pending, no organizer) contact=${normalizedContactPhone}`);
      await sendSms(normalizedContactPhone, smsBody);
    }

    res.status(200).json({ threadId: thread.threadId, message: 'Scheduling initiated' });
  } catch (err) {
    console.error('[initiate] Error:', err.message);
    res.status(500).json({ error: 'Failed to initiate scheduling' });
  }
});

module.exports = app;
