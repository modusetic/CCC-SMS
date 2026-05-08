const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { saveThread } = require('../lib/kv');
const { sendSms } = require('../lib/twilio');

const app = express();
app.use(express.json());

app.post('/api/initiate', async (req, res) => {
  const { contactName, contactPhone, organizerName, organizerEmail, proposedTimes } = req.body;

  if (!contactName || !contactPhone || !organizerName || !organizerEmail || !proposedTimes?.length) {
    return res.status(400).json({
      error: 'Missing required fields: contactName, contactPhone, organizerName, organizerEmail, proposedTimes (non-empty array)'
    });
  }

  const thread = {
    threadId: uuidv4(),
    contactName,
    contactPhone,
    organizerName,
    organizerEmail,
    proposedTimes,
    status: 'pending',
    attempts: 0,
    conversationHistory: [],
    createdAt: new Date().toISOString()
  };

  try {
    await saveThread(contactPhone, thread);

    const timesList = proposedTimes.map((t, i) => `${i + 1}. ${t}`).join(', ');
    const full = `Hi ${contactName}! ${organizerName} would like to meet. Options: ${timesList}. Which works?`;
    const smsBody = full.length > 160 ? full.substring(0, 157) + '...' : full;

    await sendSms(contactPhone, smsBody);

    thread.conversationHistory.push({ role: 'model', content: smsBody });
    await saveThread(contactPhone, thread);

    res.status(200).json({ threadId: thread.threadId, message: 'Scheduling initiated' });
  } catch (err) {
    console.error('[initiate] Error:', err.message);
    res.status(500).json({ error: 'Failed to initiate scheduling' });
  }
});

module.exports = app;
