const express = require('express');
const { getThread } = require('../lib/kv');

const app = express();
app.use(express.json());

// Note: this endpoint is intentionally unauthenticated. It is called by the scheduling
// form's own browser to poll the conversation log it just initiated. A DEBUG_TOKEN gate
// would prevent the frontend from polling without extra auth plumbing. The data exposed
// (names, phones, history) is visible to whoever submitted the form, so the threat model
// is: someone guesses an active contact phone number. If this endpoint is ever publicly
// indexed or the app handles sensitive threads, add a threadId-keyed lookup instead.
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
    console.error('[conversation] getThread error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
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
