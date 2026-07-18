// Shared secrets used across test files that exercise the real (unmocked)
// lib/auth.js and lib/twilio.js signature-verification logic.
process.env.DEBUG_TOKEN = process.env.DEBUG_TOKEN || 'test-debug-token';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test-twilio-auth-token';
