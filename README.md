# SMS Scheduling Automation

AI-powered SMS scheduling: sends proposed meeting times via text, negotiates back and forth using Gemini 1.5 Flash, books the confirmed time in Google Calendar, and emails the organizer.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/initiate` | Start a scheduling thread for a contact |
| POST | `/api/sms-reply` | Twilio webhook for inbound SMS replies |
| GET | `/api/health` | Uptime check |

## Prerequisites

- Node.js 18+
- Vercel CLI: `npm i -g vercel`
- Twilio account with a phone number
- Google Cloud project with Calendar API enabled
- Gmail account with an App Password
- Upstash Redis (added via Vercel Marketplace — free tier available)

## Environment Variables

The full list of required variables:

| Variable | Source |
|----------|--------|
| `TWILIO_ACCOUNT_SID` | Twilio Console |
| `TWILIO_AUTH_TOKEN` | Twilio Console |
| `TWILIO_PHONE_NUMBER` | Twilio Console |
| `GEMINI_API_KEY` | Google AI Studio |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud (minified JSON) |
| `GOOGLE_CALENDAR_ID` | Google Calendar settings |
| `GMAIL_USER` | Your Gmail address |
| `GMAIL_APP_PASSWORD` | Google Account → App Passwords |
| `KV_REST_API_URL` | Auto-injected by Vercel Upstash integration |
| `KV_REST_API_TOKEN` | Auto-injected by Vercel Upstash integration |
| `DEBUG_TOKEN` | Generate a long random value, e.g. `openssl rand -hex 32` |

For local development, copy `.env.example` to `.env.local` and fill in each value:

```bash
cp .env.example .env.local
```

### Twilio Setup

1. Create a Twilio account at twilio.com
2. Buy a phone number with SMS capability
3. Copy Account SID and Auth Token from the Twilio Console
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
5. After deploying, set the webhook in Twilio Console → Phone Numbers → Your Number → Messaging → Webhook URL (HTTP POST): `https://your-project.vercel.app/api/sms-reply`

### Google Service Account Setup

1. Go to Google Cloud Console → APIs & Services → Enable **Google Calendar API**
2. Go to IAM & Admin → Service Accounts → Create Service Account (no roles needed)
3. Create a JSON key and download it
4. Minify the JSON to a single line: `jq -c . credentials.json`
5. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the minified JSON string
6. Open Google Calendar → Settings → your target calendar → Share with specific people
7. Add the service account email with **Make changes to events** permission
8. Set `GOOGLE_CALENDAR_ID` to the calendar ID (found in Settings → Integrate calendar)

### Gmail App Password Setup

1. Enable 2-Step Verification on your Google account
2. Go to Google Account → Security → 2-Step Verification → App passwords
3. Create an App Password for "Mail" / "Other (custom name)"
4. Set `GMAIL_USER` (your Gmail address) and `GMAIL_APP_PASSWORD` (the 16-character password)

### Upstash Redis Setup

This app uses Upstash Redis (via the `@upstash/redis` package) for conversation state.

**On Vercel (recommended):**
1. Go to your Vercel project → **Integrations** tab
2. Search for **Upstash Redis** in the Marketplace and add it
3. Vercel automatically injects `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and related vars — no manual copy needed

**For local development:**
1. After adding the integration, copy the values from Vercel → Settings → Environment Variables into your `.env.local`

### Gemini API Key

1. Go to Google AI Studio (aistudio.google.com)
2. Create an API key (free tier is sufficient)
3. Set `GEMINI_API_KEY`

## Security

- **`DEBUG_TOKEN` is required.** It gates `/api/conversation`, `/api/settings`, `/api/debug-thread`, and `/api/test-credentials` — all of these expose PII (names, phone numbers, conversation content) or let you change AI/SMS behavior. Without it set, those endpoints reject every request (fail-closed).
- The operator UI (`public/index.html`) will prompt you for this token the first time it needs to call one of those endpoints, and caches it in `sessionStorage` for the rest of the browser tab session — it's never written to disk.
- Pass the token as the `x-debug-token` header, or `?token=` on `/api/debug-thread` and `/api/test-credentials` for quick manual checks in a browser URL bar.
- `/api/sms-reply` (the Twilio webhook) verifies the `X-Twilio-Signature` header on every request using `TWILIO_AUTH_TOKEN`, so only genuine Twilio requests can drive a scheduling thread. The one exception is the UI's demo-mode reply simulator, which is only accepted when `demoMode` is enabled in settings **and** a valid `DEBUG_TOKEN` is presented.
- `/api/initiate` has no auth — it's meant to be called by trusted internal systems (or the operator UI). Put it behind your own network/API-gateway controls if it will be reachable from an untrusted network.

## Local Development with ngrok

1. Start the local dev server: `vercel dev`
2. In a second terminal, expose it: `ngrok http 3000`
3. Copy the ngrok HTTPS URL (e.g., `https://abc123.ngrok.io`)
4. In Twilio Console, set the webhook to: `https://abc123.ngrok.io/api/sms-reply`

## Deploy to Production

1. Push to GitHub (already done if you cloned this repo)
2. Import the repo in the Vercel dashboard and add all environment variables
3. Deploy:

```bash
vercel --prod
```

4. Update your Twilio webhook to the Vercel production URL after deploying

## Testing the Flow

**1. Trigger a scheduling request:**

```bash
curl -X POST https://your-project.vercel.app/api/initiate \
  -H "Content-Type: application/json" \
  -d '{
    "contactName": "Bob",
    "contactPhone": "+15551234567",
    "organizerName": "Alice",
    "organizerEmail": "alice@example.com",
    "proposedTimes": ["Monday May 12 at 2pm", "Wednesday May 14 at 10am"]
  }'
```

**2.** Bob receives the SMS and replies from his phone.

**3.** The AI (Alex) negotiates back and forth until a time is confirmed.

**4.** Google Calendar event is automatically created and Alice receives an email notification.

## Running Tests

```bash
npm test
```
