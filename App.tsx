
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Send, Paperclip, Share, Plus, Sparkles, ArrowUp, Clock, ChevronDown, Waypoints } from 'lucide-react';
import { motion, AnimatePresence, useMotionValue, useTransform, animate } from 'framer-motion';
import { INITIAL_MESSAGES, ROOT_MESSAGE } from './constants';
import { Message, Author, MessageCategory, Chapter, ContextItem } from './types';
import { Sidebar } from './components/Sidebar';
import { MessageBubble } from './components/MessageBubble';
import { Button } from './components/Button';
import { CanvasView } from './components/CanvasView';
import { ContextPanel } from './components/ContextPanel';
import { streamResponse, analyzeTopicShift, generateInitialTitle, BackendType, AVAILABLE_GEMINI_MODELS } from './services/gemini';
import { OllamaGuide } from './components/OllamaGuide';

const App = () => {
  // --- Core State ---
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [activeBranchHeadId, setActiveBranchHeadId] = useState<string>(ROOT_MESSAGE.id);
  const [viewMode, setViewMode] = useState<'LINEAR' | 'CANVAS'>('LINEAR');
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showCanvasTip, setShowCanvasTip] = useState(false);
  
  const [backendType, setBackendType] = useState<BackendType>('SIMULATION');
  const [preferredBackend, setPreferredBackend] = useState<'GEMINI' | 'OLLAMA'>('OLLAMA'); 
  const [showOllamaHelp, setShowOllamaHelp] = useState(false);
  
  const [selectedModelId, setSelectedModelId] = useState<string>(AVAILABLE_GEMINI_MODELS[0].id);

  const containerScale = useMotionValue(1);
  const containerOpacity = useTransform(containerScale, [0.6, 1], [0, 1]);
  const containerRadius = useTransform(containerScale, [0.95, 1], [32, 0]);
  const containerY = useTransform(containerScale, [0.5, 1], [50, 0]);

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [activeChapterId, setActiveChapterId] = useState<string>('');
  
  const [isDraftingBranch, setIsDraftingBranch] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right'>('right');
  const [isExtendedThinking, setIsExtendedThinking] = useState(false);
  const [pinnedItems, setPinnedItems] = useState<ContextItem[]>([]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const linearViewRef = useRef<HTMLDivElement>(null);
  const isAnalyzingRef = useRef(false);

  const isNewChat = activeBranchHeadId === ROOT_MESSAGE.id && !isDraftingBranch;

  // Auto-resize input textarea based on content
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${inputRef.current.scrollHeight}px`;
    }
  }, [inputText]);

  // --- 1. Thread Traversal Logic ---
  const currentThread = useMemo(() => {
    const thread: Message[] = [];
    let currentId: string | null = activeBranchHeadId;
    let loopSafety = 0;
    const MAX_DEPTH = 5000;
    
    while (currentId && loopSafety < MAX_DEPTH) {
      loopSafety++;
      const msg = messages.find(m => m.id === currentId);
      if (msg) {
        if (msg.id !== ROOT_MESSAGE.id) {
            thread.unshift(msg);
        }
        currentId = msg.parentId;
      } else {
        break;
      }
    }

    if (isDraftingBranch) {
        const ghostMsg: Message = {
            id: 'ghost-draft',
            parentId: activeBranchHeadId,
            author: Author.USER,
            content: '',
            timestamp: Date.now()
        };
        thread.push(ghostMsg);
    }

    return thread.map(msg => {
        if (!msg.parentId) return msg;
        
        let siblings = messages.filter(m => m.parentId === msg.parentId);
        siblings.sort((a, b) => a.timestamp - b.timestamp);
        
        if (isDraftingBranch && msg.parentId === activeBranchHeadId) {
             const ghostMsg: Message = {
                id: 'ghost-draft',
                parentId: activeBranchHeadId,
                author: Author.USER,
                content: '',
                timestamp: Date.now()
            };
            if (!siblings.some(s => s.id === 'ghost-draft')) {
                siblings = [...siblings, ghostMsg];
            }
        }
        
        if (msg.id === 'ghost-draft') {
             const realSiblings = messages.filter(m => m.parentId === activeBranchHeadId);
             realSiblings.sort((a, b) => a.timestamp - b.timestamp);
             siblings = [...realSiblings, msg];
        }

        if (siblings.length >= 1) {
            const index = siblings.findIndex(s => s.id === msg.id);
            const prev = siblings[index - 1];
            const next = siblings[index + 1];

            return {
                ...msg,
                siblingCount: siblings.length,
                siblingIndex: index + 1,
                prevSibling: prev?.id === 'ghost-draft' ? undefined : prev, 
                nextSibling: next?.id === 'ghost-draft' ? undefined : next
            };
        }
        return msg;
    });
  }, [messages, activeBranchHeadId, isDraftingBranch]);

  // --- 2. Intelligent Auto-Summarizer ---
  const lastAnalyzedIndexRef = useRef<number>(0);

  useEffect(() => {
      const threadIds = new Set(currentThread.map(m => m.id));
      const relevantChapters = chapters.filter(c => threadIds.has(c.startMessageId));

      if (relevantChapters.length > 0) {
          const lastChap = relevantChapters[relevantChapters.length - 1];
          const startIndex = currentThread.findIndex(m => m.id === lastChap.startMessageId);
          if (startIndex !== -1) {
              const safeIndex = Math.min(currentThread.length, startIndex + lastChap.messageCount);
              if (lastAnalyzedIndexRef.current < safeIndex || lastAnalyzedIndexRef.current > currentThread.length) {
                   lastAnalyzedIndexRef.current = safeIndex;
              }
          }
      } else {
          if (!isStreaming && currentThread.length < lastAnalyzedIndexRef.current) {
               lastAnalyzedIndexRef.current = 0;
          }
      }
  }, [activeBranchHeadId, chapters, isStreaming]);

  useEffect(() => {
      if (!isStreaming && currentThread.length > 0) {
          const validMessages = currentThread.filter(m => m.id !== 'ghost-draft' && !m.isComposedContext);
          const totalCount = validMessages.length;
          
          if (lastAnalyzedIndexRef.current > totalCount) {
             lastAnalyzedIndexRef.current = Math.max(0, totalCount - 1); 
          }

          const newMessagesCount = totalCount - lastAnalyzedIndexRef.current;
          const isTurnComplete = newMessagesCount >= 1; 
          const isStart = chapters.length === 0 && totalCount >= 1;

          if (isStart || isTurnComplete) {
              const bufferMessages = validMessages.slice(lastAnalyzedIndexRef.current);
              if (bufferMessages.length === 0) return;

              const threadIds = new Set(validMessages.map(m => m.id));
              let currentChapter: Chapter | undefined;
              for (let i = chapters.length - 1; i >= 0; i--) {
                  if (threadIds.has(chapters[i].startMessageId)) {
                      currentChapter = chapters[i];
                      break;
                  }
              }

              // 4-word gate: short messages can't signal a topic shift — skip API call
              const lastUserMsg = bufferMessages.filter(m => m.author === Author.USER).pop();
              const wordCount = lastUserMsg?.content.trim().split(/\s+/).length ?? 0;
              if (wordCount > 0 && wordCount < 4) {
                  if (currentChapter !== undefined) {
                      // Extend existing chapter — don't create a new one for a short message
                      setChapters(prev => {
                          let lastThreadChapIndex = -1;
                          const updatedChapters = [...prev];
                          for (let i = updatedChapters.length - 1; i >= 0; i--) {
                              if (threadIds.has(updatedChapters[i].startMessageId)) {
                                  lastThreadChapIndex = i;
                                  break;
                              }
                          }
                          if (lastThreadChapIndex !== -1) {
                              const lastChap = updatedChapters[lastThreadChapIndex];
                              updatedChapters[lastThreadChapIndex] = {
                                  ...lastChap,
                                  messageCount: lastChap.messageCount + newMessagesCount,
                                  subtopics: Array.from(new Set([...lastChap.subtopics, ...extractSubtopics(bufferMessages)])).slice(0, 12),
                                  confidence: lastChap.confidence === 'user-edited' ? 'user-edited' : 'auto-confirmed'
                              };
                              return updatedChapters;
                          }
                          return prev;
                      });
                      lastAnalyzedIndexRef.current = totalCount;
                  }
                  // No currentChapter + short message: hold ref, wait for more context next turn
                  return;
              }

              // Rolling 3-exchange context window: pass last 6 messages for richer classification
              const windowMessages = validMessages.slice(Math.max(0, validMessages.length - 6));
              const contextBlock = windowMessages.map(m => ({
                  role: m.author === Author.USER ? 'user' : 'model',
                  content: m.content
              }));

              // Use current thread's chapter as baseline. If none exists (e.g. new thread),
              // use null so the AI always generates a fresh title rather than inheriting an
              // unrelated chapter from a previous thread.
              const baselineTopic = currentChapter?.title ?? null;

              if (isAnalyzingRef.current) return;
              isAnalyzingRef.current = true;

              analyzeTopicShift(baselineTopic, contextBlock, preferredBackend).then(result => {
                  setChapters(prev => {
                      const startMsg = bufferMessages[0];
                      if (!startMsg) return prev;

                      const alreadyOwned = prev.find(c => c.startMessageId === startMsg.id);
                      if (alreadyOwned) return prev;

                      // Dedup: if the last chapter in this thread has the same title, extend it instead of creating a duplicate
                      const lastThreadChap = [...prev].reverse().find(c => threadIds.has(c.startMessageId));
                      if (lastThreadChap && result !== 'SAME' && lastThreadChap.title.toLowerCase() === result.toLowerCase()) {
                          const updatedChapters = [...prev];
                          const idx = updatedChapters.findIndex(c => c.id === lastThreadChap.id);
                          if (idx !== -1) {
                              updatedChapters[idx] = { ...updatedChapters[idx], messageCount: updatedChapters[idx].messageCount + newMessagesCount };
                          }
                          return updatedChapters;
                      }

                      if (result === "SAME" && prev.length > 0) {
                          const updatedChapters = [...prev];
                          let lastThreadChapIndex = -1;
                          for (let i = updatedChapters.length - 1; i >= 0; i--) {
                              if (threadIds.has(updatedChapters[i].startMessageId)) {
                                  lastThreadChapIndex = i;
                                  break;
                              }
                          }

                          if (lastThreadChapIndex !== -1) {
                              const lastChap = updatedChapters[lastThreadChapIndex];
                              updatedChapters[lastThreadChapIndex] = {
                                  ...lastChap,
                                  messageCount: lastChap.messageCount + newMessagesCount,
                                  subtopics: Array.from(new Set([...lastChap.subtopics, ...extractSubtopics(bufferMessages)])).slice(0, 12),
                                  confidence: lastChap.confidence === 'user-edited' ? 'user-edited' : 'auto-confirmed'
                              };
                              return updatedChapters;
                          }
                      }

                      const newChapterId = `chap-${Date.now()}`;
                      return [...prev, {
                          id: newChapterId,
                          title: result === "SAME" ? "Greeting" : result,
                          category: determineCategory(result),
                          startMessageId: startMsg.id,
                          messageCount: newMessagesCount || 1,
                          subtopics: extractSubtopics(bufferMessages),
                          confidence: 'auto-fragment' as const
                      }];
                  });
                  isAnalyzingRef.current = false;
              }).catch(() => {
                  isAnalyzingRef.current = false;
              });

              lastAnalyzedIndexRef.current = totalCount;
          }
      }
  }, [currentThread.length, isStreaming, preferredBackend, chapters.length]);

  const determineCategory = (title: string): MessageCategory => {
      const t = title.toLowerCase();
      if (t === 'same') return MessageCategory.REFINEMENT;
      if (t.includes('brainstorm') || t.includes('idea')) return MessageCategory.BRAINSTORM;
      if (t.includes('decision') || t.includes('select')) return MessageCategory.DECISION;
      if (t.includes('refine') || t.includes('fix')) return MessageCategory.REFINEMENT;
      if (t.includes('context') || t.includes('analyze') || t.includes('greeting')) return MessageCategory.CONTEXT;
      return MessageCategory.TANGENT;
  };

  const extractSubtopics = (msgs: Message[]) => {
      const IGNORED_WORDS = ['hey', 'hello', 'hi', 'ok', 'thanks', 'thank you', 'yes', 'no', 'sure', 'start'];
      return msgs
        .filter(m => {
            const content = m.content.toLowerCase().trim();
            const isIgnored = IGNORED_WORDS.includes(content);
            return m.author === Author.USER && !isIgnored && m.content.length > 1;
        })
        .slice(0, 2)
        .map(m => {
            if (m.content.length > 55) {
                return m.content.slice(0, 55).trim() + '...';
            }
            return m.content;
        });
  };

  useEffect(() => {
    if (viewMode !== 'LINEAR') return;
    const handleIntersect = (entries: IntersectionObserverEntry[]) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
            const msgId = entry.target.getAttribute('data-message-id');
            if (!msgId) return;
            const matchingChapter = chapters.find(c => c.startMessageId === msgId);
            if (matchingChapter) setActiveChapterId(matchingChapter.id);
        }
      });
    };
    observerRef.current = new IntersectionObserver(handleIntersect, {
      root: scrollContainerRef.current,
      threshold: 0.1, 
      rootMargin: '-20% 0px -60% 0px' 
    });
    chapters.forEach(c => {
        const el = document.getElementById(`msg-bubble-${c.startMessageId}`);
        if (el) observerRef.current?.observe(el);
    });
    return () => observerRef.current?.disconnect();
  }, [chapters, currentThread, viewMode]);

  useEffect(() => {
    let pinchTimeout: ReturnType<typeof setTimeout>;
    const handleWheel = (e: WheelEvent) => {
        if (viewMode !== 'LINEAR') return;
        if (e.ctrlKey) {
            e.preventDefault();
            const currentScale = containerScale.get();
            const delta = e.deltaY * 0.01; 
            const nextScale = Math.max(0.3, Math.min(1.1, currentScale - delta));
            containerScale.set(nextScale);
            if (nextScale < 0.60) {
                animate(containerScale, 0.4, { duration: 0.25, ease: [0.32, 0.72, 0, 1] }).then(() => {
                     setViewMode('CANVAS');
                     setTimeout(() => containerScale.set(1), 500);
                });
            }
            clearTimeout(pinchTimeout);
            pinchTimeout = setTimeout(() => {
                const finalScale = containerScale.get();
                if (finalScale >= 0.60) {
                    animate(containerScale, 1, { type: "spring", stiffness: 400, damping: 30 });
                }
            }, 150);
        }
    };
    const container = linearViewRef.current;
    if (container) container.addEventListener('wheel', handleWheel, { passive: false });
    else window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
        if (container) container.removeEventListener('wheel', handleWheel);
        window.removeEventListener('wheel', handleWheel);
        clearTimeout(pinchTimeout);
    };
  }, [viewMode]);

  const handleSendMessage = async () => {
    if (!inputText.trim() || isStreaming) return;

    const content = inputText;
    setInputText(''); 
    setIsStreaming(true);
    
    const wasDrafting = isDraftingBranch;
    setIsDraftingBranch(false); 

    const newMsgId = `msg-${Date.now()}`;
    const parentHasChildren = messages.some(m => m.parentId === activeBranchHeadId);
    if (parentHasChildren) setShowCanvasTip(true); 

    const newMessage: Message = {
      id: newMsgId,
      parentId: activeBranchHeadId,
      author: Author.USER,
      content: content,
      timestamp: Date.now(),
      category: MessageCategory.REFINEMENT,
      branchId: wasDrafting ? `b-${Date.now()}` : undefined
    };

    const isBranching = wasDrafting || (messages.some(m => m.parentId === activeBranchHeadId) && activeBranchHeadId !== 'root');
    
    if (isBranching) {
        const tempTitle = content.slice(0, 30).trim() + (content.length > 30 ? '...' : '');
        const branchChapterId = `chap-${Date.now()}`;
        const newBranchChapter: Chapter = {
            id: branchChapterId,
            title: tempTitle, 
            category: MessageCategory.DECISION,
            startMessageId: newMsgId,
            messageCount: 0,
            subtopics: [content.length > 55 ? content.slice(0, 55).trim() + '...' : content]
        };
        setChapters(prev => [...prev, newBranchChapter]);

        const parentMsg = messages.find(m => m.id === activeBranchHeadId);
        const titleContext = parentMsg
            ? [{ role: 'model', content: parentMsg.content.slice(0, 300) }, { role: 'user', content }]
            : [{ role: 'user', content }];
        generateInitialTitle(titleContext, preferredBackend).then(aiTitle => {
            if (aiTitle) {
                setChapters(prev => prev.map(c => c.id === branchChapterId ? { ...c, title: aiTitle } : c));
            }
        });
    }

    setMessages(prev => [...prev, newMessage]);
    setActiveBranchHeadId(newMsgId);

    const history = [...currentThread.filter(m => m.id !== 'ghost-draft'), newMessage].map(m => ({
        role: m.author === Author.USER ? 'user' : 'model',
        content: m.content
    }));
    
    const responseId = `resp-${Date.now()}`;
    const responsePlaceholder: Message = {
        id: responseId,
        parentId: newMsgId,
        author: Author.ASSISTANT,
        content: '',
        timestamp: Date.now() + 1
    };

    setMessages(prev => [...prev, responsePlaceholder]);
    setActiveBranchHeadId(responseId);

    let fullResponse = '';
    await streamResponse(
        history, 
        (chunk) => {
            fullResponse += chunk;
            setMessages(prev => prev.map(m => 
                m.id === responseId ? { ...m, content: fullResponse } : m
            ));
        },
        (type) => setBackendType(type),
        preferredBackend,
        selectedModelId 
    );
    setIsStreaming(false);
  };

  const handleBranch = (fromMessageId: string) => {
    setActiveBranchHeadId(fromMessageId);
    setIsDraftingBranch(true);
    setViewMode('LINEAR');
    setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  };

  const handleSwipeBranch = (currentMsgId: string, direction: 'prev' | 'next') => {
      setSwipeDirection(direction === 'prev' ? 'left' : 'right');
      const currentMsg = messages.find(m => m.id === currentMsgId);
      const effectiveParentId = currentMsg ? currentMsg.parentId : (currentMsgId === 'ghost-draft' ? activeBranchHeadId : null);
      if (!effectiveParentId) return;

      const siblings = messages.filter(m => m.parentId === effectiveParentId);
      siblings.sort((a, b) => a.timestamp - b.timestamp);
      
      let currentIndex = currentMsgId === 'ghost-draft' ? siblings.length : siblings.findIndex(s => s.id === currentMsgId);
      if (currentIndex === -1) return;

      let nextIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
      if (currentMsgId === 'ghost-draft' && direction === 'prev') nextIndex = siblings.length - 1;
      if (nextIndex >= siblings.length) nextIndex = 0;
      if (nextIndex < 0) nextIndex = siblings.length - 1;

      const targetSibling = siblings[nextIndex];
      if (currentMsgId === 'ghost-draft') setIsDraftingBranch(false);

      let pointer = targetSibling.id;
      let hasChild = true;
      while (hasChild) {
          const children = messages.filter(m => m.parentId === pointer);
          if (children.length > 0) {
              children.sort((a, b) => b.timestamp - a.timestamp);
              pointer = children[0].id; 
          } else hasChild = false;
      }
      setActiveBranchHeadId(pointer);
  };

  const findBestBranchHead = useCallback((targetMsgId: string): string => {
        if (targetMsgId === ROOT_MESSAGE.id) {
             const children = messages.filter(m => m.parentId === ROOT_MESSAGE.id);
             if (children.length > 0) return findBestBranchHead(children[0].id);
             return ROOT_MESSAGE.id;
        }
        const parentIds = new Set(messages.map(m => m.parentId).filter(Boolean) as string[]);
        const leaves = messages.filter(m => !parentIds.has(m.id));
        const descendantLeaves = leaves.filter(leaf => {
            let curr: string | null = leaf.id;
            let safety = 0;
            while (curr && safety < 1000) {
                safety++;
                if (curr === targetMsgId) return true;
                const msg = messages.find(m => m.id === curr);
                curr = msg ? msg.parentId : null;
            }
            return false;
        });
        if (descendantLeaves.length > 0) {
            descendantLeaves.sort((a, b) => b.timestamp - a.timestamp);
            return descendantLeaves[0].id;
        }
        return targetMsgId;
  }, [messages]);

  const handleNavigate = (msgId: string) => {
      setIsDraftingBranch(false);
      const newHead = findBestBranchHead(msgId);
      setActiveBranchHeadId(newHead);
      if (!currentThread.some(m => m.id === msgId)) lastAnalyzedIndexRef.current = 0;
      if (viewMode === 'CANVAS') {
          setViewMode('LINEAR');
          containerScale.set(0.6);
          animate(containerScale, 1, { duration: 0.4, ease: [0.2, 0.8, 0.2, 1] });
          setTimeout(() => {
             const el = document.getElementById(`msg-bubble-${msgId}`);
             el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 150);
      } else {
          const el = document.getElementById(`msg-bubble-${msgId}`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
  };

  const handleUpdateNodeTitle = (startMessageId: string, newTitle: string) => {
      setChapters(prev => {
          const existing = prev.find(c => c.startMessageId === startMessageId);
          if (existing) return prev.map(c => c.id === existing.id ? { ...c, title: newTitle } : c);
          const newChap: Chapter = {
              id: `chap-manual-${Date.now()}`,
              title: newTitle,
              category: MessageCategory.REFINEMENT,
              startMessageId: startMessageId,
              messageCount: 1,
              subtopics: []
          };
          const updated = [...prev, newChap];
          updated.sort((a, b) => {
             const msgA = messages.find(m => m.id === a.startMessageId);
             const msgB = messages.find(m => m.id === b.startMessageId);
             return (msgA?.timestamp || 0) - (msgB?.timestamp || 0);
          });
          return updated;
      });
  };
  
  const handleNewThread = () => {
      const newRootId = `root-${Date.now()}`;
      const newRoot: Message = {
          id: newRootId,
          parentId: null,
          author: Author.ASSISTANT,
          content: "SYSTEM_ROOT",
          timestamp: Date.now(),
          category: MessageCategory.CONTEXT
      };
      setMessages(prev => [...prev, newRoot]);
      setActiveBranchHeadId(newRootId);
      setViewMode('LINEAR');
      setInputText('');
      setIsDraftingBranch(false);
      lastAnalyzedIndexRef.current = 0;
  }

  const handlePinItem = (item: ContextItem) => {
      setPinnedItems(prev => prev.some(p => p.sourceMessageId === item.sourceMessageId) ? prev : [...prev, item]);
  };

  const handleUnpinItem = (id: string) => {
      setPinnedItems(prev => prev.filter(p => p.id !== id));
  };

  const handleCreateComposedBranch = useCallback((synthesizedText: string, sourceNodeIds: string[]) => {
      const newNodeId = `composed-${Date.now()}`;
      const composedMessage: Message = {
          id: newNodeId,
          parentId: null, // free-floating — not a child of any single node
          author: Author.SYSTEM,
          content: synthesizedText,
          timestamp: Date.now(),
          isComposedContext: true,
          category: MessageCategory.CONTEXT,
          sourceNodeIds,
      };
      setMessages(prev => [...prev, composedMessage]);
      setChapters(prev => [...prev, {
          id: `chap-composed-${Date.now()}`,
          title: 'Composed Context',
          category: MessageCategory.CONTEXT,
          startMessageId: newNodeId,
          messageCount: 1,
          subtopics: []
      }]);
      setActiveBranchHeadId(newNodeId);
      lastAnalyzedIndexRef.current = 0;
      containerScale.set(0.6);
      animate(containerScale, 1, { duration: 0.4, ease: [0.2, 0.8, 0.2, 1] });
      setViewMode('LINEAR');
  }, [containerScale]);

  const renderInputArea = (centered: boolean) => (
      <div 
        className={`relative bg-white rounded-[12px] border transition-all duration-300 pointer-events-auto flex flex-col gap-[30px] p-5 shadow-reference border-[#DCDFEA] outline outline-1 outline-[#DCDFEA] outline-offset-[-1px] ${isDraftingBranch ? 'border-dashed' : ''} ${centered ? 'w-full max-w-[600px]' : 'w-full max-w-4xl'}`}
      >
          <div className="flex flex-col gap-2">
            <textarea
                ref={inputRef}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                    if(e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                    }
                }}
                placeholder="Ask me anything"
                className="w-full resize-none outline-none text-[#1F2937] placeholder-[#98A2AF] font-lexend font-light text-base bg-transparent overflow-y-auto"
                rows={1}
                style={{ minHeight: '24px', maxHeight: '160px' }}
            />
          </div>
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-4">
                <div className="w-5 h-5 flex items-center justify-center overflow-hidden cursor-pointer hover:bg-gray-100 rounded transition-colors">
                    <Plus size={20} className="text-[#5C6672]" strokeWidth={1.5} />
                </div>
                <div 
                    onClick={() => setIsExtendedThinking(!isExtendedThinking)}
                    className="flex items-center gap-1.5 cursor-pointer group"
                >
                    <div className="flex items-center gap-[6px]">
                        <div className="w-5 h-5 flex items-center justify-center overflow-hidden">
                             <Clock size={16} className={`${isExtendedThinking ? 'text-[#16A39B]' : 'text-[#5C6672]'} transition-colors`} strokeWidth={1.5} />
                        </div>
                        <span className={`text-[13px] font-lexend font-light leading-tight transition-colors ${isExtendedThinking ? 'text-[#16A39B]' : 'text-[#5C6672]'} group-hover:text-[#1F2937]`}>
                            Extended thinking
                        </span>
                    </div>
                    <div className="w-5 h-5 flex items-center justify-center overflow-hidden">
                         <ChevronDown size={14} className="text-[#5C6672] opacity-60" />
                    </div>
                </div>
            </div>
            <button 
                disabled={!inputText.trim() || isStreaming}
                onClick={handleSendMessage}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all duration-300 shadow-md ${inputText.trim() ? 'opacity-100 scale-100 bg-[linear-gradient(180deg,#BEB7EE_0%,#F5B9CB_100%)]' : 'opacity-30 scale-95 bg-gray-200 cursor-not-allowed'}`}
            >
                <ArrowUp size={18} className="text-white" strokeWidth={3} />
            </button>
          </div>
      </div>
  );

  return (
    <div className="flex h-screen w-full overflow-hidden font-lexend text-claude-text bg-white">
      <OllamaGuide isOpen={showOllamaHelp} onClose={() => setShowOllamaHelp(false)} />
      {viewMode === 'LINEAR' && (
        <Sidebar 
          chapters={chapters} 
          currentThreadMessages={currentThread}
          allMessages={messages} 
          onNavigate={handleNavigate}
          activeMessageId={activeBranchHeadId}
          activeChapterId={activeChapterId}
          backendType={backendType}
          onToggleBackend={() => setPreferredBackend(prev => prev === 'GEMINI' ? 'OLLAMA' : 'GEMINI')}
          preferredBackend={preferredBackend}
          selectedModelId={selectedModelId}
          onSelectModel={setSelectedModelId}
          onShowOllamaHelp={() => setShowOllamaHelp(true)}
        />
      )}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {!isNewChat && (
            <header className="h-14 flex items-center justify-between px-6 flex-shrink-0 z-20 bg-white/95 backdrop-blur-sm sticky top-0 border-b border-gray-100">
                <div className="flex items-center gap-2 cursor-pointer hover:bg-black/5 py-1 px-2 rounded-lg transition-colors group">
                    <h1 className="font-lexend text-[#5C6672] font-medium truncate max-w-[200px] text-sm">
                        {chapters.length > 0 ? chapters[chapters.length-1].title : 'Conversation'}
                    </h1>
                    <span className="text-gray-400 text-xs mt-0.5 group-hover:text-gray-600">▼</span>
                </div>
                <div className="flex items-center gap-3 relative">
                    <div className="flex bg-[#F7F7F7] p-0.5 rounded-lg relative border border-gray-200">
                        <button onClick={() => setViewMode('LINEAR')} className={`px-4 py-1.5 rounded-md text-xs font-lexend font-medium transition-all ${viewMode === 'LINEAR' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>Chat</button>
                        <button onClick={() => setViewMode('CANVAS')} className={`px-4 py-1.5 rounded-md text-xs font-lexend font-medium transition-all ${viewMode === 'CANVAS' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>Canvas</button>
                    </div>
                    <button onClick={handleNewThread} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-black/5" title="New Thread"><Plus size={16} /></button>
                    <Button variant="secondary" className="text-xs h-8"><Share size={14} /> Share</Button>
                </div>
            </header>
        )}
        <AnimatePresence mode="wait">
        {viewMode === 'LINEAR' ? (
            <motion.div 
                key="linear-view"
                ref={linearViewRef}
                className="flex-1 flex flex-col overflow-hidden origin-center bg-[#FBFBFB] relative"
                style={{ scale: containerScale, opacity: containerOpacity, borderRadius: containerRadius, y: containerY }}
                transition={{ type: "spring", stiffness: 300, Hub: 30 }}
            >
            {isNewChat ? (
                 <div className="flex-1 flex flex-col items-center justify-center p-6 animate-in fade-in duration-500 gap-10">
                     <div className="w-[214px] flex flex-col items-center gap-5">
                         {/* Minimalist Waypoints Logo */}
                         <div className="w-12 h-12 flex items-center justify-center rounded-2xl bg-white border border-[#E5E7EB] shadow-[0_4px_12px_rgba(0,0,0,0.03)] transition-all hover:shadow-md">
                            <Waypoints size={24} className="text-[#1F2937]" strokeWidth={1.5} />
                         </div>
                         <h1 className="w-full text-center text-[#454545] text-[36px] font-alegreya font-normal leading-[54px] whitespace-nowrap">Thread Canvas</h1>
                     </div>
                     <div className="w-full flex flex-col items-center gap-10">
                         {renderInputArea(true)}
                         <div className="flex justify-center gap-3 opacity-60">
                            <span className="text-[11px] text-gray-400 font-lexend font-light">ThreadCanvas AI</span>
                            <span className="text-[11px] text-gray-300">·</span>
                            <span className="text-[11px] text-gray-400 font-lexend font-light">Branching</span>
                            <span className="text-[11px] text-gray-300">·</span>
                            <span className="text-[11px] text-gray-400 font-lexend font-light">Canvas</span>
                            <span className="text-[11px] text-gray-300">·</span>
                            <span className="text-[11px] text-gray-400 font-lexend font-light">Context</span>
                         </div>
                     </div>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto overflow-x-visible px-[5%] md:px-[15%] pt-4 custom-scrollbar scroll-smooth" ref={scrollContainerRef}>
                    <div className="max-w-4xl mx-auto pb-[240px] flex flex-col gap-[32px]"> 
                        {currentThread.map((msg, idx) => (
                            <div key={msg.id} id={`msg-bubble-${msg.id}`} data-message-id={msg.id}>
                                <MessageBubble
                                    message={msg as any}
                                    onBranch={handleBranch}
                                    onSwipeBranch={handleSwipeBranch}
                                    isHead={idx === currentThread.length - 1}
                                    parentContent={messages.find(m => m.id === msg.parentId)?.content}
                                    slideDirection={swipeDirection}
                                    onPin={handlePinItem}
                                />
                            </div>
                        ))}
                        {isStreaming && (
                            <div className="flex items-center gap-3 animate-in fade-in slide-in-from-bottom-2">
                                <span className="text-[#98A2AF] text-[14px] font-lexend font-light italic">Synthesizing...</span>
                            </div>
                        )}
                        <div ref={messagesEndRef} className="h-1" />
                    </div>
                </div>
            )}
            {!isNewChat && (
                <div className="absolute bottom-0 left-0 right-0 pb-10 pt-8 px-6 bg-gradient-to-t from-[#FBFBFB] via-[#FBFBFB] via-70% to-transparent z-10 pointer-events-none">
                    <div className="max-w-4xl mx-auto flex justify-center">
                        {renderInputArea(false)}
                    </div>
                </div>
            )}
            </motion.div>
        ) : (
            <CanvasView
                key="canvas-view"
                messages={messages}
                chapters={chapters}
                activeBranchHeadId={activeBranchHeadId}
                onNavigate={handleNavigate}
                entryAnimation={true}
                onUpdateNodeTitle={handleUpdateNodeTitle}
                onCreateComposedBranch={handleCreateComposedBranch}
                preferredBackend={preferredBackend}
            />
        )}
        </AnimatePresence>
      </div>
      {viewMode === 'LINEAR' && pinnedItems.length > 0 && (
        <ContextPanel pinnedItems={pinnedItems} onUnpin={handleUnpinItem} />
      )}
    </div>
  );
};

export default App;
