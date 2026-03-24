
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Sparkles, GitBranch, RotateCw, Layers } from 'lucide-react';
import { synthesizeContextFromNodes } from '../services/gemini';
import type { GroupedNode } from './CanvasView';

interface ContextComposerProps {
  selectedNodes: GroupedNode[];
  onRemoveNode: (id: string) => void;
  onClear: () => void;
  onBranchFromThis: (synthesizedText: string, sourceNodeIds: string[]) => void;
  preferredBackend: 'GEMINI' | 'OLLAMA';
}

export const ContextComposer: React.FC<ContextComposerProps> = ({
  selectedNodes,
  onRemoveNode,
  onClear,
  onBranchFromThis,
  preferredBackend,
}) => {
  const [synthesis, setSynthesis] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedText, setEditedText] = useState('');

  const handleSynthesize = async () => {
    setIsLoading(true);
    setError(null);
    setSynthesis(null);

    // Collect tail messages from each selected node (most complete message per node)
    const fragments = selectedNodes.flatMap(node =>
      node.messages
        .filter(m => m.content && m.content !== 'SYSTEM_ROOT')
        .map(m => ({
          role: m.author === 'USER' ? 'user' : 'assistant',
          content: m.content,
        }))
    );

    try {
      const result = await synthesizeContextFromNodes(fragments, preferredBackend);
      if (result.startsWith('[Context synthesis unavailable')) {
        setError(result);
      } else {
        setSynthesis(result);
        setEditedText(result);
      }
    } catch (e) {
      setError('Synthesis failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBranch = () => {
    if (editedText.trim()) {
      const sourceNodeIds = selectedNodes.map(n => n.id);
      onBranchFromThis(editedText.trim(), sourceNodeIds);
    }
  };

  return (
    <motion.div
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      className="absolute right-0 top-0 bottom-0 w-80 z-50 bg-white border-l border-gray-200 shadow-xl flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Layers size={15} className="text-indigo-500" />
          <span className="text-[13px] font-lexend font-medium text-gray-800">Context Composer</span>
          <span className="bg-indigo-100 text-indigo-600 text-[10px] font-lexend font-semibold px-1.5 py-0.5 rounded-full">
            {selectedNodes.length}
          </span>
        </div>
        <button
          onClick={onClear}
          className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"
          title="Clear selection"
        >
          <X size={14} />
        </button>
      </div>

      {/* Node List */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-0">
        <p className="text-[10px] text-gray-400 font-lexend uppercase tracking-wider mb-1">Selected Nodes</p>
        {selectedNodes.map(node => {
          const tailMsg = node.messages.filter(m => m.content && m.content !== 'SYSTEM_ROOT').slice(-1)[0];
          const preview = tailMsg ? tailMsg.content.slice(0, 80) + (tailMsg.content.length > 80 ? '…' : '') : '(empty)';
          return (
            <div key={node.id} className="group relative bg-gray-50 border border-gray-200 rounded-lg p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-lexend font-medium text-gray-700 truncate">{node.title}</p>
                  <p className="text-[10px] font-lexend text-gray-400 mt-0.5 leading-relaxed line-clamp-2">{preview}</p>
                </div>
                <button
                  onClick={() => onRemoveNode(node.id)}
                  className="flex-shrink-0 p-1 text-gray-300 hover:text-red-400 rounded transition-colors mt-0.5"
                  title="Remove from selection"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          );
        })}

        {/* Synthesis Area */}
        {(synthesis !== null || isLoading || error) && (
          <div className="mt-2">
            <p className="text-[10px] text-gray-400 font-lexend uppercase tracking-wider mb-1.5">Synthesized Context</p>
            {isLoading && (
              <div className="space-y-2 animate-pulse">
                <div className="h-3 bg-gray-200 rounded w-full" />
                <div className="h-3 bg-gray-200 rounded w-5/6" />
                <div className="h-3 bg-gray-200 rounded w-4/6" />
                <div className="h-3 bg-gray-200 rounded w-full" />
                <div className="h-3 bg-gray-200 rounded w-3/4" />
              </div>
            )}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-[11px] text-red-600 font-lexend leading-relaxed">{error}</p>
                <button
                  onClick={handleSynthesize}
                  className="mt-2 flex items-center gap-1 text-[11px] font-lexend text-red-500 hover:text-red-700 transition-colors"
                >
                  <RotateCw size={11} /> Retry
                </button>
              </div>
            )}
            {synthesis !== null && !isLoading && (
              <textarea
                value={editedText}
                onChange={e => setEditedText(e.target.value)}
                className="w-full text-[12px] font-lexend font-light text-gray-700 leading-relaxed border border-gray-200 rounded-lg p-3 resize-none outline-none focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 bg-white"
                rows={8}
                spellCheck={false}
              />
            )}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="flex-shrink-0 p-3 border-t border-gray-100 flex flex-col gap-2">
        {/* Synthesize button */}
        {synthesis === null && (
          <button
            onClick={handleSynthesize}
            disabled={isLoading || selectedNodes.length < 2}
            className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-lexend font-medium transition-all ${
              isLoading || selectedNodes.length < 2
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-sm hover:shadow'
            }`}
          >
            {isLoading ? (
              <>
                <RotateCw size={14} className="animate-spin" />
                Synthesizing…
              </>
            ) : (
              <>
                <Sparkles size={14} />
                Synthesize Context
              </>
            )}
          </button>
        )}

        {/* Re-synthesize + Branch From This */}
        {synthesis !== null && (
          <>
            <button
              onClick={handleBranch}
              disabled={!editedText.trim()}
              className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-[13px] font-lexend font-medium transition-all ${
                editedText.trim()
                  ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm hover:shadow'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              <GitBranch size={14} />
              Branch From This
            </button>
            <button
              onClick={handleSynthesize}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-[12px] font-lexend text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <RotateCw size={12} />
              Re-synthesize
            </button>
          </>
        )}

        {/* Clear */}
        <button
          onClick={onClear}
          className="w-full text-[11px] font-lexend text-gray-400 hover:text-gray-600 py-1 transition-colors"
        >
          Clear selection
        </button>
      </div>
    </motion.div>
  );
};
