const express = require('express');
const { getThreadById, getThread } = require('../lib/kv');

const app = express();
app.use(express.json());

app.get('/api/conversation', async (req, res) => {
  const threadId = req.query.threadId;
  const raw = req.query.phone || '';
  const phone = raw.startsWith(' ') ? '+' + raw.slice(1).trim() : raw.trim();

  if (!threadId && !phone) {
    return res.status(400).json({ error: 'Missing ?threadId= or ?phone= query parameter' });
  }

  let thread;
  try {
    if (threadId) {
      thread = await getThreadById(threadId);
    } else {
      thread = await getThread(phone);
    }
  } catch (err) {
    console.error('[conversation] lookup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!thread) {
    return res.status(404).json({ found: false, ...(threadId ? { threadId } : { phone }) });
  }

  return res.status(200).json({
    found: true,
    status:                       thread.status,
    waitingForOrganizerApproval:  thread.waitingForOrganizerApproval || false,
    contactName:                  thread.contactName,
    contactPhone:                 thread.contactPhone,
    organizerName:                thread.organizerName,
    organizerPhone:               thread.organizerPhone || null,
    conversationHistory:          thread.conversationHistory || [],
    organizerConversationHistory: thread.organizerConversationHistory || []
  });
});

module.exports = app;
