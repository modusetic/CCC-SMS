const express = require('express');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');

const app = express();

app.get('/api/test-credentials', async (req, res) => {
  const results = {};

  // ── Google Calendar ────────────────────────────────────────────────────────
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var not set');

    const credentials = JSON.parse(raw);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) throw new Error('GOOGLE_CALENDAR_ID env var not set');

    // Fetch calendar metadata only — no event created
    const calRes = await calendar.calendars.get({ calendarId });
    results.calendar = { ok: true, summary: calRes.data.summary, id: calRes.data.id };
  } catch (err) {
    results.calendar = { ok: false, error: err.message };
  }

  // ── Gmail SMTP ─────────────────────────────────────────────────────────────
  try {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user) throw new Error('GMAIL_USER env var not set');
    if (!pass) throw new Error('GMAIL_APP_PASSWORD env var not set');

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass }
    });

    // verify() checks SMTP auth without sending anything
    await transporter.verify();
    results.gmail = { ok: true, user };
  } catch (err) {
    results.gmail = { ok: false, error: err.message };
  }

  const allOk = Object.values(results).every(r => r.ok);
  res.status(allOk ? 200 : 500).json(results);
});

module.exports = app;
