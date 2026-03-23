
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Sparkles, GitBranch, RotateCw, AlertCircle, ChevronRight } from 'lucide-react';
import { GroupedNode } from '../utils/canvasLayout';

interface ContextComposerProps {
  selectedNodes: GroupedNode[];
  onClose: () => void;
  onRemoveNode: (nodeId: string) => void;
  synthesisText: string;
  onSynthesisTextChange: (text: string) => void;
  isSynthesizing: boolean;
  onSynthesize: () => void;
  onBranchFromComposed: () => void;
  error?: string;
  onRetry: () => void;
}

export const ContextComposer: React.FC<ContextComposerProps> = ({
  selectedNodes,
  onClose,
  onRemoveNode,
  synthesisText,
  onSynthesisTextChange,
  isSynthesizing,
  onSynthesize,
  onBranchFromComposed,
  error,
  onRetry,
}) => {
  const canSynthesize = selectedNodes.length >= 2 && !isSynthesizing;
  const canBranch = synthesisText.trim().length > 0 && !isSynthesizing;

  return (
    <motion.div
      className="fixed top-0 right-0 h-full w-[340px] bg-white border-l border-gray-200 shadow-2xl z-50 flex flex-col font-lexend"
      initial={{ x: '100%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '100%', opacity: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 40 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-violet-100 flex items-center justify-center">
            <Sparkles size={14} className="text-violet-600" />
          </div>
          <div>
            <h2 className="text-sm font-medium text-gray-800">Context Composer</h2>
            <p className="text-[10px] text-gray-400">Synthesize nodes into a new thread</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">

        {/* Selected nodes section */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">
              Selected Nodes ({selectedNodes.length}/8)
            </span>
            {selectedNodes.length < 2 && (
              <span className="text-[10px] text-amber-500">Select at least 2</span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {selectedNodes.map(node => (
              <div
                key={node.id}
                className="group flex items-start gap-2 bg-violet-50 border border-violet-100 rounded-xl p-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-violet-700 truncate">{node.title}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">
                    {node.preview.slice(0, 80)}{node.preview.length > 80 ? '...' : ''}
                  </p>
                </div>
                <button
                  onClick={() => onRemoveNode(node.id)}
                  className="flex-shrink-0 p-1 text-violet-300 hover:text-violet-600 hover:bg-violet-100 rounded-md transition-colors opacity-0 group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {selectedNodes.length === 0 && (
              <div className="text-center py-6 border-2 border-dashed border-gray-200 rounded-xl">
                <p className="text-xs text-gray-400">No nodes selected</p>
                <p className="text-[10px] text-gray-300 mt-1">Shift+click nodes on the canvas</p>
              </div>
            )}
          </div>
        </div>

        {/* Synthesize button */}
        <button
          onClick={onSynthesize}
          disabled={!canSynthesize}
          className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium transition-all ${
            canSynthesize
              ? 'bg-[#16A39B] hover:bg-[#138a83] text-white shadow-sm'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          {isSynthesizing ? (
            <>
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Synthesizing...
            </>
          ) : (
            <>
              <Sparkles size={15} />
              Synthesize Context
            </>
          )}
        </button>

        {/* Pulsing skeleton while synthesizing */}
        {isSynthesizing && (
          <div className="flex flex-col gap-2 animate-pulse">
            <div className="h-3 bg-gray-100 rounded-full w-full" />
            <div className="h-3 bg-gray-100 rounded-full w-5/6" />
            <div className="h-3 bg-gray-100 rounded-full w-4/6" />
            <div className="h-3 bg-gray-100 rounded-full w-full" />
            <div className="h-3 bg-gray-100 rounded-full w-3/4" />
          </div>
        )}

        {/* Error state */}
        {error && !isSynthesizing && (
          <div className="flex items-start gap-2.5 bg-red-50 border border-red-100 rounded-xl p-3">
            <AlertCircle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-red-600">{error}</p>
              <button
                onClick={onRetry}
                className="flex items-center gap-1 text-[10px] text-red-500 hover:text-red-700 mt-1.5 font-medium transition-colors"
              >
                <RotateCw size={10} />
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Synthesis result textarea */}
        {synthesisText && !isSynthesizing && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">
                Synthesized Context
              </span>
              <span className="text-[10px] text-gray-400">Editable</span>
            </div>
            <textarea
              value={synthesisText}
              onChange={e => onSynthesisTextChange(e.target.value)}
              className="w-full min-h-[140px] max-h-[240px] resize-y text-[12px] text-gray-700 leading-relaxed bg-gray-50 border border-gray-200 rounded-xl p-3 outline-none focus:border-violet-300 focus:ring-1 focus:ring-violet-100 transition-colors font-lexend"
              placeholder="Synthesis will appear here..."
            />
            <p className="text-[10px] text-gray-400 leading-relaxed">
              This will be your opening message in a new conversation thread. Edit if needed.
            </p>
          </div>
        )}
      </div>

      {/* Footer — Branch From This CTA */}
      <div className="flex-shrink-0 px-5 py-4 border-t border-gray-100 bg-gray-50/50">
        <button
          onClick={onBranchFromComposed}
          disabled={!canBranch}
          className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-medium transition-all ${
            canBranch
              ? 'bg-[linear-gradient(135deg,#7C3AED,#5B21B6)] hover:opacity-90 text-white shadow-md'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          <GitBranch size={15} />
          Branch From This
          {canBranch && <ChevronRight size={14} className="ml-auto" />}
        </button>
        {!canBranch && !isSynthesizing && (
          <p className="text-center text-[10px] text-gray-400 mt-2">
            Synthesize context first to enable branching
          </p>
        )}
      </div>
    </motion.div>
  );
};
