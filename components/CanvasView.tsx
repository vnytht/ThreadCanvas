
import React, { useMemo, useState, useRef, useEffect, memo, Dispatch, SetStateAction } from 'react';
import { Message, Author, Chapter } from '../types';
import { ZoomIn, ZoomOut, Maximize, Edit2, MessageSquare, Code, List, Sparkles, X } from 'lucide-react';
import { motion, useMotionValue, animate, MotionValue, useTransform, PanInfo, AnimatePresence } from 'framer-motion';
import {
    GroupedNode,
    NodePosition,
    groupMessages,
    calculateGroupLayout,
    getNodeStyles,
    getRelativeTime,
    GROUP_WIDTH,
    GROUP_HEIGHT,
    CANVAS_SIZE,
    CANVAS_CENTER,
    GRID_SIZE
} from '../utils/canvasLayout';

interface CanvasViewProps {
  messages: Message[];
  chapters: Chapter[];
  activeBranchHeadId: string;
  onNavigate: (msgId: string) => void;
  entryAnimation?: boolean;
  onUpdateNodeTitle?: (startMessageId: string, newTitle: string) => void;
  // Multi-select / Composer props
  selectedNodeIds: Set<string>;
  onNodeSelectionChange: (nodeId: string, selected: boolean) => void;
  onOpenComposer: () => void;
  onClearSelection: () => void;
}

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
                    const bgClass = node.isRoot ? 'bg-blue-400' : (node.isComposedContext ? 'bg-violet-400' : (isActive ? 'bg-emerald-400' : 'bg-gray-300'));
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
    onSelect: (nodeId: string) => void;
    setDraggingNodeId: (id: string | null) => void;
    isDragging: boolean;
    onUpdateNodeTitle?: (startMessageId: string, newTitle: string) => void;
    scale: MotionValue<number>;
}

const CanvasNode = memo(({ node, isActive, isHead, isSelected, setNodeOverrides, onNavigate, onSelect, setDraggingNodeId, isDragging, onUpdateNodeTitle, scale }: CanvasNodeProps) => {
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
            className={`absolute w-[280px] h-[160px] cursor-grab active:cursor-grabbing pointer-events-auto transition-opacity duration-300 opacity-100`}
            style={{
                x: CANVAS_CENTER + node.x,
                y: CANVAS_CENTER + node.y,
                zIndex: isDragging ? 50 : (isSelected ? 30 : (isActive ? 20 : 10))
            }}
            drag dragMomentum={false} dragElastic={0}
            onDrag={(e, info: PanInfo) => {
                const currentScale = scale.get();
                setNodeOverrides(prev => {
                    const currentPos = prev[node.id] ?? { x: node.x, y: node.y };
                    const rawX = currentPos.x + (info.delta.x / currentScale);
                    const rawY = currentPos.y + (info.delta.y / currentScale);
                    const snappedX = Math.round(rawX / GRID_SIZE) * GRID_SIZE;
                    const snappedY = Math.round(rawY / GRID_SIZE) * GRID_SIZE;
                    return { ...prev, [node.id]: { x: snappedX, y: snappedY } };
                });
            }}
            onDragStart={() => setDraggingNodeId(node.id)}
            onDragEnd={() => setDraggingNodeId(null)}
            onTap={(e) => {
                const nativeEvent = e as unknown as MouseEvent;
                const target = e.target as HTMLElement;
                if (target.closest('button') || target.closest('.timeline-item') || target.closest('input')) return;

                if (nativeEvent.shiftKey) {
                    // Shift+click = toggle selection for Composer
                    onSelect(node.id);
                } else {
                    // Normal click = navigate to this thread
                    let targetId = node.startMessageId;
                    if (node.messages[0].content === 'SYSTEM_ROOT' && node.messages.length > 1) {
                        targetId = node.messages[1].id;
                    }
                    onNavigate(targetId);
                }
            }}
            whileDrag={{ scale: 1.05, boxShadow: "0px 10px 20px rgba(0,0,0,0.15)" }}
        >
            <div
                className="w-full h-full rounded-[9px] flex flex-col p-[3px] font-lexend transition-all duration-200 relative"
                style={{
                    background: styles.outerBg,
                    outline: `${isSelected ? '2px' : '1px'} ${styles.outerBorder} ${styles.borderStyle}`,
                    outlineOffset: isSelected ? '2px' : '-1px'
                }}
            >
                {/* Selection ring overlay */}
                {isSelected && (
                    <div className="absolute inset-0 rounded-[9px] ring-2 ring-violet-500 ring-offset-1 pointer-events-none z-30" />
                )}

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
                            {node.isComposedContext && (
                                <span title="Composed Context">
                                    <Sparkles size={12} className="text-violet-400" />
                                </span>
                            )}
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

export const CanvasView: React.FC<CanvasViewProps> = ({
    messages,
    chapters,
    activeBranchHeadId,
    onNavigate,
    entryAnimation = false,
    onUpdateNodeTitle,
    selectedNodeIds,
    onNodeSelectionChange,
    onOpenComposer,
    onClearSelection
}) => {
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, NodePosition>>(() => {
      const saved = localStorage.getItem('threadcanvas_node_overrides');
      return saved ? JSON.parse(saved) : {};
  });
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
      localStorage.setItem('threadcanvas_node_overrides', JSON.stringify(nodeOverrides));
  }, [nodeOverrides]);

  // Show hint after 3s if user hasn't used the composer yet
  useEffect(() => {
      const hintShown = localStorage.getItem('threadcanvas_composer_hint_shown');
      if (hintShown) return;
      const timer = setTimeout(() => setShowHint(true), 3000);
      const hideTimer = setTimeout(() => setShowHint(false), 11000);
      return () => { clearTimeout(timer); clearTimeout(hideTimer); };
  }, []);

  // Escape key clears selection
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape' && selectedNodeIds.size > 0) {
              onClearSelection();
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeIds.size, onClearSelection]);

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

  const edges = useMemo(() => {
      const edgeList: Array<{sourceX: number, sourceY: number, targetX: number, targetY: number}> = [];
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
      });
      return edgeList;
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

  const handleZoomIn = () => animate(scale, Math.min(scale.get() * 1.5, 4));
  const handleZoomOut = () => animate(scale, Math.max(scale.get() / 1.5, 0.25));
  const handleFitView = () => animate(scale, 1);

  const activeNodeId = nodes.find(n => n.messages.some(m => m.id === activeBranchHeadId))?.id || activeBranchHeadId;

  const handleNodeSelect = (nodeId: string) => {
      // Mark hint as shown once user starts selecting
      localStorage.setItem('threadcanvas_composer_hint_shown', 'true');
      setShowHint(false);
      const isCurrentlySelected = selectedNodeIds.has(nodeId);
      // Max 8 nodes
      if (!isCurrentlySelected && selectedNodeIds.size >= 8) return;
      onNodeSelectionChange(nodeId, !isCurrentlySelected);
  };

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
            </svg>
            <div className="absolute inset-0 z-10 pointer-events-none">
                {nodes.map((node) => {
                    const isActive = node.messages.some(m => m.id === activeBranchHeadId);
                    const isHead = node.id === activeBranchHeadId || node.messages.some(m => m.id === activeBranchHeadId);
                    const isSelected = selectedNodeIds.has(node.id);
                    return (
                        <CanvasNode
                            key={node.id}
                            node={node}
                            isActive={isActive}
                            isHead={isHead}
                            isSelected={isSelected}
                            setNodeOverrides={setNodeOverrides}
                            onNavigate={onNavigate}
                            onSelect={handleNodeSelect}
                            setDraggingNodeId={setDraggingNodeId}
                            isDragging={draggingNodeId === node.id}
                            onUpdateNodeTitle={onUpdateNodeTitle}
                            scale={scale}
                        />
                    )
                })}
            </div>
       </motion.div>

      {/* Zoom Controls */}
      <div className="absolute bottom-6 left-6 z-50 flex flex-col gap-3 pointer-events-auto">
         <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-1 flex items-center self-start">
            <button onClick={handleZoomOut} className="p-2 hover:bg-gray-50 rounded-md text-gray-500 transition-colors"><ZoomOut size={16}/></button>
            <div className="w-[1px] h-4 bg-gray-100 mx-1"></div>
            <button onClick={handleFitView} className="p-2 hover:bg-gray-50 rounded-md text-gray-500 transition-colors"><Maximize size={16}/></button>
            <div className="w-[1px] h-4 bg-gray-100 mx-1"></div>
            <button onClick={handleZoomIn} className="p-2 hover:bg-gray-50 rounded-md text-gray-500 transition-colors"><ZoomIn size={16}/></button>
         </div>
      </div>

      {/* Minimap */}
      <div className="absolute bottom-6 right-6 z-50">
         <Minimap nodes={nodes} activeId={activeNodeId} x={x} y={y} scale={scale} />
      </div>

      {/* Hint text — appears after 3s, disappears after 8s, never shows again once composer used */}
      <AnimatePresence>
          {showHint && selectedNodeIds.size === 0 && nodes.length > 1 && (
              <motion.div
                  className="absolute bottom-[88px] left-1/2 -translate-x-1/2 z-40 pointer-events-none"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.6 }}
              >
                  <span className="text-[11px] text-gray-400 font-lexend bg-white/90 backdrop-blur-sm px-3 py-1.5 rounded-full border border-gray-100 shadow-sm">
                      Hold Shift + click nodes to compose context across branches
                  </span>
              </motion.div>
          )}
      </AnimatePresence>

      {/* Floating selection action bar */}
      <AnimatePresence>
          {selectedNodeIds.size > 0 && (
              <motion.div
                  className="absolute bottom-[88px] left-1/2 -translate-x-1/2 z-50 pointer-events-auto"
                  initial={{ y: 16, opacity: 0, scale: 0.96 }}
                  animate={{ y: 0, opacity: 1, scale: 1 }}
                  exit={{ y: 16, opacity: 0, scale: 0.96 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
              >
                  <div className="bg-white border border-violet-200 shadow-xl rounded-2xl px-4 py-2.5 flex items-center gap-3">
                      <span className="text-xs text-gray-500 font-lexend">
                          <span className="font-semibold text-violet-600">{selectedNodeIds.size}</span> node{selectedNodeIds.size > 1 ? 's' : ''} selected
                      </span>
                      <div className="w-[1px] h-4 bg-gray-200" />
                      <button
                          onClick={onOpenComposer}
                          className="flex items-center gap-1.5 bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shadow-sm"
                      >
                          <Sparkles size={13} />
                          Compose Context
                      </button>
                      <button
                          onClick={onClearSelection}
                          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                          title="Clear selection (Esc)"
                      >
                          <X size={14} />
                      </button>
                  </div>
              </motion.div>
          )}
      </AnimatePresence>
    </div>
  );
};
