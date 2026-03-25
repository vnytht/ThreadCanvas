
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000); // 3s timeout — fail fast on Vercel
        const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: modelName,
                messages: [{ role: 'user', content: prompt }],
                stream: false
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!response.ok) return null;
        const json = await response.json();
        return json.message?.content || null;
    } catch (e) {
        return null; // timeout or connection refused → Gemini fallback kicks in
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

const getHeuristicHint = (currentTopic: string, userMessage: string, contextMessages?: string[]): HeuristicHint => {
    const msgLower = userMessage.toLowerCase();

    // Check replacement signals — "actually", "instead", etc. = change of mind
    if (REPLACEMENT_SIGNALS.some(signal => msgLower.includes(signal))) {
        return 'LIKELY_NEW';
    }

    // Check continuation signals
    if (CONTINUATION_SIGNALS.some(signal => msgLower.startsWith(signal) || msgLower.includes(signal))) {
        return 'LIKELY_SAME';
    }

    // Keyword divergence: check against BOTH the chapter title AND recent message content
    // This prevents "what drink goes with pasta?" being flagged as NEW just because
    // "drink" and "pasta" don't appear in "Dinner Party Planning"
    const allContext = [currentTopic, ...(contextMessages || [])].join(' ');
    const topicWords = new Set(
        allContext.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );
    const msgWords = msgLower.split(/\s+/).filter(w => w.length > 3);
    const hasOverlap = msgWords.some(w => topicWords.has(w));

    const isQuestion = msgLower.includes('?') || /^(what|who|how|where|when|why|can|do|does|is|are)\b/.test(msgLower);

    // Only flag LIKELY_NEW if ZERO overlap with ALL recent context (not just title)
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
- Topic: "Dinner Party Planning", Message: "what drink goes with pasta?" → SAME
- Topic: "Dinner Party Planning", Message: "what wine pairs well with this?" → SAME
- Topic: "Dinner Party Planning", Message: "actually, let's do Japanese instead" → NEW
- Topic: "Dinner Party Planning", Message: "what's the capital of India?" → NEW
- Topic: "Italian Dinner Theme", Message: "what dessert should I serve?" → SAME
- Topic: "Italian Dinner Theme", Message: "what wine goes with pasta?" → SAME
- Topic: "Italian Dinner Theme", Message: "help me write a resume" → NEW
- Topic: "Python Debugging", Message: "can you fix the loop too?" → SAME
- Topic: "Python Debugging", Message: "help me plan my vacation" → NEW
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
Keep it simple and descriptive — NOT poetic, creative, or metaphorical.
GOOD: Japanese Dinner Theme | Italian Food Planning | Capital of India | Vegan Menu Options
BAD: Sakura Soiree | Culinary Journey | Eastern Delights

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

    // Layer 2: Heuristic pre-filter — pass recent message content so "wine/pasta/drink"
    // correctly overlap with previous dinner conversation messages (not just the chapter title)
    const contextContents = newMessages.map(m => m.content);
    const hint = getHeuristicHint(currentTopic, lastUserMessage, contextContents);

    // Layer 3, Step 1: Binary classification (SAME or NEW)
    const classification = await classifyTopicShift(currentTopic, lastUserMessage, hint, preferredBackend);
    if (classification === 'SAME') return 'SAME';

    // Layer 3, Step 2: Generate title (only when NEW)
    return await generateTopicTitle(lastUserMessage, lastModelMessage, preferredBackend);
};

// =============================================================================
// CURVETILE — Multi-Signal Topic Detection Module (Stage 1: standalone/testable)
// Signals: NCD (compression) + Jaccard (lexical) + SemanticCurvature (Ollama embed)
// NOT yet wired into analyzeTopicShift — test from browser console first:
//   await window.__curveTile.computeNCD("let's plan a dinner party, Italian food", "what music should I play?")
//   window.__curveTile.computeJaccard(["let's plan a dinner party", "Italian food is great"], "what music?")
//   await window.__curveTile.multiSignalVote(["let's plan a dinner", "italian food"], "what music?")
// =============================================================================

type SignalVote = 'SAME' | 'NEW' | 'UNCERTAIN';

// --- STOPWORDS for Jaccard ---
const STOPWORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with',
    'as','by','from','is','it','its','was','are','be','been','being','have',
    'has','had','do','does','did','will','would','could','should','may','might',
    'this','that','these','those','i','you','he','she','we','they','what',
    'who','how','why','when','where','which','can','just','also','not','so',
    'if','then','than','more','some','any','all','each','very','much','many'
]);

// --- SIGNAL A: Normalized Compression Distance via browser gzip ---
// NCD(x,y) = [C(xy) - min(C(x),C(y))] / max(C(x),C(y))
// Values: 0.0 = identical, 1.0 = unrelated
// SAME < 0.30 | UNCERTAIN 0.30-0.60 | NEW > 0.60
export const computeNCD = async (contextText: string, newMessage: string): Promise<SignalVote> => {
    try {
        const compress = async (text: string): Promise<number> => {
            const encoder = new TextEncoder();
            const data = encoder.encode(text);
            const cs = new CompressionStream('gzip');
            const writer = cs.writable.getWriter();
            writer.write(data);
            writer.close();
            const reader = cs.readable.getReader();
            let size = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
            }
            return size;
        };

        const cx = await compress(contextText.slice(0, 600));
        const cy = await compress(newMessage.slice(0, 300));
        const cxy = await compress((contextText + ' ' + newMessage).slice(0, 900));

        const ncd = (cxy - Math.min(cx, cy)) / Math.max(cx, cy);
        // Raised NEW threshold to 0.72 — gzip overhead inflates NCD for short texts
        // SAME < 0.35 | UNCERTAIN 0.35-0.72 | NEW > 0.72
        const vote: SignalVote = ncd < 0.35 ? 'SAME' : ncd > 0.72 ? 'NEW' : 'UNCERTAIN';
        console.log(`[CurveTile] NCD: cx=${cx} cy=${cy} cxy=${cxy} → ncd=${ncd.toFixed(3)} → ${vote}`);
        return vote;
    } catch (e) {
        console.warn('[CurveTile] NCD unavailable (CompressionStream not supported):', e);
        return 'UNCERTAIN';
    }
};

// --- SIGNAL B: Keyword Jaccard Overlap ---
// Confirms SAME when keywords overlap — does NOT vote NEW (low overlap ≠ new topic,
// it just means a follow-up question about a different aspect of the same task)
// SAME > 0.08 | UNCERTAIN otherwise
export const computeJaccard = (contextMessages: string[], newMessage: string): SignalVote => {
    const extractWords = (text: string): Set<string> => {
        const words = text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !STOPWORDS.has(w));
        return new Set(words);
    };

    const contextWords = new Set<string>();
    contextMessages.forEach(msg => extractWords(msg).forEach(w => contextWords.add(w)));
    const newWords = extractWords(newMessage);

    if (newWords.size === 0 || contextWords.size === 0) return 'UNCERTAIN';

    const intersection = new Set([...newWords].filter(w => contextWords.has(w)));
    const union = new Set([...contextWords, ...newWords]);
    const jaccard = intersection.size / union.size;

    // Only confirms SAME — never votes NEW (low overlap is expected for sub-topic questions)
    const vote: SignalVote = jaccard > 0.08 ? 'SAME' : 'UNCERTAIN';
    console.log(`[CurveTile] Jaccard: intersection=${intersection.size} union=${union.size} → j=${jaccard.toFixed(3)} → ${vote}`);
    return vote;
};

// --- SIGNAL C: Semantic Curvature via Ollama embeddings (optional, graceful fallback) ---
const embeddingCache = new Map<string, number[]>();

export const callOllamaEmbed = async (text: string): Promise<number[] | null> => {
    const key = text.slice(0, 100);
    if (embeddingCache.has(key)) return embeddingCache.get(key)!;
    try {
        const modelName = await getOllamaModel();
        const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: modelName, input: text })
        });
        if (!response.ok) return null;
        const json = await response.json();
        const embedding = json.embeddings?.[0] || json.embedding || null;
        if (embedding) embeddingCache.set(key, embedding);
        return embedding;
    } catch {
        return null;
    }
};

const dotProduct = (a: number[], b: number[]): number =>
    a.reduce((sum, val, i) => sum + val * b[i], 0);

const magnitude = (v: number[]): number =>
    Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));

const cosineSim = (a: number[], b: number[]): number => {
    const mag = magnitude(a) * magnitude(b);
    return mag === 0 ? 0 : dotProduct(a, b) / mag;
};

// Returns curvature in degrees, or null if not enough data
export const computeSemanticCurvature = (embeddingHistory: number[][]): SignalVote => {
    if (embeddingHistory.length < 3) return 'UNCERTAIN';

    const n = embeddingHistory.length;
    const e0 = embeddingHistory[n - 3];
    const e1 = embeddingHistory[n - 2];
    const e2 = embeddingHistory[n - 1];

    // velocity vectors
    const v1 = e1.map((val, i) => val - e0[i]);
    const v2 = e2.map((val, i) => val - e1[i]);
    const m1 = magnitude(v1);
    const m2 = magnitude(v2);

    if (m1 === 0 || m2 === 0) return 'UNCERTAIN';

    const cosAngle = Math.max(-1, Math.min(1, dotProduct(v1, v2) / (m1 * m2)));
    const curvatureDeg = (Math.acos(cosAngle) * 180) / Math.PI;
    const sim = cosineSim(e1, e2);

    const vote: SignalVote = (curvatureDeg < 20 && sim > 0.70) ? 'SAME'
        : curvatureDeg > 45 ? 'NEW'
        : 'UNCERTAIN';

    console.log(`[CurveTile] Curvature: κ=${curvatureDeg.toFixed(1)}° sim=${sim.toFixed(3)} → ${vote}`);
    return vote;
};

// --- VOTING ORCHESTRATOR ---
// Filters UNCERTAIN votes, requires 2/3 majority for a decision
// Discourse hint breaks ties
export const multiSignalVote = (
    ncd: SignalVote,
    jaccard: SignalVote,
    curvature: SignalVote,
    discourseHint: HeuristicHint = 'UNCERTAIN'
): SignalVote => {
    const definitive = [ncd, jaccard, curvature].filter(v => v !== 'UNCERTAIN');
    const newCount = definitive.filter(v => v === 'NEW').length;
    const sameCount = definitive.filter(v => v === 'SAME').length;

    let vote: SignalVote;

    if (definitive.length === 0) {
        // All signals uncertain — fall back to discourse hint
        vote = discourseHint === 'LIKELY_NEW' ? 'NEW'
            : discourseHint === 'LIKELY_SAME' ? 'SAME'
            : 'UNCERTAIN';
    } else if (newCount / definitive.length >= 0.67) {
        vote = 'NEW';
    } else if (sameCount / definitive.length >= 0.67) {
        vote = 'SAME';
    } else {
        // Exactly split — discourse hint breaks tie
        vote = discourseHint === 'LIKELY_NEW' ? 'NEW'
            : discourseHint === 'LIKELY_SAME' ? 'SAME'
            : 'UNCERTAIN';
    }

    console.log(`[CurveTile] Vote: ncd=${ncd} jaccard=${jaccard} curvature=${curvature} discourse=${discourseHint} → ${vote}`);
    return vote;
};

// --- FULL PIPELINE (convenience for console testing) ---
// Usage: await window.__curveTile.runPipeline(contextMessages, newMessage, currentTopic)
export const runCurveTilePipeline = async (
    contextMessages: string[],
    newMessage: string,
    currentTopic: string = 'unknown'
): Promise<{ ncd: SignalVote; jaccard: SignalVote; curvature: SignalVote; vote: SignalVote }> => {
    // Include topic title prominently — helps NCD see sub-topics as related
    // e.g. "Dinner Party Planning\nlet's plan..." compresses well with "what music?"
    const contextText = `[Topic: ${currentTopic}]\n` + contextMessages.join('\n');
    const discourseHint = getHeuristicHint(currentTopic, newMessage);

    const [ncd, jaccard] = await Promise.all([
        computeNCD(contextText, newMessage),
        Promise.resolve(computeJaccard([currentTopic, ...contextMessages], newMessage))
    ]);

    // Curvature needs embedding history — return UNCERTAIN in standalone mode
    const curvature: SignalVote = 'UNCERTAIN';

    const vote = multiSignalVote(ncd, jaccard, curvature, discourseHint);
    console.log(`[CurveTile] Pipeline complete for "${newMessage.slice(0, 40)}..." → ${vote}`);
    return { ncd, jaccard, curvature, vote };
};

// Expose on window for browser console testing
if (typeof window !== 'undefined') {
    (window as any).__curveTile = {
        computeNCD,
        computeJaccard,
        computeSemanticCurvature,
        multiSignalVote,
        runPipeline: runCurveTilePipeline,
    };
    console.log('[CurveTile] Module loaded. Test with: await window.__curveTile.runPipeline(["context msg 1", "context msg 2"], "new message")');
}

export const generateInitialTitle = async (
    messages: { role: string; content: string }[],
    preferredBackend: 'GEMINI' | 'OLLAMA'
): Promise<string> => {
    const text = messages.map(m => m.content).join('\n').slice(0, 500);
    const prompt = `2-4 word title for this conversation. Title Case. Nothing else — no quotes, no punctuation, no explanation, no preamble.
Simple and descriptive — NOT poetic, creative, or metaphorical. Use plain English words that describe what the conversation is literally about.
FORBIDDEN: "New Topic", "Topic Change", titles ending in "Topic", any sentence or commentary, poetic/Japanese/foreign words.
GOOD: Dinner Party Planning | Japanese Dinner Theme | Capital of India | Wine Recommendations | Python Debugging
BAD: New Topic | Sakura Soiree | Culinary Journey | Eastern Delights | Language Query Topic
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
