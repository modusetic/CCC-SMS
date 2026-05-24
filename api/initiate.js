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

app.post('/api/initiate', async (req, res) => {
  const {
    contactName,
    contactPhone,
    organizerName,
    organizerEmail,
    organizerPhone,
    proposedTimes,
    directorAlternatives
  } = req.body;

  if (!contactName || !contactPhone || !organizerName || !organizerEmail || !proposedTimes?.length) {
    return res.status(400).json({
      error: 'Missing required fields: contactName, contactPhone, organizerName, organizerEmail, proposedTimes (non-empty array)'
    });
  }

  const hasOrganizerPhone = Boolean(organizerPhone);
  const backupTimes = Array.isArray(directorAlternatives) ? directorAlternatives : [];
  const hasBackupTimes = backupTimes.length > 0;

  const thread = {
    threadId: uuidv4(),
    contactName,
    contactPhone,
    organizerName,
    organizerEmail,
    organizerPhone: organizerPhone || null,
    proposedTimes,
    directorAlternatives: backupTimes,
    status: 'pending',
    waitingForOrganizerApproval: false,
    pendingContactSuggestion: null,
    pendingContactDatetime: null,
    attempts: 0,
    conversationHistory: [],
    createdAt: new Date().toISOString()
  };

  try {
    if (hasOrganizerPhone && !hasBackupTimes) {
      // Contact's proposed times go to organizer for review first; contact waits.
      // Save BEFORE sending so Redis is always consistent with what was texted.
      thread.status = 'waiting_organizer_initial';
      const n = proposedTimes.length;
      const smsBody = truncate(
        `${contactName} wants to schedule. Their proposed ${timeWord(n)}: ${listTimes(proposedTimes)}. Reply APPROVE or with your available ${timeWord(n)}.`
      );
      await Promise.all([saveThread(contactPhone, thread), saveThread(organizerPhone, thread)]);
      console.log(`[initiate] thread ${thread.threadId} saved (waiting_organizer_initial) contact=${contactPhone} organizer=${organizerPhone}`);
      await sendSms(organizerPhone, smsBody);

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
      await Promise.all([saveThread(contactPhone, thread), saveThread(organizerPhone, thread)]);
      console.log(`[initiate] thread ${thread.threadId} saved (pending+backupTimes) contact=${contactPhone} organizer=${organizerPhone}`);
      await sendSms(contactPhone, contactMsg);
      await sendSms(organizerPhone, orgFyi);

    } else {
      // No organizer phone — send contact the proposed times directly.
      const n = proposedTimes.length;
      const label = n === 1 ? 'Available time' : 'Options';
      const smsBody = truncate(
        `Hi ${contactName}! ${organizerName} would like to meet. ${label}: ${listTimes(proposedTimes)}. ${worksQ(n)}`
      );
      thread.conversationHistory.push({ role: 'model', content: smsBody });
      await saveThread(contactPhone, thread);
      console.log(`[initiate] thread ${thread.threadId} saved (pending, no organizer) contact=${contactPhone}`);
      await sendSms(contactPhone, smsBody);
    }

    res.status(200).json({ threadId: thread.threadId, message: 'Scheduling initiated' });
  } catch (err) {
    console.error('[initiate] Error:', err.message);
    res.status(500).json({ error: 'Failed to initiate scheduling' });
  }
});

module.exports = app;
