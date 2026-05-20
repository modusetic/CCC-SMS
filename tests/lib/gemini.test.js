const mockSendMessage = jest.fn();
const mockStartChat = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockGetGenerativeModel = jest.fn(() => ({ startChat: mockStartChat }));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(() => ({
    getGenerativeModel: mockGetGenerativeModel
  }))
}));

process.env.GEMINI_API_KEY = 'test-api-key';

const { getNextReply } = require('../../lib/gemini');

const mockThread = {
  organizerName: 'Alice',
  contactName: 'Bob',
  conversationHistory: [
    { role: 'model', content: 'Hi Bob! Available: Monday at 2pm. Which works?' },
    { role: 'user', content: 'Monday works for me!' }
  ]
};

describe('getNextReply', () => {
  it('initializes model with gemini-1.5-flash and system prompt containing organizer name', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Great, confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-1.5-flash',
        systemInstruction: expect.stringContaining('Alice')
      })
    );
  });

  it('passes history to startChat starting from first user turn, dropping leading model entries', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    // Leading 'model' entry stripped — Gemini requires history to begin with 'user'
    expect(mockStartChat).toHaveBeenCalledWith({
      history: [
        { role: 'user', parts: [{ text: 'Monday works for me!' }] }
      ]
    });
  });

  it('sends the incoming message via sendMessage', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    expect(mockSendMessage).toHaveBeenCalledWith('Monday works!');
  });

  it('returns the text response from Gemini', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Sounds great!' } });
    const reply = await getNextReply(mockThread, 'Monday at 2pm');
    expect(reply).toBe('Sounds great!');
  });
});
