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

const { getNextReply, getOrganizerInitialContactMessage, getOrganizerApprovalDecision, getOrganizerUpdateReply } = require('../../lib/gemini');

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

  it('includes proposedTimes in system prompt as fallback when offeredTimes is absent', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    const threadWithTimes = { ...mockThread, proposedTimes: ['Friday June 6 at 6pm', 'Saturday June 7 at 10am'] };
    await getNextReply(threadWithTimes, 'Neither works');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining('Friday June 6 at 6pm')
      })
    );
  });

  it('uses offeredTimes in system prompt (takes priority over proposedTimes)', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    const threadWithOffered = {
      ...mockThread,
      proposedTimes: ['Tuesday at 9am'],
      offeredTimes: ['Wednesday at 4pm', 'Thursday at 11am']
    };
    await getNextReply(threadWithOffered, 'Neither works');
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Wednesday at 4pm');
    expect(systemInstruction).not.toContain('Tuesday at 9am');
  });

  it('includes directorMessages in system prompt when provided', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    const threadWithOrgMsgs = { ...mockThread, directorMessages: ['Try Tuesday at 3pm instead'] };
    await getNextReply(threadWithOrgMsgs, 'Monday does not work');
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Try Tuesday at 3pm instead');
  });

  it('includes rejectedTimes in system prompt when provided', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    const threadWithRejected = { ...mockThread, rejectedTimes: ['Wednesday at 10am', 'Friday at 5pm'] };
    await getNextReply(threadWithRejected, 'Any other times?');
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Wednesday at 10am');
    expect(systemInstruction).toContain('Friday at 5pm');
  });

  it('includes last model message as context in system prompt', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        systemInstruction: expect.stringContaining('Hi Bob! Available: Monday at 2pm. Which works?')
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

  it('merges consecutive model messages in history so Gemini never sees non-alternating roles', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Great!' } });
    const threadWithConsecutiveModel = {
      ...mockThread,
      conversationHistory: [
        { role: 'model', content: 'First message' },
        { role: 'user', content: 'User reply' },
        { role: 'model', content: 'AI holding response' },
        { role: 'model', content: 'Organizer update forwarded to contact' }
      ]
    };
    await getNextReply(threadWithConsecutiveModel, 'New contact message');
    expect(mockStartChat).toHaveBeenCalledWith({
      history: [
        { role: 'user', parts: [{ text: 'User reply' }] },
        { role: 'model', parts: [{ text: 'AI holding response\nOrganizer update forwarded to contact' }] }
      ]
    });
  });

  it('returns the text response from Gemini', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Sounds great!' } });
    const reply = await getNextReply(mockThread, 'Monday at 2pm');
    expect(reply).toBe('Sounds great!');
  });

  it('includes organizerPreApprovedTime in system prompt when set on the thread', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    const threadWithPreApproval = { ...mockThread, organizerPreApprovedTime: '4:30 PM' };
    await getNextReply(threadWithPreApproval, '4:30 works!');
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('4:30 PM');
    expect(systemInstruction).toContain('matchesOrganizerPreApproval');
  });

  it('omits matchesOrganizerPreApproval instructions when organizerPreApprovedTime is not set', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'Confirmed!' } });
    await getNextReply(mockThread, 'Monday works!');
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).not.toContain('matchesOrganizerPreApproval');
  });
});

describe('getOrganizerInitialContactMessage', () => {
  it('includes the original proposed times in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hey Bob! Alice wants to meet — Monday at 2pm or Tuesday. Which works?","exactApprovedTime":null}' }
    });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday at 2pm', 'Tuesday at 10am'], 'Sounds good, go ahead');
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('Monday at 2pm');
    expect(call).toContain('Tuesday at 10am');
  });

  it('includes the full organizer message in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead — does that work?","exactApprovedTime":"3pm"}' }
    });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['1pm'], "I can't at 1pm, but 3pm works");
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain("I can't at 1pm, but 3pm works");
  });

  it('returns the generated contactMessage', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Ready to schedule with Alice?","exactApprovedTime":null}' }
    });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday'], 'Yes please');
    expect(reply.contactMessage).toBe("Hi Bob! Ready to schedule with Alice?");
  });

  it('returns exactApprovedTime when the organizer named exactly one specific time', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! 4:30 PM works for Alice — does that work for you too?","exactApprovedTime":"4:30 PM"}' }
    });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['4:30 PM'], 'Yes, 4:30 works');
    expect(reply.exactApprovedTime).toBe('4:30 PM');
  });

  it('returns null exactApprovedTime when the organizer approved multiple times', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Both Monday 2pm and Tuesday 10am work for Alice — which works for you?","exactApprovedTime":null}' }
    });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday at 2pm', 'Tuesday at 10am'], 'Both work');
    expect(reply.exactApprovedTime).toBeNull();
  });

  it('falls back to raw text as contactMessage with null exactApprovedTime when Gemini returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Sorry, I cannot help with that.' } });
    const reply = await getOrganizerInitialContactMessage('Alice', 'Bob', ['Monday'], 'Yes please');
    expect(reply.contactMessage).toBe('Sorry, I cannot help with that.');
    expect(reply.exactApprovedTime).toBeNull();
  });
});

describe('getOrganizerApprovalDecision', () => {
  it('returns parsed JSON from Gemini', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"approved":true,"contactMsg":"Great, confirmed!","organizerAck":"Confirmed!"}' }
    });
    const result = await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday at 2pm', 'Yes that works');
    expect(result.approved).toBe(true);
    expect(result.contactMsg).toBe('Great, confirmed!');
    expect(result.organizerAck).toBe('Confirmed!');
  });

  it('returns approved:false when organizer declines', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"approved":false,"contactMsg":"Alice suggests Monday instead.","organizerAck":"Got it!"}' }
    });
    const result = await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday at 2pm', "Friday doesn't work, try Monday");
    expect(result.approved).toBe(false);
  });

  it('falls back to approved:false when Gemini returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Sorry, I cannot help with that.' } });
    const result = await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday at 2pm', 'some reply');
    expect(result.approved).toBe(false);
    expect(result.contactMsg).toBeDefined();
    expect(result.organizerAck).toBeDefined();
  });

  it('strips ```json markdown before parsing', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '```json\n{"approved":true,"contactMsg":"Confirmed!","organizerAck":"Great!"}\n```' }
    });
    const result = await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday at 2pm', 'Yes');
    expect(result.approved).toBe(true);
  });

  it('includes organizer name, contact name, and pending time in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"approved":true,"contactMsg":"Confirmed!","organizerAck":"Great!"}' }
    });
    await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday at 2pm', 'Yes');
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('Alice');
    expect(call).toContain('Bob');
    expect(call).toContain('Friday at 2pm');
  });

  it('includes directorAlternatives in the prompt when provided via context', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"approved":false,"contactMsg":"Try Monday.","organizerAck":"Got it."}' }
    });
    await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday at 2pm', "Can't do Friday", {}, {
      directorAlternatives: ['Monday at 3pm', 'Tuesday at 11am']
    });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('Monday at 3pm');
    expect(call).toContain('Tuesday at 11am');
  });
});

describe('getOrganizerUpdateReply', () => {
  it('calls generateContent with organizer update context', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead. Does that work?","exactApprovedTime":"3pm"}' }
    });
    await getOrganizerUpdateReply('Alice', 'Bob', "I can't at 1pm, but 3pm works");
    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.stringContaining("I can't at 1pm, but 3pm works")
    );
  });

  it('returns the Gemini-generated contactMessage', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead. Does that work?","exactApprovedTime":"3pm"}' }
    });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', "3pm works instead");
    expect(reply.contactMessage).toBe("Hi Bob! Alice can do 3pm instead. Does that work?");
  });

  it('returns exactApprovedTime when the organizer named exactly one specific time', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice can do 3pm instead. Does that work?","exactApprovedTime":"3pm"}' }
    });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', '3pm works instead');
    expect(reply.exactApprovedTime).toBe('3pm');
  });

  it('returns null exactApprovedTime when the update is vague', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => '{"contactMessage":"Hi Bob! Alice has some new availability — want to hear the options?","exactApprovedTime":null}' }
    });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', "I'm generally free most afternoons");
    expect(reply.exactApprovedTime).toBeNull();
  });

  it('falls back to raw text as contactMessage with null exactApprovedTime when Gemini returns invalid JSON', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Not JSON at all' } });
    const reply = await getOrganizerUpdateReply('Alice', 'Bob', 'Try 4pm');
    expect(reply.contactMessage).toBe('Not JSON at all');
    expect(reply.exactApprovedTime).toBeNull();
  });

  it('uses gemini-2.5-flash with organizer name in system instruction', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '{"contactMessage":"Hi!","exactApprovedTime":null}' } });
    await getOrganizerUpdateReply('Alice', 'Bob', 'Try 4pm');
    expect(mockGetGenerativeModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.5-flash',
        systemInstruction: expect.stringContaining('Alice')
      })
    );
  });

  it('includes offeredTimes, directorMessages, and lastContactMsg from context in the prompt', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '{"contactMessage":"Hi Bob!","exactApprovedTime":null}' } });
    await getOrganizerUpdateReply('Alice', 'Bob', 'Try 4pm', {}, {
      offeredTimes: ['Monday at 2pm', 'Tuesday at 10am'],
      directorMessages: ['Wednesday at 3pm'],
      rejectedTimes: ['Thursday at 5pm'],
      lastContactMsg: 'None of those work for me'
    });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('Monday at 2pm');
    expect(call).toContain('Wednesday at 3pm');
    expect(call).toContain('Thursday at 5pm');
    expect(call).toContain('None of those work for me');
  });
});

describe('settings values used in prompts', () => {
  beforeEach(() => mockGetGenerativeModel.mockClear());

  it('buildSystemPrompt uses assistantName from settings', async () => {
    mockSendMessage.mockResolvedValue({ response: { text: () => 'ok' } });
    const threadWithTz = { ...mockThread, timezone: 'America/Chicago' };
    await getNextReply(threadWithTz, 'hello', { assistantName: 'Sam', tone: 'Be terse.', maxMessageLength: 120, maxExchanges: 4 });
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Sam');
    expect(systemInstruction).toContain('Be terse.');
    expect(systemInstruction).toContain('120');
    expect(systemInstruction).toContain('4');
  });

  it('getOrganizerInitialContactMessage uses assistantName and maxMessageLength', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Hi!' } });
    await getOrganizerInitialContactMessage('Alice', 'Bob', ['Mon'], 'Approve', { assistantName: 'Sam', maxMessageLength: 100 });
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Sam');
    expect(systemInstruction).toContain('100');
  });

  it('getOrganizerUpdateReply uses assistantName and maxMessageLength', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => 'Hi!' } });
    await getOrganizerUpdateReply('Alice', 'Bob', 'Try 3pm', { assistantName: 'Sam', maxMessageLength: 100 });
    const { systemInstruction } = mockGetGenerativeModel.mock.calls[0][0];
    expect(systemInstruction).toContain('Sam');
    expect(systemInstruction).toContain('100');
  });

  it('getOrganizerApprovalDecision uses maxMessageLength in prompt', async () => {
    mockGenerateContent.mockResolvedValue({ response: { text: () => '{"approved":true,"contactMsg":"ok","organizerAck":"ok"}' } });
    await getOrganizerApprovalDecision('Alice', 'Bob', 'Friday 2pm', 'Yes', { maxMessageLength: 80 });
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call).toContain('80');
  });
});
