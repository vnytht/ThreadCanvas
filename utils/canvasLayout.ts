
import { Message, Author, Chapter } from '../types';

// --- Types ---

export interface NodePosition {
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
  depth: number;
  title: string;
  preview: string;
  hasCode: boolean;
  hasList: boolean;
  language?: string;
  timestamp: number;
  internalChapters: Chapter[]; // Chapters contained within this node
  isRoot: boolean;
  isComposedContext?: boolean; // True if this node was created by the Composer
}

// --- Constants ---
export const GROUP_WIDTH = 280;
export const GROUP_HEIGHT = 160;
export const X_SPACING = 340;
export const Y_SPACING = 190;
export const CANVAS_SIZE = 50000;
export const CANVAS_CENTER = CANVAS_SIZE / 2;
export const GRID_SIZE = 25;

// --- Helper Functions ---

export const getNodeStyles = (isRoot: boolean, isActive: boolean, isComposedContext?: boolean) => {
    if (isComposedContext) {
        return {
            outerBg: '#F5F3FF',
            outerBorder: '#7C3AED',
            innerBg: '#F5F3FF',
            borderStyle: 'dashed' as const
        };
    }
    if (isRoot) {
        return {
            outerBg: '#F0F6FF',
            outerBorder: '#61A6FB',
            innerBg: '#F0F6FF',
            borderStyle: 'solid' as const
        };
    }
    if (isActive) {
        return {
            outerBg: '#ECFEF6',
            outerBorder: '#34D399',
            innerBg: '#ECFEF6',
            borderStyle: 'solid' as const
        };
    }
    return {
        outerBg: '#FBFCFD',
        outerBorder: '#DCDFEA',
        innerBg: '#FBFCFD',
        borderStyle: 'solid' as const
    };
};

export const getRelativeTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'Just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
};

export const cleanTextPreview = (text: string) => {
    return text
        .replace(/^Sure, I can help.*/i, '')
        .replace(/^Here is the.*/i, '')
        .replace(/^Certainly!.*/i, '')
        .replace(/^I'd be happy to.*/i, '')
        .replace(/\*\*/g, '')
        .replace(/^SYSTEM_ROOT$/i, '')
        .trim();
};

export const extractCodeSnippet = (text: string): { lang: string, snippet: string } | null => {
    const match = text.match(/```(\w+)?\n([\s\S]*?)```/);
    if (match) {
        const lang = match[1] || 'Code';
        const lines = match[2].split('\n').filter(l => l.trim().length > 0).slice(0, 3);
        return { lang, snippet: lines.join('\n') };
    }
    return null;
};

export const extractListPreview = (text: string): string | null => {
    const listItems = text.match(/^[-*•] .+$|^\d+\. .+$/gm);
    if (listItems && listItems.length > 0) {
        return listItems.slice(0, 2).join('\n');
    }
    return null;
};

export const groupMessages = (allMessages: Message[], chapters: Chapter[]): GroupedNode[] => {
    if (allMessages.length === 0) return [];
    const childrenMap = new Map<string, string[]>();
    const messageMap = new Map<string, Message>();
    let rootId: string | null = null;
    allMessages.forEach(m => {
        messageMap.set(m.id, m);
        if (m.parentId) {
            if (!childrenMap.has(m.parentId)) childrenMap.set(m.parentId, []);
            childrenMap.get(m.parentId)?.push(m.id);
        } else {
            rootId = m.id;
        }
    });
    if (!rootId) return [];
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
        const isRootNode = currentGroupMessages[0].id === rootId;
        const firstUserMsg = currentGroupMessages.find(m => m.author === Author.USER);
        const lastAiMsg = [...currentGroupMessages].reverse().find(m => m.author === Author.ASSISTANT);
        const groupMessageIds = new Set(currentGroupMessages.map(m => m.id));
        const internalChapters = chapters.filter(c => groupMessageIds.has(c.startMessageId));
        const mainChapter = internalChapters.length > 0 ? internalChapters[internalChapters.length - 1] : null;

        let title = "";
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

        // Check if any message in this group is a composed context
        const isComposed = currentGroupMessages.some(m => m.isComposedContext);

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
            isComposedContext: isComposed
        };
        groups.push(node);
        const tailChildren = childrenMap.get(tailMsg.id) || [];
        tailChildren.forEach(childId => {
            const childGroupId = buildGroup(childId, depth + 1);
            if (childGroupId) node.childrenIds.push(childGroupId);
        });
        return node.id;
    };
    buildGroup(rootId, 0);
    return groups;
};

export const calculateGroupLayout = (groups: GroupedNode[]) => {
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
    return groups;
};
