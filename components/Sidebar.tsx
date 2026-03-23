
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Chapter, Message } from '../types';
import { Search, Clock, MessageSquare, ChevronDown, Waypoints } from 'lucide-react';
import { BackendType } from '../services/gemini';

interface SidebarProps {
  chapters: Chapter[];
  currentThreadMessages: Message[];
  allMessages: Message[];
  onNavigate: (msgId: string) => void;
  activeMessageId: string | null;
  activeChapterId?: string; 
  backendType: BackendType;
  onToggleBackend?: () => void;
  preferredBackend?: 'GEMINI' | 'OLLAMA';
  selectedModelId?: string;
  onSelectModel?: (id: string) => void;
  onShowOllamaHelp?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ 
    chapters, 
    currentThreadMessages,
    allMessages,
    onNavigate, 
    activeMessageId, 
    activeChapterId,
    backendType,
    onToggleBackend,
    preferredBackend
}) => {
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const isInitialMount = useRef(true);

  const messageMap = useMemo(() => {
      return new Map(allMessages.map(m => [m.id, m]));
  }, [allMessages]);

  const displayedChapters = useMemo(() => {
    const activeThreadIds = new Set(currentThreadMessages.map(m => m.id));

    const relevantChapters = chapters.filter(c => {
        if (activeThreadIds.has(c.startMessageId)) return true;
        if (searchQuery.trim()) {
             const lower = searchQuery.toLowerCase();
             return c.title.toLowerCase().includes(lower) || c.subtopics.some(s => s.toLowerCase().includes(lower));
        }
        let curr: Message | undefined = messageMap.get(c.startMessageId);
        let hops = 0;
        while (curr && hops < 500) {
            if (activeThreadIds.has(curr.id)) return true;
            if (!curr.parentId) break;
            curr = messageMap.get(curr.parentId);
            hops++;
        }
        return false;
    });

    return relevantChapters.sort((a, b) => {
         const msgA = messageMap.get(a.startMessageId);
         const msgB = messageMap.get(b.startMessageId);
         return (msgA?.timestamp || 0) - (msgB?.timestamp || 0);
    });
  }, [chapters, searchQuery, currentThreadMessages, messageMap]);

  // Auto-expand active chapter ONLY when it's specifically set as active (e.g. by scrolling or navigating)
  useEffect(() => {
      if (activeChapterId) {
          setExpandedChapters(prev => {
            if (prev.has(activeChapterId)) return prev;
            const next = new Set(prev);
            next.add(activeChapterId);
            return next;
          });
      }
  }, [activeChapterId]);

  // Initial expansion: only happens once when chapters first load
  useEffect(() => {
     if (displayedChapters.length > 0 && isInitialMount.current) {
       setExpandedChapters(new Set([displayedChapters[displayedChapters.length-1].id]));
       isInitialMount.current = false;
    }
  }, [displayedChapters.length]);

  const toggleChapter = (id: string) => {
    setExpandedChapters(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleHeaderClick = (chapter: Chapter) => {
    onNavigate(chapter.startMessageId);
  };

  return (
    <div className="w-[280px] flex-shrink-0 bg-[#F7F7F7] border-r border-[#DFE3E6] h-full flex flex-col px-5 pt-7 pb-7 overflow-hidden font-lexend">
      
      {/* Thread Outline Header */}
      <div className="mb-3.5">
        <h2 className="text-[13px] font-normal text-[#757577] uppercase tracking-normal leading-[19.5px]">
            Thread Outline
        </h2>
      </div>

      {/* Search Input */}
      <div className="mb-5">
        <div className="relative flex items-center bg-white border border-[#E6E7EB] rounded-[6px] px-2.5 py-[7px]">
            <Search size={14} className="text-[#9DA3AF] mr-1.5" />
            <input 
                type="text" 
                placeholder="Search topics.." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent text-[10px] text-gray-700 placeholder-[#9DA3AF] outline-none font-normal leading-[15px]"
            />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {displayedChapters.length === 0 ? (
            <div className="py-12 text-center text-[#9DA3AF] flex flex-col items-center gap-3">
                <Clock size={16} className="opacity-40"/>
                <span className="text-[10px] font-medium opacity-60">Timeline is empty</span>
            </div>
        ) : (
            <div className="space-y-3 pb-8">
                {displayedChapters.map((chapter) => {
                    const isExpanded = expandedChapters.has(chapter.id);
                    const isActiveChapter = chapter.id === activeChapterId;
                    const isActivePath = currentThreadMessages.some(m => m.id === chapter.startMessageId);
                    const isBranch = !isActivePath;

                    let containerClasses = "relative rounded-[6px] border transition-all duration-200 overflow-hidden ";
                    if (isActiveChapter) {
                        containerClasses += "bg-white border-[#50B1A8]/60 border-solid ";
                    } else if (isBranch) {
                        containerClasses += "bg-[#FBFBFB] border-[#DCDFEA] border-dashed ";
                    } else {
                        containerClasses += "bg-white border-[#DCDFEA] border-solid ";
                    }

                    return (
                        <div key={chapter.id} className={containerClasses}>
                            {/* Card Header */}
                            <div className="flex items-stretch cursor-pointer relative">
                                {/* Navigation Title Area */}
                                <div 
                                    className="flex-1 px-[13px] py-[12px] flex items-center gap-[6px] overflow-hidden hover:bg-black/[0.02] transition-colors"
                                    onClick={() => handleHeaderClick(chapter)}
                                >
                                    {isBranch && (
                                        <Waypoints size={12} className="text-[#A4AAB1] flex-shrink-0" />
                                    )}
                                    <h3 className={`text-[12px] leading-[18px] truncate ${isActiveChapter ? 'font-medium text-[#1F2937]' : 'font-normal text-[#5C6672]'}`}>
                                        {chapter.title}
                                    </h3>
                                </div>

                                {/* Toggle / Count Area */}
                                <div className="flex items-center gap-[6px] pr-2.5">
                                    <div className="bg-[#E6E7EB]/50 rounded-[3px] px-[6px] py-[0.5px] flex items-center gap-[5px] h-[16px] pointer-events-none">
                                        <MessageSquare size={10} className="text-[#A4AAB1]" />
                                        <span className="text-[10px] text-[#A4AAB1] font-light leading-[15px]">
                                            {chapter.messageCount}
                                        </span>
                                    </div>
                                    <button 
                                        onClick={(e) => { 
                                          e.stopPropagation(); 
                                          toggleChapter(chapter.id); 
                                        }}
                                        className="p-1.5 text-[#A5ABB6] hover:text-[#50B1A8] hover:bg-black/5 rounded-md transition-all duration-200"
                                        aria-label={isExpanded ? "Collapse chapter" : "Expand chapter"}
                                    >
                                        <ChevronDown 
                                          size={14} 
                                          className={`transition-transform duration-200 ${isExpanded ? 'rotate-0' : '-rotate-90'}`} 
                                        />
                                    </button>
                                </div>
                            </div>
                            
                            {/* Subtopics Content */}
                            <div className={`
                                transition-all duration-300 ease-in-out overflow-hidden
                                ${isExpanded ? 'max-h-[800px] opacity-100 border-t border-[#E6E7EB]/50' : 'max-h-0 opacity-0'}
                            `}>
                                <div className="relative px-[13px] py-3 space-y-[8px]">
                                    {chapter.subtopics.map((sub, i) => (
                                        <div key={i} className="relative pl-[14px] flex items-start group/sub">
                                            {/* Vertical Line Connector */}
                                            {i < chapter.subtopics.length - 1 && (
                                                <div className="absolute left-[1.75px] top-[10px] w-[0.5px] h-[calc(100%+8px)] bg-[#E4E4EA]"></div>
                                            )}
                                            
                                            {/* Node Dot */}
                                            <div className="absolute left-0 top-[6px] w-[4px] h-[4px] rounded-full bg-[#D1D5DB] group-hover/sub:bg-[#50B1A8] transition-colors"></div>
                                            
                                            <span className="text-[10px] text-[#858E97] group-hover:text-[#5C6672] font-normal leading-[15px] truncate transition-colors">
                                                {sub}
                                            </span>
                                        </div>
                                    ))}
                                    {chapter.subtopics.length === 0 && (
                                        <span className="text-[10px] text-[#A4AAB1] italic pl-[14px] opacity-60">No context summary yet</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        )}
      </div>
      
      {/* Sidebar Footer */}
      <div className="mt-4 pt-4 border-t border-[#DFE3E6]">
        <div className="flex items-center justify-between text-[10px] text-[#9DA3AF]">
            <div className="flex items-center gap-2">
                <div className={`w-1.5 h-1.5 rounded-full ${backendType === 'GEMINI' ? 'bg-teal-500' : backendType === 'OLLAMA' ? 'bg-orange-500' : 'bg-gray-300 animate-pulse'}`}></div>
                <span className="font-medium uppercase tracking-wider">{backendType}</span>
            </div>
            <span className="opacity-60">V1.2</span>
        </div>
      </div>
    </div>
  );
};
