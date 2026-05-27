const express = require('express');
const { getThread } = require('../lib/kv');

const app = express();
app.use(express.json());

app.get('/api/debug-thread', async (req, res) => {
  // Gate on DEBUG_TOKEN when set — prevents unauthenticated PII exposure in production.
  // Set DEBUG_TOKEN env var to a shared secret; pass it as ?token=<secret> in the URL.
  if (process.env.DEBUG_TOKEN && req.query.token !== process.env.DEBUG_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const raw = req.query.phone || '';
  // Express/qs decodes '+' as a space in query strings.
  // Restore it so '+18325176982' works without requiring '%2B' encoding.
  const phone = raw.startsWith(' ') ? '+' + raw.slice(1).trim() : raw.trim();

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
