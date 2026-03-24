
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

// --- TYPES ---
export type BackendType = 'GEMINI' | 'OLLAMA' | 'SIMULATION';

export const AVAILABLE_GEMINI_MODELS = [
    { id: 'gemini-flash-lite-latest', label: 'Flash Lite (Fast)' },
    { id: 'gemini-2.5-flash', label: 'Flash 2.5 (Balanced)' },
    { id: 'gemini-3-pro-preview', label: 'Pro 3 (Smartest)' },
];

// --- CIRCUIT BREAKER STATE ---
let isGlobalRateLimited = false;
const RATE_LIMIT_COOLDOWN = 60000; // 1 minute cooldown

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to trip the breaker
const handleRateLimit = () => {
    if (!isGlobalRateLimited) {
        console.warn(`[Circuit Breaker] Rate limit hit. Switching to fallbacks.`);
        isGlobalRateLimited = true;
        setTimeout(() => {
            isGlobalRateLimited = false;
            console.log("[Circuit Breaker] Cooldown expired. Retrying live API.");
        }, RATE_LIMIT_COOLDOWN);
    }
};

const MOCK_RESPONSES = [
    "**[Simulation Mode]**\n\nThe Gemini API quota is exhausted and I couldn't reach a local Ollama instance.\n\nTo use a local LLM:\n1. Install Ollama\n2. Run `ollama run llama3`\n3. Start with `OLLAMA_ORIGINS=\"*\" ollama serve`\n\nFor now, you can still test the **Branching UI** and **Canvas View** with this simulated text.",
    "**[Offline Fallback]**\n\nI'm operating in offline mode. If you have **Ollama** running locally (port 11434), I can use that instead! Otherwise, feel free to explore the interface structure.",
];

const streamMockResponse = async (onChunk: (text: string) => void) => {
    const response = MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)];
    const chars = response.split('');
    let accumulated = '';
    for (let i = 0; i < chars.length; i++) {
        accumulated += chars[i];
        if (i % 3 === 0 || i === chars.length - 1) {
            onChunk(accumulated);
            await sleep(15); 
        }
    }
};

// --- OLLAMA LOCAL INTEGRATION ---

const OLLAMA_BASE_URL = 'http://localhost:11434';
let cachedOllamaModel: string | null = null;

// Auto-detect the best available local model
const getOllamaModel = async (): Promise<string> => {
    if (cachedOllamaModel) return cachedOllamaModel;
    
    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
        if (!response.ok) throw new Error('Failed to connect to Ollama');
        
        const data = await response.json();
        const models = data.models || [];
        
        if (models.length === 0) {
            console.warn("Ollama is running but no models found. Run `ollama pull llama3`");
            return 'llama3'; 
        }

        // Preference order
        const preferences = ['llama3', 'llama3.1', 'mistral', 'gemma', 'llama2'];
        
        for (const pref of preferences) {
            const found = models.find((m: any) => m.name.includes(pref));
            if (found) {
                cachedOllamaModel = found.name;
                return found.name;
            }
        }

        // Fallback to the first available model
        cachedOllamaModel = models[0].name;
        return models[0].name;

    } catch (e) {
        console.warn("Could not auto-detect Ollama model (Check CORS?). Defaulting to 'llama3'.", e);
        return 'llama3';
    }
};

const streamOllamaResponse = async (history: { role: string; content: string }[], onChunk: (text: string) => void) => {
    const modelName = await getOllamaModel();
    console.log(`[Ollama] Using model: ${modelName}`);

    // Convert 'user'/'model' to Ollama's 'user'/'assistant'
    const messages = history.map(msg => ({
        role: msg.role === 'model' ? 'assistant' : msg.role,
        content: msg.content
    }));

    try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                messages: messages,
                stream: true
            })
        });

        if (!response.ok) throw new Error(`Ollama Error: ${response.statusText}`);
        if (!response.body) throw new Error('No response body from Ollama');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            
            // Process all complete lines
            buffer = lines.pop() || ''; 
            
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    if (json.message?.content) {
                        onChunk(json.message.content);
                    }
                    if (json.done) return;
                } catch (e) {
                    // Ignore parse errors for partial chunks
                }
            }
        }
    } catch (error) {
        console.error("[Ollama Connection Failed]", error);
        throw error;
    }
};

const callOllamaAnalysis = async (prompt: string): Promise<string | null> => {
    try {
        const modelName = await getOllamaModel();
        const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                messages: [{ role: 'user', content: prompt }],
                stream: false
            })
        });
        if (!response.ok) return null;
        const json = await response.json();
        return json.message?.content || null;
    } catch (e) {
        return null;
    }
};

// --- GEMINI INTEGRATION ---

const executeGeminiStream = async (
    history: { role: string; content: string }[], 
    onChunk: (text: string) => void,
    modelIdOverride?: string
): Promise<boolean> => {
    if (!apiKey || isGlobalRateLimited) return false;

    const lastMsg = history[history.length - 1];
    const prevHistory = history.slice(0, -1).map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    // Prioritize cheaper models by default, or use override
    let modelsToTry = ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-3-pro-preview'];
    
    if (modelIdOverride) {
        // If user selected a model, put it first. 
        // We still keep others as fallback in case of rate limits on the specific model
        modelsToTry = [modelIdOverride, ...modelsToTry.filter(id => id !== modelIdOverride)];
    }

    for (const model of modelsToTry) {
        try {
          const chat = ai.chats.create({
              model: model,
              history: prevHistory,
              config: {
                  systemInstruction: "You are a helpful AI assistant. You are concise, thoughtful, and professional. Use markdown for formatting.",
              }
          });

          const result = await chat.sendMessageStream({ message: lastMsg.content });
          
          for await (const chunk of result) {
              if (chunk.text) onChunk(chunk.text);
          }
          return true; // Success

        } catch (error: any) {
          const errorMessage = error?.message || '';
          const isRateLimit = 
              error?.status === 429 || error?.status === 403 || error?.status === 503 ||
              errorMessage.includes('429') || errorMessage.includes('403') || errorMessage.includes('quota');

          if (isRateLimit) {
              console.warn(`Gemini Quota (${model})... switching to next.`);
              continue; 
          }
          // If it's a model not found error (e.g. preview expired), try next
          if (errorMessage.includes('not found') || error?.status === 404) {
              continue;
          }
          
          console.error("Gemini Error:", error);
          return false; 
        }
    }
    // If all models hit rate limit
    handleRateLimit();
    return false;
};

const executeGeminiAnalysis = async (prompt: string): Promise<string | null> => {
    if (!apiKey || isGlobalRateLimited) return null;
    
    // For analysis, prefer faster models
    const models = ['gemini-flash-lite-latest', 'gemini-2.5-flash'];

    for (const model of models) {
        try {
            const response = await ai.models.generateContent({
                model: model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            return response.text?.trim() || null;
        } catch (error) { continue; }
    }
    return null;
};


// --- MAIN SERVICE ---

export const streamResponse = async (
  history: { role: string; content: string }[],
  onChunk: (text: string) => void,
  onBackendChange?: (type: BackendType) => void,
  preferredBackend: 'GEMINI' | 'OLLAMA' = 'GEMINI',
  specificModelId?: string
) => {
  
  // Determine Execution Order based on preference
  const tryGemini = async () => {
      const success = await executeGeminiStream(history, onChunk, specificModelId);
      if (success) onBackendChange?.('GEMINI');
      return success;
  };

  const tryOllama = async () => {
      try {
          await streamOllamaResponse(history, onChunk);
          onBackendChange?.('OLLAMA');
          return true;
      } catch (e) {
          return false;
      }
  };

  const strategies = preferredBackend === 'OLLAMA' 
      ? [tryOllama, tryGemini]
      : [tryGemini, tryOllama];

  for (const strategy of strategies) {
      if (await strategy()) return;
  }

  onBackendChange?.('SIMULATION');
  await streamMockResponse(onChunk);
};

// --- TITLE VALIDATION ---
// Rejects model outputs that are sentences instead of titles (common failure mode on smaller models)
const SENTENCE_STARTERS = ['since ', 'the user', 'based on', 'it ', 'this ', 'when ', 'as the', 'given ', 'because ', 'therefore ', 'after ', 'following ', 'note:', 'output:', 'title:', 'a new ', 'here ', 'okay', 'sure', 'i '];
const GENERIC_TITLES = new Set(['new topic', 'topic change', 'different subject', 'new subject', 'general discussion', 'untitled', 'conversation', 'language query', 'new chapter', 'topic shift', 'subject change']);

const validateAndCleanTitle = (raw: string): string | null => {
    let clean = raw.trim().replace(/^"|"$/g, '').replace(/\.$/, '').trim();
    if (!clean) return null;
    if (clean.toLowerCase() === 'same') return 'SAME';

    // If model wrapped in meta-commentary like "A new chapter! Output: Real Title", extract after colon
    if (clean.includes(':')) {
        const afterColon = clean.split(':').slice(1).join(':').trim();
        if (afterColon && afterColon.split(/\s+/).length <= 6) {
            clean = afterColon;
        }
    }

    // Strip trailing " Topic" — common model failure (e.g. "Language Query Topic" → "Language Query")
    clean = clean.replace(/\s+topic$/i, '').trim();
    if (!clean) return null;

    // Reject anything with exclamation marks or asterisks — it's commentary, not a title
    if (clean.includes('!') || clean.includes('*')) return null;

    const words = clean.split(/\s+/);
    if (words.length > 8) return null; // it's a sentence, not a title
    const lower = clean.toLowerCase();
    if (SENTENCE_STARTERS.some(s => lower.startsWith(s))) return null;
    if (GENERIC_TITLES.has(lower)) return null; // reject placeholder → caller falls back
    return clean;
};

// --- LAYER 2: HEURISTIC PRE-FILTER ---
const REPLACEMENT_SIGNALS = ['actually', 'instead', 'switch to', 'change to', 'scratch that', 'forget that', 'never mind', 'on second thought', 'rather than', 'let\'s do', 'how about we do'];
const CONTINUATION_SIGNALS = ['also', 'and what about', 'what if', 'how about for', 'another thing', 'one more', 'additionally', 'plus', 'regarding', 'about the', 'for the', 'back to', 'what about'];

type HeuristicHint = 'LIKELY_NEW' | 'LIKELY_SAME' | 'UNCERTAIN';

const getHeuristicHint = (currentTopic: string, userMessage: string): HeuristicHint => {
    const msgLower = userMessage.toLowerCase();

    // Check replacement signals — "actually" + context suggests a change of mind
    if (REPLACEMENT_SIGNALS.some(signal => msgLower.includes(signal))) {
        return 'LIKELY_NEW';
    }

    // Check continuation signals
    if (CONTINUATION_SIGNALS.some(signal => msgLower.startsWith(signal) || msgLower.includes(signal))) {
        return 'LIKELY_SAME';
    }

    // Keyword divergence: does the message share ANY content words with the topic?
    const topicWords = new Set(
        currentTopic.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );
    const msgWords = msgLower.split(/\s+/).filter(w => w.length > 3);
    const hasOverlap = msgWords.some(w => topicWords.has(w));

    const isQuestion = msgLower.includes('?') || /^(what|who|how|where|when|why|can|do|does|is|are)\b/.test(msgLower);

    // Zero overlap + question + enough words → likely a different domain
    if (!hasOverlap && isQuestion && msgWords.length >= 2) {
        return 'LIKELY_NEW';
    }

    return 'UNCERTAIN';
};

// --- LAYER 3, STEP 1: BINARY CLASSIFICATION ---
const parseClassification = (raw: string): 'SAME' | 'NEW' | null => {
    const clean = raw.trim().toUpperCase();
    if (clean === 'SAME' || clean === 'NEW') return clean;
    if (clean.startsWith('SAME')) return 'SAME';
    if (clean.startsWith('NEW')) return 'NEW';
    // Short response — check for either word
    if (clean.length < 30) {
        if (clean.includes('NEW')) return 'NEW';
        if (clean.includes('SAME')) return 'SAME';
    }
    return null;
};

const classifyTopicShift = async (
    currentTopic: string,
    lastUserMessage: string,
    hint: HeuristicHint,
    preferredBackend: 'GEMINI' | 'OLLAMA'
): Promise<'SAME' | 'NEW'> => {
    const hintLine = hint === 'LIKELY_NEW' ? '\nHint: this message likely starts a new topic.\n'
        : hint === 'LIKELY_SAME' ? '\nHint: this message likely continues the current topic.\n'
        : '';

    const prompt = `Classify: does this message continue the current topic, or start a new one? Reply with ONLY the word SAME or NEW.
${hintLine}
Examples:
- Topic: "Dinner Party Planning", Message: "what food should we serve?" → SAME
- Topic: "Dinner Party Planning", Message: "what about outdoor seating?" → SAME
- Topic: "Dinner Party Planning", Message: "what if guests are vegan?" → SAME
- Topic: "Dinner Party Planning", Message: "what music should I play?" → SAME
- Topic: "Dinner Party Planning", Message: "actually, let's do Japanese instead" → NEW
- Topic: "Dinner Party Planning", Message: "what's the capital of India?" → NEW
- Topic: "Python Debugging", Message: "can you fix the loop too?" → SAME
- Topic: "Python Debugging", Message: "help me plan my vacation" → NEW
- Topic: "Italian Recipes", Message: "actually switch to French cooking" → NEW
- Topic: "Travel Planning", Message: "what about hotels?" → SAME

Topic: "${currentTopic}", Message: "${lastUserMessage.slice(0, 200)}" →`;

    const tryGemini = async () => executeGeminiAnalysis(prompt);
    const tryOllama = async () => callOllamaAnalysis(prompt);

    const strategies = preferredBackend === 'OLLAMA'
        ? [tryOllama, tryGemini]
        : [tryGemini, tryOllama];

    for (const strategy of strategies) {
        const result = await strategy();
        if (result) {
            const parsed = parseClassification(result);
            if (parsed) {
                console.log(`[Topic] classify "${lastUserMessage.slice(0, 40)}..." vs "${currentTopic}" → ${parsed} (hint: ${hint}, raw: "${result.trim()}")`);
                return parsed;
            }
        }
    }

    console.log(`[Topic] classify fallback → SAME (all backends failed)`);
    return 'SAME';
};

// --- LAYER 3, STEP 2: TITLE GENERATION ---
const generateTopicTitle = async (
    lastUserMessage: string,
    lastModelMessage: string,
    preferredBackend: 'GEMINI' | 'OLLAMA'
): Promise<string> => {
    const prompt = `Write a 2-4 word Title Case name for this conversation topic. Output ONLY the title, nothing else.

User said: "${lastUserMessage.slice(0, 300)}"
AI responded: "${lastModelMessage.slice(0, 200)}"

Title:`;

    const tryGemini = async () => executeGeminiAnalysis(prompt);
    const tryOllama = async () => callOllamaAnalysis(prompt);

    const strategies = preferredBackend === 'OLLAMA'
        ? [tryOllama, tryGemini]
        : [tryGemini, tryOllama];

    for (const strategy of strategies) {
        const result = await strategy();
        if (result) {
            // Strip "NEW:" prefix if classification leaked into title
            let cleaned = result.replace(/^NEW[:\s]+/i, '').trim();
            const validated = validateAndCleanTitle(cleaned);
            if (validated && validated !== 'SAME') {
                console.log(`[Topic] title generated: "${validated}"`);
                return validated;
            }
        }
    }

    // Last resort: extract key words from the user message
    const words = lastUserMessage.split(/\s+/).filter(w => w.length > 3).slice(0, 3);
    const fallback = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    console.log(`[Topic] title fallback: "${fallback || 'New Discussion'}"`);
    return fallback || 'New Discussion';
};

// --- ORCHESTRATOR (same signature as before) ---
export const analyzeTopicShift = async (
    currentTopic: string | null,
    newMessages: { role: string; content: string }[],
    preferredBackend: 'GEMINI' | 'OLLAMA' = 'GEMINI'
): Promise<string> => {
    // No current topic → generate initial title (first message in thread)
    if (!currentTopic) {
        return generateInitialTitle(newMessages, preferredBackend);
    }

    const lastUserMessage = newMessages.filter(m => m.role === 'user').pop()?.content || "";
    const lastModelMessage = newMessages.filter(m => m.role === 'model').pop()?.content || "";

    if (!lastUserMessage) return 'SAME';

    // Layer 2: Heuristic pre-filter
    const hint = getHeuristicHint(currentTopic, lastUserMessage);

    // Layer 3, Step 1: Binary classification (SAME or NEW)
    const classification = await classifyTopicShift(currentTopic, lastUserMessage, hint, preferredBackend);
    if (classification === 'SAME') return 'SAME';

    // Layer 3, Step 2: Generate title (only when NEW)
    return await generateTopicTitle(lastUserMessage, lastModelMessage, preferredBackend);
};

export const generateInitialTitle = async (
    messages: { role: string; content: string }[],
    preferredBackend: 'GEMINI' | 'OLLAMA'
): Promise<string> => {
    const text = messages.map(m => m.content).join('\n').slice(0, 500);
    const prompt = `2-4 word title for this conversation. Title Case. Nothing else — no quotes, no punctuation, no explanation, no preamble.
FORBIDDEN: "New Topic", "Topic Change", titles ending in "Topic", any sentence or commentary.
GOOD: Dinner Party Planning | Japanese Theme Ideas | Capital of India | Wine Recommendations
BAD: New Topic | Language Query Topic | A new chapter! Output: ...
Text: ${text}`;

    const tryGemini = async () => await executeGeminiAnalysis(prompt);
    const tryOllama = async () => await callOllamaAnalysis(prompt);

    const strategies = preferredBackend === 'OLLAMA'
        ? [tryOllama, tryGemini]
        : [tryGemini, tryOllama];

    for (const strategy of strategies) {
        const result = await strategy();
        if (result) {
            const validated = validateAndCleanTitle(result);
            if (validated && validated !== 'SAME') return validated;
        }
    }

    return "Conversation Start";
}

export const synthesizeContextFromNodes = async (
    nodes: { role: string; content: string }[],
    preferredBackend: 'GEMINI' | 'OLLAMA' = 'GEMINI'
): Promise<string> => {
    const fragments = nodes.map((msg, i) =>
        `Fragment ${i + 1} (${msg.role}):\n${msg.content.slice(0, 300)}`
    ).join('\n\n');

    const prompt = `You are a context compression engine for a non-linear AI conversation tool. The user has selected the following conversation fragments from different parts of their conversation history. Your job is to synthesize these into a single, dense, coherent context summary that preserves all key information, decisions, constraints, and intent signals. Write in second person ("You are working on...", "The key decisions so far are..."). Be specific — include actual names, numbers, technical details from the fragments. Do not add commentary. Do not say "here is a summary". Just write the synthesized context directly. Maximum 400 words.

SELECTED FRAGMENTS:
${fragments}`;

    const tryGemini = async () => executeGeminiAnalysis(prompt);
    const tryOllama = async () => callOllamaAnalysis(prompt);

    const strategies = preferredBackend === 'OLLAMA'
        ? [tryOllama, tryGemini]
        : [tryGemini, tryOllama];

    for (const strategy of strategies) {
        const result = await strategy();
        if (result) return result.trim();
    }

    return '[Context synthesis unavailable — AI backends unreachable. Review selected nodes manually.]';
}
