const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const SETTINGS_KEY = 'global:settings';

const DEFAULTS = {
  assistantName: 'Alex',
  tone: 'Be conversational and polite.',
  maxMessageLength: 160,
  maxExchanges: 6,
  holdingMessage: "Thanks for reaching out! We'll be in touch soon to confirm your appointment.",
  confirmationMessage: "Your meeting with {organizerName} is confirmed for {confirmedDatetime}! You'll receive details soon.",
  demoMode: false,
  autoConfirmPreApprovedTimes: true
};

const RULES = {
  assistantName:       { type: 'string',  min: 1,  max: 40  },
  tone:                { type: 'string',  min: 1,  max: 300 },
  maxMessageLength:    { type: 'integer', min: 50, max: 320 },
  maxExchanges:        { type: 'integer', min: 2,  max: 20  },
  holdingMessage:      { type: 'string',  min: 1,  max: 320 },
  confirmationMessage: { type: 'string',  min: 1,  max: 320 },
  demoMode:            { type: 'boolean' },
  autoConfirmPreApprovedTimes: { type: 'boolean' }
};

function validate(obj) {
  for (const [key, rule] of Object.entries(RULES)) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (rule.type === 'string') {
      if (typeof v !== 'string') return `${key} must be a string`;
      if (v.length < rule.min) return `${key} must be at least ${rule.min} character`;
      if (v.length > rule.max) return `${key} must be at most ${rule.max} characters`;
    } else if (rule.type === 'boolean') {
      if (typeof v !== 'boolean') return `${key} must be a boolean`;
    } else {
      if (!Number.isInteger(v)) return `${key} must be an integer`;
      if (v < rule.min) return `${key} must be at least ${rule.min}`;
      if (v > rule.max) return `${key} must be at most ${rule.max}`;
    }
  }
  return null;
}

async function getSettings() {
  const stored = await redis.get(SETTINGS_KEY);
  const raw = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, raw[k]]));
}

async function saveSettings(partial) {
  const cleaned = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key in partial) cleaned[key] = partial[key];
  }
  const error = validate(cleaned);
  if (error) {
    const err = new Error(error);
    err.isValidation = true;
    throw err;
  }
  const current = await redis.get(SETTINGS_KEY);
  const currentClean = (current && typeof current === 'object') ? Object.fromEntries(Object.keys(DEFAULTS).filter(k => k in current).map(k => [k, current[k]])) : {};
  const merged = { ...DEFAULTS, ...currentClean, ...cleaned };
  await redis.set(SETTINGS_KEY, merged);
  return merged;
}

module.exports = { getSettings, saveSettings, DEFAULTS };
