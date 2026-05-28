const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function extractJson(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : text.trim();
}

function buildSystemPrompt(organizerName, contactName, directorAlternatives = [], timezone) {
  const tz = timezone || process.env.TIMEZONE || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD in local tz
  const backupSection = directorAlternatives.length > 0
    ? ` The organizer has pre-approved these backup times: ${directorAlternatives.join(', ')}. Offer them if the contact declines the primary options.`
    : '';

  return `You are a friendly scheduling assistant named Alex working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under 160 characters. Be conversational and polite. Today's date is ${today} (timezone: ${tz}).${backupSection}

When the contact confirms one of the proposed or backup times, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}

If the contact proposes a completely different time (not one of the proposed or backup times), respond ONLY with this exact JSON and nothing else: {"status":"counter-proposal","suggestedTime":"<their suggestion in plain English>","suggestedDatetime":"YYYY-MM-DDTHH:mm:ss","reply":"<friendly message under 160 chars saying you will check with ${organizerName} and get back to them>"}

If they decline without proposing an alternative, suggest up to 2 options from the backup times (if any) or two new times at different times of day. After no more than 6 exchanges with no agreement, send a final message saying you will follow up another time.`;
}

async function getNextReply(thread, incomingMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildSystemPrompt(thread.organizerName, thread.contactName, thread.directorAlternatives, thread.timezone)
  });

  const mapped = thread.conversationHistory.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));
  // Gemini requires history to start with 'user' — drop any leading 'model' entries
  const firstUser = mapped.findIndex(m => m.role === 'user');
  const history = firstUser === -1 ? [] : mapped.slice(firstUser);

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(incomingMessage);
  return result.response.text();
}

// One-shot call: organizer has responded to the initial scheduling request.
// Gemini reads the full organizer message and decides what to relay to the contact —
// if the organizer approved the proposed times it asks the contact which works;
// if the organizer suggested different times it offers only those new times.
async function getOrganizerInitialContactMessage(organizerName, contactName, proposedTimes, organizerMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named Alex working on behalf of ${organizerName}. Keep all messages under 160 characters. Be warm and conversational — never robotic or template-like.`
  });

  const prompt = `${organizerName} originally proposed these times to meet with ${contactName}: ${proposedTimes.join(', ')}. The organizer just replied: "${organizerMessage}". Based on what the organizer said, write a brief, friendly SMS to ${contactName}: if the organizer approved the original times, ask which works; if the organizer suggested different or modified times, offer only those new times and ask if they work. Do not mention any times the organizer declined. Keep under 160 characters.`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

// One-shot call: organizer has replied to a contact's counter-proposal.
// Gemini reads the full organizer message and decides if it's an approval or a rejection.
// Returns { approved: boolean, contactMsg: string, organizerAck: string }
async function getOrganizerApprovalDecision(organizerName, contactName, pendingContactSuggestion, organizerMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a scheduling assistant. Analyze an organizer's reply and determine whether they are approving a proposed meeting time or declining it.`
  });

  const prompt = `${contactName} proposed this meeting time: "${pendingContactSuggestion}". ${organizerName} replied: "${organizerMessage}".

Is ${organizerName} approving this specific time, or are they declining or suggesting something different?

Reply ONLY with this JSON (no markdown, no other text):
{"approved":true or false,"contactMsg":"<friendly SMS under 160 chars to ${contactName}>","organizerAck":"<friendly SMS under 160 chars acknowledging ${organizerName}>"}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    return JSON.parse(extractJson(text));
  } catch (_) {
    return {
      approved: false,
      contactMsg: `${organizerName} has an update on our scheduling — I'll be in touch shortly.`,
      organizerAck: `Got it! I'll follow up with ${contactName}.`
    };
  }
}

// One-shot call: organizer has sent an unsolicited availability update.
// Generate a polished message to the contact asking if the new time works.
async function getOrganizerUpdateReply(organizerName, contactName, organizerMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named Alex working on behalf of ${organizerName}. Keep all messages under 160 characters. Be conversational and polite.`
  });
  const prompt = `${organizerName} just updated their availability and said: "${organizerMessage}". Write a brief, friendly SMS to ${contactName} sharing this update and asking if the new time works for them.`;
  const result = await model.generateContent(prompt);
  return result.response.text();
}

module.exports = { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply };
