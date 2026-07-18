const express = require('express');
const { getPhoneIndex, getThreadById } = require('../lib/kv');
const { requireAdminToken } = require('../lib/auth');

const app = express();
app.use(express.json());

app.get('/api/debug-thread', async (req, res) => {
  // Fail-closed: DEBUG_TOKEN must be set AND match (see lib/auth.js) — an unset
  // env var denies access rather than leaving this PII endpoint wide open.
  if (!requireAdminToken(req, res)) return;

  const raw = req.query.phone || '';
  // Express/qs decodes '+' as a space in query strings.
  // Restore it so '+18325176982' works without requiring '%2B' encoding.
  const phone = raw.startsWith(' ') ? '+' + raw.slice(1).trim() : raw.trim();

  if (!phone) {
    return res.status(400).json({ error: 'Missing ?phone= query parameter (E.164 format, e.g. +15551234567)' });
  }

  let thread;
  try {
    const ids = await getPhoneIndex(phone);
    if (ids.length > 0) {
      const threads = (await Promise.all(ids.map(id => getThreadById(id)))).filter(Boolean);
      thread = threads.sort(
        (a, b) => new Date(b.lastActivityAt || b.createdAt || 0) - new Date(a.lastActivityAt || a.createdAt || 0)
      )[0] || null;
    }
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
