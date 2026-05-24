const mockSendMessage = jest.fn();
const mockStartChat = jest.fn(() => ({ sendMessage: mockSendMessage }));
const mockGenerateContent = jest.fn();
const mockGetGenerativeModel = jest.fn(() => ({
  startChat: mockStartChat,
  generateContent: mockGenerateContent
}));

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn(() => ({
    getGenerativeModel: mockGetGenerativeModel
  }))
}));

process.env.GEMINI_API_KEY = 'test-api-key';

const { getNextReply, getOrganizerInitialContactMessage, getOrganizerUpdateReply } = require('../../lib/gemini');

const mockThread = {
  organizerName: 'Alice',
  contactName: 'Bob',
  directorAlternatives: [],
  conversationHistory: [
    { role: 'model', content: 'Hi Bob! Available: Monday at 2pm. Which works?' },
    { role: 'user', content: 'Monday works for me!' }
  ]
};

describe('getNextReply', () => {
  it('initializes model with gemini-2.5-flash and system prompt containing organizer name', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Great, confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        systemInstruction: expect.stringContaining('Alice')
      })
    );
  });

  it('includes director alternatives in system prompt when provided', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    const threadWithAlts = { ...mockThread, directorAlternatives: ['Tuesday at 3pm', 'Thursday at 10am'] };
    await getNextReply(threadWithAlts, 'Monday works!');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining('Tuesday at 3pm')
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

describe('getOrganizerInitialContactMessage', () => {
  it('uses approved prompt when isApproval is true', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => "Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday. Which works?" } });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday at 2pm', 'Tuesday at 10am'], 'Yes', true);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('Monday at 2pm');
    expect(call).not.toContain('Yes'); // raw approval word should not appear in prompt
  });

  it('uses alternative prompt when isApproval is false', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => "Hi Bob! Alice can do 3pm instead — does that work?" } });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['1pm'], "I can't at 1pm, but 3pm works", false);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain("I can't at 1pm, but 3pm works");
  });

  it('returns the generated reply', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => "Hi Bob! Ready to schedule with Alice?" } });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday'], 'Yes', true);
    expect(reply).toBe("Hi Bob! Ready to schedule with Alice?");
  });
});

describe('getOrganizerUpdateReply', () => {
  it('calls generateContent with organizer update context', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => "Hi Bob! Alice can do 3pm instead. Does that work?" } });
    await getOrganizerUpdateReply('Alice', 'Bob', "I can't at 1pm, but 3pm works");
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("I can't at 1pm, but 3pm works")
    );
  });

  it('returns the Gemini-generated message', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => "Hi Bob! Alice can do 3pm instead. Does that work?" } });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', "3pm works instead");
    expect(reply).toBe("Hi Bob! Alice can do 3pm instead. Does that work?");
  });

  it('uses gemini-2.5-flash with organizer name in system instruction', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Hi!' } });
    await getOrganizerUpdateReply('Alice', 'Bob', 'Try 4pm');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        systemInstruction: expect.stringContaining('Alice')
      })
    );
  });
});
