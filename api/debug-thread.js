const express = require('express');
const { getThread } = require('../lib/kv');

const app = express();
app.use(express.json());

app.get('/api/debug-thread', async (req, res) => {
  const { phone } = req.query;

  if (!phone) {
    return res.status(400).json({ error: 'Missing ?phone= query parameter (E.164 format, e.g. +15551234567)' });
  }

  let thread;
  try {
    thread = await getThread(phone);
  } catch (err) {
    return res.status(500).json({ error: 'Redis lookup failed', detail: err.message });
  }

  if (!thread) {
    return res.status(404).json({ phone, found: false, message: 'No thread found for this number' });
  }

  // Return a readable summary — full conversationHistory can be noisy,
  // so show a count + the last two entries instead.
  const history = thread.conversationHistory || [];
  const lastTwo = history.slice(-2);

  return res.status(200).json({
    phone,
    found: true,
    threadId:                  thread.threadId,
    createdAt:                 thread.createdAt,
    status:                    thread.status,
    contactName:               thread.contactName,
    contactPhone:              thread.contactPhone,
    organizerName:             thread.organizerName,
    organizerEmail:            thread.organizerEmail,
    organizerPhone:            thread.organizerPhone,
    proposedTimes:             thread.proposedTimes,
    directorAlternatives:      thread.directorAlternatives,
    attempts:                  thread.attempts,
    waitingForOrganizerApproval: thread.waitingForOrganizerApproval,
    pendingContactSuggestion:  thread.pendingContactSuggestion,
    conversationHistoryLength: history.length,
    lastTwoMessages:           lastTwo
  });
});

module.exports = app;
