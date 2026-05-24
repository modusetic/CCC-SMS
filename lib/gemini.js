const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function buildSystemPrompt(organizerName, contactName, directorAlternatives = []) {
  const today = new Date().toISOString().split('T')[0];
  const backupSection = directorAlternatives.length > 0
    ? ` The organizer has pre-approved these backup times: ${directorAlternatives.join(', ')}. Offer them if the contact declines the primary options.`
    : '';

  return `You are a friendly scheduling assistant named Alex working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under 160 characters. Be conversational and polite. Today's date is ${today}.${backupSection}

When the contact confirms one of the proposed or backup times, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}

If the contact proposes a completely different time (not one of the proposed or backup times), respond ONLY with this exact JSON and nothing else: {"status":"counter-proposal","suggestedTime":"<their suggestion in plain English>","suggestedDatetime":"YYYY-MM-DDTHH:mm:ss","reply":"<friendly message under 160 chars saying you will check with ${organizerName} and get back to them>"}

If they decline without proposing an alternative, suggest up to 2 options from the backup times (if any) or two new times at different times of day. After no more than 6 exchanges with no agreement, send a final message saying you will follow up another time.`;
}

async function getNextReply(thread, incomingMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildSystemPrompt(thread.organizerName, thread.contactName, thread.directorAlternatives)
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

// One-shot call: organizer has completed their initial review.
// approved=true  → organizer said yes; offer proposedTimes to the contact.
// approved=false → organizer provided different times; relay those naturally.
async function getOrganizerInitialContactMessage(organizerName, contactName, proposedTimes, organizerMessage, approved) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named Alex working on behalf of ${organizerName}. Keep messages under 160 characters. Be warm and conversational — never robotic or template-like.`
  });

  const prompt = approved
    ? `Write a brief, friendly SMS to ${contactName} letting them know ${organizerName} wants to meet and asking which of these times works: ${proposedTimes.join(', ')}.`
    : `${organizerName} replied about their availability: "${organizerMessage}". Write a brief, friendly SMS to ${contactName} conveying this and asking what works for them. Do not quote the original message word-for-word — rephrase it naturally.`;

  const result = await model.generateContent(prompt);
  return result.response.text();
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

module.exports = { getNextReply, getOrganizerInitialContactMessage, getOrganizerUpdateReply };
