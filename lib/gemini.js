const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function extractJson(text) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : text.trim();
}

function buildSystemPrompt(organizerName, contactName, directorAlternatives = [], timezone, settings = {}, context = {}) {
  const tz = timezone || process.env.TIMEZONE || 'America/New_York';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const name   = settings.assistantName    || 'Alex';
  const tone   = settings.tone             || 'Be conversational and polite.';
  const maxLen = settings.maxMessageLength || 160;
  const maxEx  = settings.maxExchanges     || 6;
  const {
    offeredTimes = [],
    proposedTimes = [],
    directorMessages = [],
    rejectedTimes = [],
    lastContactMsg = null,
    organizerPreApprovedTime = null
  } = context;

  // Use offeredTimes when available; fall back to proposedTimes for older threads.
  const primaryTimes = offeredTimes.length > 0 ? offeredTimes : proposedTimes;

  const backupSection = directorAlternatives.length > 0
    ? ` The organizer pre-approved these backup times: ${directorAlternatives.join('; ')}. Offer them if the contact declines the primary options. IMPORTANT: If the contact accepts or agrees to any of these organizer-communicated times, return the confirmed JSON immediately — do not treat it as a counter-proposal.`
    : '';
  const offeredSection = primaryTimes.length > 0
    ? ` You have proposed these times to ${contactName}: ${primaryTimes.join(', ')}. Only offer dates/times consistent with what the organizer has communicated — do not invent new dates.`
    : '';
  const orgMsgSection = directorMessages.length > 0
    ? ` The organizer has since communicated: ${directorMessages.join('; ')}. Use these as the authoritative available times. IMPORTANT: If the contact accepts any of these, return the confirmed JSON immediately.`
    : '';
  const rejectedSection = rejectedTimes.length > 0
    ? ` These times have already been declined — do not offer them again: ${rejectedTimes.join(', ')}.`
    : '';
  const sentSection = lastContactMsg
    ? ` Your most recent message to ${contactName} was: "${lastContactMsg}". Stay consistent with this.`
    : '';
  const preApprovedSection = organizerPreApprovedTime
    ? ` The organizer has already explicitly confirmed availability for exactly this time: ${organizerPreApprovedTime}. If the contact agrees to this exact time, add "matchesOrganizerPreApproval":true to your confirmed-status JSON response.`
    : '';

  return `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under ${maxLen} characters. ${tone} Today's date is ${today} (timezone: ${tz}).${backupSection}${offeredSection}${orgMsgSection}${rejectedSection}${sentSection}${preApprovedSection}

When the contact confirms one of the proposed or organizer-communicated times, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}
Critical: the datetime field must be the actual agreed date from the conversation — never today's date (${today}) unless the meeting is literally today.

If the contact proposes a completely different time (not one of the proposed or organizer-communicated times), respond ONLY with this exact JSON and nothing else: {"status":"counter-proposal","suggestedTime":"<their suggestion in plain English>","suggestedDatetime":"YYYY-MM-DDTHH:mm:ss","reply":"<friendly message under ${maxLen} chars saying you will check with ${organizerName} and get back to them>"}

If they decline without proposing an alternative, suggest up to 2 options from the organizer-communicated times (if any) or two new times at different times of day. After no more than ${maxEx} exchanges with no agreement, send a final message saying you will follow up another time.`;
}

async function getNextReply(thread, incomingMessage, settings = {}) {
  const modelMsgs = (thread.conversationHistory || []).filter(m => m.role === 'model');
  const lastContactMsg = modelMsgs.length > 0 ? modelMsgs[modelMsgs.length - 1].content : null;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: buildSystemPrompt(
      thread.organizerName, thread.contactName,
      thread.directorAlternatives, thread.timezone, settings,
      {
        offeredTimes: thread.offeredTimes || [],
        proposedTimes: thread.proposedTimes || [],
        directorMessages: thread.directorMessages || [],
        rejectedTimes: thread.rejectedTimes || [],
        lastContactMsg,
        organizerPreApprovedTime: thread.organizerPreApprovedTime || null
      }
    )
  });

  const mapped = (thread.conversationHistory || []).map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));

  // Gemini requires strictly alternating user/model turns in history.
  // Organizer-side events (unsolicited updates, counter-rejections) can add
  // consecutive model entries to conversationHistory for display purposes.
  // Merge them here so Gemini never sees non-alternating roles.
  const deduped = [];
  for (const msg of mapped) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.role === 'model' && msg.role === 'model') {
      prev.parts[0].text += '\n' + msg.parts[0].text;
    } else {
      deduped.push(msg);
    }
  }

  const firstUser = deduped.findIndex(m => m.role === 'user');
  const history = firstUser === -1 ? [] : deduped.slice(firstUser);

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(incomingMessage);
  return result.response.text();
}

async function getOrganizerInitialContactMessage(organizerName, contactName, proposedTimes, organizerMessage, settings = {}) {
  const name   = settings.assistantName    || 'Alex';
  const maxLen = settings.maxMessageLength || 160;
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Keep all messages under ${maxLen} characters. Be warm and conversational — never robotic or template-like.`
  });

  const prompt = `${organizerName} originally proposed these times to meet with ${contactName}: ${proposedTimes.join(', ')}. The organizer just replied: "${organizerMessage}".

Based on what the organizer said, write a brief, friendly SMS to ${contactName}: if the organizer approved the original times, ask which works; if the organizer suggested different or modified times, offer only those new times and ask if they work. Do not mention any times the organizer declined. Keep under ${maxLen} characters.

Reply ONLY with this JSON (no markdown, no other text): {"contactMessage":"<the SMS text>","exactApprovedTime":"<the single specific time the organizer unambiguously approved, in plain English, or null if they gave multiple options, a range, or anything vague>"}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    const parsed = JSON.parse(extractJson(text));
    return { contactMessage: parsed.contactMessage, exactApprovedTime: parsed.exactApprovedTime || null };
  } catch (_) {
    return { contactMessage: text, exactApprovedTime: null };
  }
}

async function getOrganizerApprovalDecision(organizerName, contactName, pendingContactSuggestion, organizerMessage, settings = {}, context = {}) {
  const maxLen = settings.maxMessageLength || 160;
  const { directorAlternatives = [], directorMessages = [] } = context;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a scheduling assistant. Analyze an organizer's reply and determine whether they are approving a proposed meeting time or declining it.`
  });

  const allOrganizerContext = [...directorAlternatives, ...directorMessages];
  const altSection = allOrganizerContext.length > 0
    ? `\nOther times the organizer has indicated as available: ${allOrganizerContext.join('; ')}.`
    : '';

  const prompt = `${contactName} proposed this meeting time: "${pendingContactSuggestion}". ${organizerName} replied: "${organizerMessage}".${altSection}

Is ${organizerName} approving this specific time, or are they declining or suggesting something different?

Reply ONLY with this JSON (no markdown, no other text):
{"approved":true or false,"contactMsg":"<friendly SMS under ${maxLen} chars to ${contactName}; if approved, state the confirmed time '${pendingContactSuggestion}'; if declined, share what the organizer offered instead>","organizerAck":"<friendly SMS under ${maxLen} chars to ${organizerName}; if approved, state the confirmed time; if declined, acknowledge their availability>"}`;

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

async function getOrganizerUpdateReply(organizerName, contactName, organizerMessage, settings = {}, context = {}) {
  const name   = settings.assistantName    || 'Alex';
  const maxLen = settings.maxMessageLength || 160;
  const {
    offeredTimes = [],
    directorMessages = [],
    rejectedTimes = [],
    lastContactMsg = null
  } = context;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: `You are a friendly scheduling assistant named ${name} working on behalf of ${organizerName}. Keep all messages under ${maxLen} characters. Be conversational and polite.`
  });

  const contextLines = [];
  if (offeredTimes.length > 0) contextLines.push(`Originally offered times: ${offeredTimes.join(', ')}.`);
  if (directorMessages.length > 0) contextLines.push(`The organizer has previously communicated: ${directorMessages.join('; ')}.`);
  if (rejectedTimes.length > 0) contextLines.push(`Times already declined: ${rejectedTimes.join(', ')} — do not offer these.`);
  if (lastContactMsg) contextLines.push(`The last message sent to ${contactName} was: "${lastContactMsg}".`);
  const contextBlock = contextLines.length > 0 ? '\n' + contextLines.join('\n') : '';

  const prompt = `${organizerName} just updated their availability: "${organizerMessage}".${contextBlock}

Write a brief, friendly SMS to ${contactName} sharing this updated availability and asking if the new time works. Under ${maxLen} characters.

Reply ONLY with this JSON (no markdown, no other text): {"contactMessage":"<the SMS text>","exactApprovedTime":"<the single specific time the organizer unambiguously approved, in plain English, or null if they gave multiple options, a range, or anything vague>"}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  try {
    const parsed = JSON.parse(extractJson(text));
    return { contactMessage: parsed.contactMessage, exactApprovedTime: parsed.exactApprovedTime || null };
  } catch (_) {
    return { contactMessage: text, exactApprovedTime: null };
  }
}

module.exports = { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply };
