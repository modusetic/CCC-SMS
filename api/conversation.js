const express = require('express');
const { getThread } = require('../lib/kv');

const app = express();
app.use(express.json());

app.get('/api/conversation', async (req, res) => {
  const raw = req.query.phone || '';
  // Express/qs decodes '+' as a space in query strings — restore it.
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
    return res.status(404).json({ found: false, phone });
  }

  return res.status(200).json({
    found: true,
    status:                        thread.status,
    waitingForOrganizerApproval:   thread.waitingForOrganizerApproval || false,
    contactName:                   thread.contactName,
    contactPhone:                  thread.contactPhone,
    organizerName:                 thread.organizerName,
    organizerPhone:                thread.organizerPhone || null,
    conversationHistory:           thread.conversationHistory || [],
    organizerConversationHistory:  thread.organizerConversationHistory || []
  });
});

module.exports = app;
