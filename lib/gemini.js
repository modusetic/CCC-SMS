const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function buildSystemPrompt(organizerName, contactName) {
  return `You are a friendly scheduling assistant named Alex working on behalf of ${organizerName}. Your job is to find a meeting time that works for ${contactName} via SMS. Keep all messages under 160 characters. Be conversational and polite. If the contact proposes an alternative time, accept it gracefully. If they decline without proposing an alternative, suggest two new options at different times of day. After no more than 6 exchanges, if no time is agreed, send a final message saying you will follow up another time. When a specific time is confirmed by the contact, respond ONLY with this exact JSON and nothing else: {"status":"confirmed","datetime":"YYYY-MM-DDTHH:mm:ss"}`;
}

async function getNextReply(thread, incomingMessage) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: buildSystemPrompt(thread.organizerName, thread.contactName)
  });

  const history = thread.conversationHistory.map(msg => ({
    role: msg.role,
    parts: [{ text: msg.content }]
  }));

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(incomingMessage);
  return result.response.text();
}

module.exports = { getNextReply };
