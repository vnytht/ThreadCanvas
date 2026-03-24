
import React, { useMemo, useState, useRef, useEffect, memo, Dispatch, SetStateAction } from 'react';
import { Message, Author, Chapter } from '../types';
import { Clock, Layers, ZoomIn, ZoomOut, Maximize, GitCommit, FileText, ChevronRight, Edit2, MessageSquare, Code, List, X } from 'lucide-react';
import { motion, useMotionValue, animate, MotionValue, useTransform, PanInfo, AnimatePresence } from 'framer-motion';
import { ContextComposer } from './ContextComposer';

interface CanvasViewProps {
  messages: Message[];
  chapters: Chapter[];
  activeBranchHeadId: string;
  onNavigate: (msgId: string) => void;
  entryAnimation?: boolean;
  onUpdateNodeTitle?: (startMessageId: string, newTitle: string) => void;
  onCreateComposedBranch?: (synthesizedText: string, sourceNodeIds: string[]) => void;
  preferredBackend?: 'GEMINI' | 'OLLAMA';
}

// --- Types ---

interface NodePosition {
    x: number;
    y: number;
}

export interface GroupedNode {
  id: string; // The ID of the LAST message in the group
  startMessageId: string;
  messages: Message[];
  childrenIds: string[]; // IDs of the first messages of child groups
  x: number;
  y: number;
  depth: number; // -1 for free-floating composed nodes
  title: string;
  preview: string;
  hasCode: boolean;
  hasList: boolean;
  language?: string;
  timestamp: number;
  internalChapters: Chapter[]; // Chapters contained within this node
  isRoot: boolean;
  isComposedContext?: boolean;
  sourceNodeIds?: string[]; // For composed nodes: IDs of source GroupedNodes
}

// --- Constants ---
const GROUP_WIDTH = 280;
const GROUP_HEIGHT = 160;
const X_SPACING = 340;
const Y_SPACING = 190;
const CANVAS_SIZE = 50000;
const CANVAS_CENTER = CANVAS_SIZE / 2;
const GRID_SIZE = 25; 

// --- Helper Functions ---

const getNodeStyles = (isRoot: boolean, isActive: boolean, isComposedContext?: boolean) => {
    if (isComposedContext) {
        return {
            outerBg: '#FDF4FF',
            outerBorder: '#C084FC',
            innerBg: '#FDF4FF',
            dashed: true
        };
    }
    if (isRoot) {
        return {
            outerBg: '#F0F6FF',
            outerBorder: '#61A6FB',
            innerBg: '#F0F6FF',
            dashed: false
        };
    }
    if (isActive) {
        return {
            outerBg: '#ECFEF6',
            outerBorder: '#34D399',
            innerBg: '#ECFEF6',
            dashed: false
        };
    }
    return {
        outerBg: '#FBFCFD',
        outerBorder: '#DCDFEA',
        innerBg: '#FBFCFD',
        dashed: false
    };
};

const getRelativeTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'Just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
};

const cleanTextPreview = (text: string) => {
    return text
        .replace(/^Sure, I can help.*/i, '')
        .replace(/^Here is the.*/i, '')
        .replace(/^Certainly!.*/i, '')
        .replace(/^I'd be happy to.*/i, '')
        .replace(/\*\*/g, '')
        .replace(/^SYSTEM_ROOT$/i, '')
        .trim();
};

const extractCodeSnippet = (text: string): { lang: string, snippet: string } | null => {
    const match = text.match(/```(\w+)?\n([\s\S]*?)```/);
    if (match) {
        const lang = match[1] || 'Code';
        const lines = match[2].split('\n').filter(l => l.trim().length > 0).slice(0, 3);
        return { lang, snippet: lines.join('\n') };
    }
    return null;
};

const extractListPreview = (text: string): string | null => {
    const listItems = text.match(/^[-*•] .+$|^\d+\. .+$/gm);
    if (listItems && listItems.length > 0) {
        return listItems.slice(0, 2).join('\n'); 
    }
    return null;
}

const groupMessages = (allMessages: Message[], chapters: Chapter[]): GroupedNode[] => {
    if (allMessages.length === 0) return [];
    const childrenMap = new Map<string, string[]>();
    const messageMap = new Map<string, Message>();
    const primaryRootIds: string[] = [];
    const composedRootIds: string[] = [];
    allMessages.forEach(m => {
        messageMap.set(m.id, m);
        if (m.parentId) {
            if (!childrenMap.has(m.parentId)) childrenMap.set(m.parentId, []);
            childrenMap.get(m.parentId)?.push(m.id);
        } else if (m.isComposedContext) {
            composedRootIds.push(m.id);
        } else {
            primaryRootIds.push(m.id);
        }
    });
    if (primaryRootIds.length === 0) return [];
    const groups: GroupedNode[] = [];
    const visitedMsgIds = new Set<string>(); 
    const buildGroup = (startMsgId: string, depth: number): string | null => {
        if (visitedMsgIds.has(startMsgId)) return null; 
        const currentGroupMessages: Message[] = [];
        let currId: string | null = startMsgId;
        while (currId) {
            if (visitedMsgIds.has(currId)) break; 
            const msg = messageMap.get(currId);
            if (!msg) break;
            visitedMsgIds.add(currId);
            currentGroupMessages.push(msg);
            const children = childrenMap.get(currId) || [];
            if (children.length === 1) {
                currId = children[0];
            } else {
                currId = null;
            }
        }
        if (currentGroupMessages.length === 0) return null;
        const tailMsg = currentGroupMessages[currentGroupMessages.length - 1];
        const isRootNode = primaryRootIds.includes(currentGroupMessages[0].id);
        const isComposedContext = currentGroupMessages[0].isComposedContext === true;
        const firstUserMsg = currentGroupMessages.find(m => m.author === Author.USER);
        const lastAiMsg = [...currentGroupMessages].reverse().find(m => m.author === Author.ASSISTANT);
        const groupMessageIds = new Set(currentGroupMessages.map(m => m.id));
        const internalChapters = chapters.filter(c => groupMessageIds.has(c.startMessageId));
        const mainChapter = internalChapters.length > 0 ? internalChapters[internalChapters.length - 1] : null;
        
        let title = "";
        // PRIORITIZE AI CHAPTER TITLE OVER HARDCODED "START"
        if (mainChapter) {
            title = mainChapter.title;
        } else if (isRootNode) {
            title = "Thread Start";
        } else {
            if (firstUserMsg) {
                const raw = firstUserMsg.content;
                title = raw.slice(0, 35) + (raw.length > 35 ? '...' : '');
            } else {
                title = "Untitled Node";
            }
        }

        const aiContent = lastAiMsg ? lastAiMsg.content : "System";
        const hasCode = aiContent.includes('```');
        const hasList = /^(- |\d+\. )/m.test(aiContent);
        let preview = "";
        let language = undefined;

        // IMPROVED ROOT PREVIEW: Grab first real message instead of "Conversation Start"
        if (isRootNode) {
            const firstRealMsg = currentGroupMessages.find(m => m.content !== 'SYSTEM_ROOT');
            if (firstRealMsg) {
                preview = cleanTextPreview(firstRealMsg.content).slice(0, 100) + (firstRealMsg.content.length > 100 ? '...' : '');
            } else {
                preview = "Thread Start";
            }
        } else if (hasCode) {
            const codeData = extractCodeSnippet(aiContent);
            if (codeData) { preview = codeData.snippet; language = codeData.lang; }
            else preview = cleanTextPreview(aiContent).slice(0, 70);
        } else if (hasList) {
            const listData = extractListPreview(aiContent);
            if (listData) preview = listData;
            else preview = cleanTextPreview(aiContent).slice(0, 70);
        } else {
            preview = cleanTextPreview(aiContent).slice(0, 80) + (aiContent.length > 80 ? '...' : '');
        }

        const node: GroupedNode = {
            id: tailMsg.id,
            startMessageId: startMsgId,
            messages: currentGroupMessages,
            childrenIds: [],
            x: depth * X_SPACING + 50,
            y: 0,
            depth: depth,
            title,
            preview,
            hasCode,
            hasList,
            language,
            timestamp: tailMsg.timestamp,
            internalChapters: internalChapters,
            isRoot: isRootNode,
            isComposedContext,
        };
        groups.push(node);
        const tailChildren = childrenMap.get(tailMsg.id) || [];
        tailChildren.forEach(childId => {
            const childGroupId = buildGroup(childId, depth + 1);
            if (childGroupId) node.childrenIds.push(childGroupId);
        });
        return node.id;
    };
    primaryRootIds.forEach(rootId => buildGroup(rootId, 0));

    // Add composed context nodes as free-floating orphans (depth -1)
    composedRootIds.forEach(composedId => {
        if (visitedMsgIds.has(composedId)) return;
        const m = messageMap.get(composedId);
        if (!m) return;
        visitedMsgIds.add(composedId);
        const node: GroupedNode = {
            id: composedId,
            startMessageId: composedId,
            messages: [m],
            childrenIds: [],
            x: 50,  // overridden in calculateGroupLayout
            y: 0,   // overridden in calculateGroupLayout
            depth: -1,
            title: 'Composed Context',
            preview: cleanTextPreview(m.content).slice(0, 80) + (m.content.length > 80 ? '...' : ''),
            hasCode: false,
            hasList: false,
            timestamp: m.timestamp,
            internalChapters: [],
            isRoot: false,
            isComposedContext: true,
            sourceNodeIds: m.sourceNodeIds,
        };
        groups.push(node);
    });

    return groups;
};

const calculateGroupLayout = (groups: GroupedNode[]) => {
    if (groups.length === 0) return [];
    const groupMap = new Map<string, GroupedNode>();
    groups.forEach(g => groupMap.set(g.id, g));
    const getGroupChildren = (g: GroupedNode) => g.childrenIds.map(id => groupMap.get(id)).filter(Boolean) as GroupedNode[];
    const processedNodes = new Set<string>();
    const assignY = (node: GroupedNode, startY: number): number => {
        if (processedNodes.has(node.id)) return 1; 
        processedNodes.add(node.id);
        const children = getGroupChildren(node);
        if (children.length === 0) {
            node.y = startY;
            return 1; 
        }
        let currentY = startY;
        let totalHeight = 0;
        children.forEach(child => {
            const childHeight = assignY(child, currentY);
            currentY += childHeight * Y_SPACING;
            totalHeight += childHeight;
        });
        const firstChildY = children[0].y;
        const lastChildY = children[children.length - 1].y;
        node.y = (firstChildY + lastChildY) / 2;
        return totalHeight;
    };
    const roots = groups.filter(g => g.depth === 0);
    let currentRootY = 100;
    roots.forEach(root => {
        const height = assignY(root, currentRootY);
        currentRootY += height * Y_SPACING;
    });

    // Position composed nodes below all regular nodes
    const regularNodes = groups.filter(g => g.depth >= 0);
    if (regularNodes.length > 0) {
        const maxY = Math.max(...regularNodes.map(g => g.y));
        groups.filter(g => g.isComposedContext && g.depth === -1).forEach(node => {
            const sources = (node.sourceNodeIds || [])
                .map(id => groupMap.get(id))
                .filter(Boolean) as GroupedNode[];
            const avgSourceX = sources.length > 0
                ? sources.reduce((sum, g) => sum + g.x + GROUP_WIDTH / 2, 0) / sources.length - GROUP_WIDTH / 2
                : 50;
            node.x = Math.max(0, avgSourceX);
            node.y = maxY + 200;
        });
    }

    return groups;
};

// --- Minimap Component ---

interface MinimapProps {
    nodes: GroupedNode[];
    activeId: string;
    x: MotionValue<number>;
    y: MotionValue<number>;
    scale: MotionValue<number>;
}

const Minimap = memo(({ nodes, activeId, x, y, scale }: MinimapProps) => {
    const MAP_WIDTH = 180;
    const MAP_HEIGHT = 120;
    const PADDING = 40;
    const bounds = useMemo(() => {
        if (nodes.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0, w: 1, h: 1 };
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        });
        const w = (maxX + GROUP_WIDTH) - minX;
        const h = (maxY + GROUP_HEIGHT) - minY;
        return { minX, minY, w, h };
    }, [nodes]);
    const fitScale = useMemo(() => {
        if (bounds.w <= 0 || bounds.h <= 0) return 0.1;
        const scaleX = (MAP_WIDTH - PADDING) / bounds.w;
        const scaleY = (MAP_HEIGHT - PADDING) / bounds.h;
        return Math.min(scaleX, scaleY, 0.12);
    }, [bounds]);
    const miniScale = useTransform(scale, s => s * fitScale);
    const miniX = useTransform([x, scale], (values: any[]) => {
         const [latestX, latestScale] = values;
         return (latestX / latestScale) * fitScale + (MAP_WIDTH/2);
    });
    const miniY = useTransform([y, scale], (values: any[]) => {
         const [latestY, latestScale] = values;
         return (latestY / latestScale) * fitScale + (MAP_HEIGHT/2);
    });
    return (
        <div className="bg-white/90 backdrop-blur-sm border border-gray-200 rounded-xl shadow-lg relative select-none overflow-hidden" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}>
            <motion.div style={{ x: miniX, y: miniY, scale: miniScale, originX: 0.5, originY: 0.5 }} className="absolute top-0 left-0 w-full h-full">
                {nodes.map(node => {
                    const isActive = node.id === activeId || node.messages.some(m => m.id === activeId);
                    const bgClass = node.isRoot ? 'bg-blue-400' : (isActive ? 'bg-emerald-400' : 'bg-gray-300');
                    return (
                        <div key={node.id} className={`absolute rounded-[2px] ${bgClass}`} style={{ left: node.x - bounds.minX - bounds.w/2, top: node.y - bounds.minY - bounds.h/2, width: GROUP_WIDTH, height: GROUP_HEIGHT }} />
                    );
                })}
            </motion.div>
        </div>
    );
});

// --- Canvas Node Component ---

interface CanvasNodeProps {
    node: GroupedNode;
    isActive: boolean;
    isHead: boolean;
    isSelected: boolean;
    setNodeOverrides: Dispatch<SetStateAction<Record<string, NodePosition>>>;
    onNavigate: (id: string) => void;
    onSelectToggle: (id: string) => void;
    setDraggingNodeId: (id: string | null) => void;
    isDragging: boolean;
    onUpdateNodeTitle?: (startMessageId: string, newTitle: string) => void;
    scale: MotionValue<number>;
}

const CanvasNode = memo(({ node, isActive, isHead, isSelected, setNodeOverrides, onNavigate, onSelectToggle, setDraggingNodeId, isDragging, onUpdateNodeTitle, scale }: CanvasNodeProps) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState(node.title);

    const styles = getNodeStyles(node.isRoot, isActive, node.isComposedContext);
    
    // Accurate visible message count (excluding system messages)
    const visibleMessageCount = node.messages.filter(m => m.content !== 'SYSTEM_ROOT').length;
    
    // Content type icon logic
    const ContentTypeIcon = node.hasCode ? Code : (node.hasList ? List : MessageSquare);

    useEffect(() => {
        setEditTitle(node.title);
    }, [node.id, node.title]);

    const handleSaveTitle = () => {
        setIsEditing(false);
        if (editTitle.trim() && editTitle !== node.title && onUpdateNodeTitle) {
            onUpdateNodeTitle(node.startMessageId, editTitle);
        } else setEditTitle(node.title);
    };

    return (
        <motion.div
            className={`absolute w-[280px] h-[160px] cursor-grab active:cursor-grabbing pointer-events-auto transition-all duration-200 opacity-100 rounded-[9px] ${isSelected ? 'ring-2 ring-indigo-500 ring-offset-2' : ''}`}
            style={{
                x: CANVAS_CENTER + node.x,
                y: CANVAS_CENTER + node.y,
                zIndex: isDragging ? 50 : (isActive ? 20 : 10)
            }}
            drag dragMomentum={false} dragElastic={0}
            onDrag={(e, info: PanInfo) => {
                const currentScale = scale.get();
                setNodeOverrides(prev => {
                    const currentPos = prev[node.id] ?? { x: node.x, y: node.y };
                    const rawX = currentPos.x + (info.delta.x / currentScale);
                    const rawY = currentPos.y + (info.delta.y / currentScale);
                    
                    // Fixed jitter: update state but allow Framer Motion to handle visual smoothness
                    const snappedX = Math.round(rawX / GRID_SIZE) * GRID_SIZE;
                    const snappedY = Math.round(rawY / GRID_SIZE) * GRID_SIZE;
                    
                    return { ...prev, [node.id]: { x: snappedX, y: snappedY } };
                });
            }}
            onDragStart={() => setDraggingNodeId(node.id)}
            onDragEnd={() => setDraggingNodeId(null)}
            onTap={(e) => {
                const target = e.target as HTMLElement;
                if (!target.closest('button') && !target.closest('.timeline-item') && !target.closest('input')) {
                    const nativeEvt = e as unknown as MouseEvent;
                    if (nativeEvt.shiftKey) {
                        onSelectToggle(node.id);
                    } else {
                        let targetId = node.startMessageId;
                        if (node.messages[0].content === 'SYSTEM_ROOT' && node.messages.length > 1) {
                            targetId = node.messages[1].id;
                        }
                        onNavigate(targetId);
                    }
                }
            }}
            whileDrag={{ scale: 1.05, boxShadow: "0px 10px 20px rgba(0,0,0,0.15)" }}
        >
            <div
                className="w-full h-full rounded-[9px] flex flex-col p-[3px] font-lexend transition-all duration-200"
                style={styles.dashed ? {
                    background: styles.outerBg,
                    border: `1.5px dashed ${styles.outerBorder}`,
                } : {
                    background: styles.outerBg,
                    outline: `1px ${styles.outerBorder} solid`,
                    outlineOffset: '-1px'
                }}
            >
                {/* Header Section */}
                <div className="w-full flex flex-col rounded-t-[6px]" style={{ background: styles.innerBg }}>
                    <div className="w-full px-3 py-2 flex items-center justify-between">
                        {isEditing ? (
                            <input 
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                onBlur={handleSaveTitle}
                                onKeyDown={(e) => e.key === 'Enter' && handleSaveTitle()}
                                className="bg-white border border-blue-300 rounded px-1.5 py-0.5 text-xs font-normal text-gray-800 w-full outline-none shadow-sm min-w-0"
                                autoFocus
                                onClick={e => e.stopPropagation()}
                            />
                        ) : (
                            <div className="flex items-center gap-2 min-w-0 flex-1 group/title">
                                <span className="text-[12px] font-normal leading-[18px] text-[#5C6672] truncate" title={node.title}>
                                    {node.title}
                                </span>
                                {onUpdateNodeTitle && (
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
                                        className="opacity-0 group-hover/title:opacity-100 text-gray-400 hover:text-blue-500 transition-opacity"
                                    >
                                        <Edit2 size={10} />
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                            <ContentTypeIcon size={14} className="text-[#A5ABB6] opacity-60" />
                        </div>
                    </div>
                </div>

                {/* Inner Card */}
                <div 
                    className="flex-1 px-3 pt-3 pb-2 bg-white rounded-[6px] flex flex-col justify-start gap-2.5 overflow-hidden"
                    style={{ outline: '1px #DCDFEA solid', outlineOffset: '-1px' }}
                >
                    <div className="flex-1 overflow-hidden">
                        <div className="text-[10px] leading-[15px] font-normal text-[#858E97] line-clamp-4 select-text font-lexend">
                            {node.hasCode ? (
                                <pre className="font-mono text-[9px] opacity-80">{node.preview}</pre>
                            ) : node.preview}
                        </div>
                    </div>

                    {/* Card Footer Section */}
                    <div className="flex flex-col gap-2 pt-1 mt-auto">
                        <div className="h-[0.5px] bg-[#E4E4EA] w-full" />
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] font-light leading-[15px] text-[#858E97]">{getRelativeTime(node.timestamp)}</span>
                            <div className="flex items-center gap-1">
                                <div className="flex items-center gap-1 pl-1.5">
                                    <MessageSquare size={10} className="text-[#858E97]" />
                                    <span className="text-[10px] font-light leading-[15px] text-[#858E97]">{visibleMessageCount}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {isHead && (
                    <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full shadow-sm ring-2 ring-white z-20 animate-pulse bg-emerald-400"></div>
                )}
            </div>
        </motion.div>
    );
}, (prev: Readonly<CanvasNodeProps>, next: Readonly<CanvasNodeProps>) => {
    return (
        prev.node.x === next.node.x &&
        prev.node.y === next.node.y &&
        prev.isActive === next.isActive &&
        prev.isHead === next.isHead &&
        prev.isSelected === next.isSelected &&
        prev.isDragging === next.isDragging &&
        prev.node.id === next.node.id &&
        prev.node.title === next.node.title &&
        prev.node.preview === next.node.preview
    );
});


// --- Main Component ---

export const CanvasView: React.FC<CanvasViewProps> = ({ messages, chapters, activeBranchHeadId, onNavigate, entryAnimation = false, onUpdateNodeTitle, onCreateComposedBranch, preferredBackend = 'GEMINI' }) => {
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, NodePosition>>(() => {
      const saved = localStorage.getItem('threadcanvas_node_overrides');
      return saved ? JSON.parse(saved) : {};
  });
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
      localStorage.setItem('threadcanvas_node_overrides', JSON.stringify(nodeOverrides));
  }, [nodeOverrides]);

  // Escape key clears selection
  useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') setSelectedNodeIds(new Set());
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Hint text: fade in after 3s, out after 8s, never again once user has composed
  useEffect(() => {
      if (localStorage.getItem('threadcanvas_composer_used') === 'true') return;
      const showTimer = setTimeout(() => setShowHint(true), 3000);
      const hideTimer = setTimeout(() => setShowHint(false), 8000);
      return () => { clearTimeout(showTimer); clearTimeout(hideTimer); };
  }, []);

  const defaultLayoutNodes = useMemo(() => {
      const groups = groupMessages(messages, chapters);
      return calculateGroupLayout(groups);
  }, [messages, chapters]);

  const nodes = useMemo<GroupedNode[]>(() => {
      return defaultLayoutNodes.map(node => {
          const override = nodeOverrides[node.id];
          return override ? { ...node, x: override.x, y: override.y } : node;
      });
  }, [defaultLayoutNodes, nodeOverrides]);

  const { edges, referenceArcs } = useMemo(() => {
      const edgeList: Array<{sourceX: number, sourceY: number, targetX: number, targetY: number}> = [];
      const arcList: Array<{sourceX: number, sourceY: number, targetX: number, targetY: number}> = [];
      const nodeMap = new Map<string, GroupedNode>(nodes.map(n => [n.id, n]));
      nodes.forEach(node => {
          node.childrenIds.forEach(childId => {
              const child = nodeMap.get(childId);
              if (child) {
                  edgeList.push({
                      sourceX: node.x + GROUP_WIDTH,
                      sourceY: node.y + GROUP_HEIGHT / 2,
                      targetX: child.x,
                      targetY: child.y + GROUP_HEIGHT / 2
                  });
              }
          });
          // Reference arcs: dashed amber lines from source nodes to composed nodes
          if (node.isComposedContext && node.sourceNodeIds) {
              node.sourceNodeIds.forEach(srcId => {
                  const src = nodeMap.get(srcId);
                  if (src) {
                      arcList.push({
                          sourceX: src.x + GROUP_WIDTH / 2,
                          sourceY: src.y + GROUP_HEIGHT,
                          targetX: node.x + GROUP_WIDTH / 2,
                          targetY: node.y
                      });
                  }
              });
          }
      });
      return { edges: edgeList, referenceArcs: arcList };
  }, [nodes]);

  const viewportRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(entryAnimation ? 2.5 : 1);

  const handleWheel = (e: React.WheelEvent) => {
      if (e.ctrlKey) {
          e.preventDefault();
          const currentScale = scale.get();
          const d = e.deltaY * -0.01; 
          const newScale = Math.min(Math.max(0.25, currentScale + d), 4);
          scale.set(newScale);
      } else {
          e.preventDefault();
          x.set(x.get() - e.deltaX);
          y.set(y.get() - e.deltaY);
      }
  };

  const hasCentered = useRef(false);
  useEffect(() => {
      if (nodes.length === 0) return;
      if (hasCentered.current) return;
      let activeNode = nodes.find(n => n.id === activeBranchHeadId) || nodes.find(n => n.messages.some(m => m.id === activeBranchHeadId));
      if (!activeNode) activeNode = nodes[0];
      const nodeCenterX = activeNode.x + GROUP_WIDTH / 2;
      const nodeCenterY = activeNode.y + GROUP_HEIGHT / 2;
      // The canvas div uses "left: 50%" via className (marginLeft in style is treated as a
      // Framer Motion animatable value, NOT as CSS margin, so it has no layout effect).
      // Screen formula at scale=1: x_screen = vpW/2 + cx + x_motion
      // For node center at viewport center: x_motion = -nodeCenterX
      const targetX = -nodeCenterX;
      const targetY = -nodeCenterY;
      if (entryAnimation) {
          x.set(targetX);
          y.set(targetY);
          scale.set(2.5);
          animate(scale, 1, { type: "spring", stiffness: 200, damping: 30 });
      } else {
          x.set(targetX);
          y.set(targetY);
          scale.set(1);
      }
      hasCentered.current = true;
  }, [entryAnimation, nodes, activeBranchHeadId, x, y, scale]);

  // Re-center when viewport is resized
  useEffect(() => {
      const el = viewportRef.current;
      if (!el) return;
      const observer = new ResizeObserver(() => {
          if (nodes.length === 0) return;
          let activeNode = nodes.find(n => n.id === activeBranchHeadId) || nodes.find(n => n.messages.some(m => m.id === activeBranchHeadId));
          if (!activeNode) activeNode = nodes[0];
          const nodeCenterX = activeNode.x + GROUP_WIDTH / 2;
          const nodeCenterY = activeNode.y + GROUP_HEIGHT / 2;
          x.set(-nodeCenterX);
          y.set(-nodeCenterY);
      });
      observer.observe(el);
      return () => observer.disconnect();
  }, [nodes, activeBranchHeadId, x, y]);

  const handleZoomIn = () => animate(scale, Math.min(scale.get() * 1.5, 4));
  const handleZoomOut = () => animate(scale, Math.max(scale.get() / 1.5, 0.25));
  const handleFitView = () => animate(scale, 1);

  const activeNodeId = nodes.find(n => n.messages.some(m => m.id === activeBranchHeadId))?.id || activeBranchHeadId;

  // FIXED DOT GRID LOGIC
  const gridX = useTransform(x, val => `${val}px`);
  const gridY = useTransform(y, val => `${val}px`);

  return (
    <div ref={viewportRef} className="flex-1 overflow-hidden bg-[#FBFBFB] relative select-none h-full w-full">
       {/* Background Grid - Dots stay same size regardless of zoom */}
       <motion.div 
         className="absolute inset-0 pointer-events-none z-0" 
         style={{ 
            backgroundPositionX: gridX,
            backgroundPositionY: gridY,
            backgroundImage: 'radial-gradient(#E5E7EB 1.5px, transparent 1.5px)', 
            backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
            opacity: 0.6
         }} 
       />
       
       <motion.div 
         className="absolute top-1/2 left-1/2 cursor-grab active:cursor-grabbing z-10" 
         style={{ 
            x, y, scale, 
            width: CANVAS_SIZE, 
            height: CANVAS_SIZE, 
            marginLeft: -CANVAS_CENTER, 
            marginTop: -CANVAS_CENTER, 
            originX: 0.5, originY: 0.5 
         }} 
         drag 
         dragMomentum={false} 
         dragElastic={0} 
         onWheel={handleWheel} 
       >
            <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none z-0">
                {edges.map((edge, idx) => {
                    const dx = edge.targetX - edge.sourceX;
                    const dy = edge.targetY - edge.sourceY;
                    const curveOffset = Math.max(40, Math.min(100, dx * 0.4));
                    return (
                        <path
                            key={`edge-${idx}`}
                            d={`M ${CANVAS_CENTER + edge.sourceX} ${CANVAS_CENTER + edge.sourceY} C ${CANVAS_CENTER + edge.sourceX + curveOffset} ${CANVAS_CENTER + edge.sourceY}, ${CANVAS_CENTER + edge.targetX - curveOffset} ${CANVAS_CENTER + edge.targetY}, ${CANVAS_CENTER + edge.targetX} ${CANVAS_CENTER + edge.targetY}`}
                            fill="none"
                            stroke={"#D1D5DB"}
                            strokeWidth={2}
                        />
                    );
                })}
                {referenceArcs.map((arc, idx) => {
                    const curveOffset = Math.abs(arc.targetY - arc.sourceY) * 0.4;
                    return (
                        <path
                            key={`arc-${idx}`}
                            d={`M ${CANVAS_CENTER + arc.sourceX} ${CANVAS_CENTER + arc.sourceY} C ${CANVAS_CENTER + arc.sourceX} ${CANVAS_CENTER + arc.sourceY + curveOffset}, ${CANVAS_CENTER + arc.targetX} ${CANVAS_CENTER + arc.targetY - curveOffset}, ${CANVAS_CENTER + arc.targetX} ${CANVAS_CENTER + arc.targetY}`}
                            fill="none"
                            stroke="#F59E0B"
                            strokeWidth={1.5}
                            strokeDasharray="5,4"
                            strokeOpacity={0.45}
                        />
                    );
                })}
            </svg>
            <div className="absolute inset-0 z-10 pointer-events-none">
                {nodes.map((node) => {
                    const isActive = node.messages.some(m => m.id === activeBranchHeadId);
                    const isHead = node.id === activeBranchHeadId || node.messages.some(m => m.id === activeBranchHeadId);
                    return (
                        <CanvasNode
                            key={node.id}
                            node={node}
                            isActive={isActive}
                            isHead={isHead}
                            isSelected={selectedNodeIds.has(node.id)}
                            setNodeOverrides={setNodeOverrides}
                            onNavigate={onNavigate}
                            onSelectToggle={(id) => setSelectedNodeIds(prev => {
                                const next = new Set(prev);
                                if (next.has(id)) next.delete(id); else if (next.size < 8) next.add(id);
                                return next;
                            })}
                            setDraggingNodeId={setDraggingNodeId}
                            isDragging={draggingNodeId === node.id}
                            onUpdateNodeTitle={onUpdateNodeTitle}
                            scale={scale}
                        />
                    );
                })}
            </div>
       </motion.div>

      {/* Selection count badge */}
      <AnimatePresence>
        {selectedNodeIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-indigo-600 text-white text-[12px] font-lexend font-medium px-3 py-1.5 rounded-full shadow-lg pointer-events-auto"
          >
            <span>{selectedNodeIds.size} node{selectedNodeIds.size !== 1 ? 's' : ''} selected</span>
            <button onClick={() => setSelectedNodeIds(new Set())} className="ml-1 hover:text-indigo-200 transition-colors">
              <X size={12} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Context Composer panel */}
      <AnimatePresence>
        {selectedNodeIds.size >= 2 && (
          <ContextComposer
            selectedNodes={nodes.filter(n => selectedNodeIds.has(n.id))}
            onRemoveNode={(id) => setSelectedNodeIds(prev => { const n = new Set(prev); n.delete(id); return n; })}
            onClear={() => setSelectedNodeIds(new Set())}
            onBranchFromThis={(text, sourceNodeIds) => {
                setSelectedNodeIds(new Set());
                localStorage.setItem('threadcanvas_composer_used', 'true');
                setShowHint(false);
                onCreateComposedBranch?.(text, sourceNodeIds);
            }}
            preferredBackend={preferredBackend}
          />
        )}
      </AnimatePresence>

      <div className="absolute bottom-6 left-6 z-50 flex flex-col gap-3 pointer-events-auto">
         {/* Hint text */}
         <AnimatePresence>
           {showHint && selectedNodeIds.size === 0 && (
             <motion.p
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               exit={{ opacity: 0 }}
               className="text-[11px] font-lexend text-gray-400 bg-white/80 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-gray-200 shadow-sm select-none"
             >
               Hold Shift + click nodes to compose context across branches
             </motion.p>
           )}
         </AnimatePresence>
         <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-1 flex items-center self-start">
            <button onClick={handleZoomOut} className="p-2 hover:bg-gray-50 rounded-md text-gray-500 transition-colors"><ZoomOut size={16}/></button>
            <div className="w-[1px] h-4 bg-gray-100 mx-1"></div>
            <button onClick={handleFitView} className="p-2 hover:bg-gray-50 rounded-md text-gray-500 transition-colors"><Maximize size={16}/></button>
            <div className="w-[1px] h-4 bg-gray-100 mx-1"></div>
            <button onClick={handleZoomIn} className="p-2 hover:bg-gray-50 rounded-md text-gray-500 transition-colors"><ZoomIn size={16}/></button>
         </div>
     </div>

     <motion.div
        className="absolute bottom-6 z-50"
        animate={{ right: selectedNodeIds.size >= 2 ? 344 : 24 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
     >
        <Minimap nodes={nodes} activeId={activeNodeId} x={x} y={y} scale={scale} />
     </motion.div>
    </div>
  );
};
