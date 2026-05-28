const express = require('express');
const { getSettings, saveSettings } = require('../lib/settings');

const app = express();
app.use(express.json());

// No authentication — this app is used in testing/demo contexts where the operator
// controls access to the UI. If deploying in a multi-tenant environment, gate POST
// behind a token (see api/debug-thread.js for the DEBUG_TOKEN pattern).

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await getSettings();
    return res.status(200).json(settings);
  } catch (err) {
    console.error('[settings] getSettings error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const saved = await saveSettings(req.body || {});
    return res.status(200).json(saved);
  } catch (err) {
    if (err.isValidation) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[settings] saveSettings error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;
