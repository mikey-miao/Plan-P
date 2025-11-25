/**
 * ProjectSorter.tsx
 * ---------------------------------------------------------------------------
 * 层级项目清单组件，强调透明度递进形成的纵深感。
 *
 * [变更要点]
 * 1. 布局：采用纵向 Flex，顶部工具条固定，列表独立滚动避免穿透。
 * 2. 尺寸：容器约束在 350px × 450px，方便嵌入演示。
 * 3. 紧凑：针对窄视窗压缩内边距与间距。
 */

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect, useMemo } from 'react';
import type { FC, CSSProperties, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { 
  ChevronRight, 
  ChevronDown, 
  Plus, 
  Trash2, 
  Eye,
  EyeOff,
  Circle,
  Check
} from 'lucide-react';

const DATA_STORAGE_KEY = 'project-sort-data-v37';
const SETTINGS_STORAGE_KEY = 'project-sort-settings-v2';
const MIN_NODE_WIDTH = 180;

type MoveDirection = 'up' | 'down' | 'left' | 'right';
type OpacityMode = 1 | 2 | 3;
type InsertPosition = 'before' | 'after' | 'inside';
type ScrollDirection = -1 | 0 | 1;
type TreeOpenState = 'all-open' | 'all-closed' | 'mixed';

const TRANSPARENT_DRAG_IMAGE = (() => {
  if (typeof Image === 'undefined') return null;
  const img = new Image();
  img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
  return img;
})();

interface TreeItem {
  id: string;
  title: string;
  isOpen?: boolean;
  children: TreeItem[];
}

interface TreeContext {
  list: TreeItem[];
  index: number;
  node: TreeItem;
  parent: TreeItem | null;
}

interface TreeNodeProps {
  item: TreeItem;
  index: number;
  level: number;
  parentOpacity: number;
  enableOpacity: boolean;
  opacityMode: OpacityMode;
  deleteConfirmId: string | null;
  deletingAncestor: boolean;
  selectedId: string | null;
  draggingId: string | null;
  lengthWarningId: string | null;
  lengthWarningExcess: number | null;
  pendingEditId: string | null;
  onToggle: (id: string) => void;
  onAdd: (parentId: string | null, level: number) => void;
  onDeleteRequest: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onSelect: (id: string) => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string, position: InsertPosition) => void;
  onPreviewMove: (id: string, position: InsertPosition) => void;
  onDragEnd: () => void;
  onResolvePendingEdit: (id: string) => void;
}

const FALLBACK_DATA: TreeItem[] = [
  {
    id: 'launch-plan',
    title: '项目启动',
    isOpen: true,
    children: [
      {
        id: 'scope-define',
        title: '范围梳理',
        isOpen: true,
        children: [
          { id: 'stakeholder-sync', title: '干系人同步', isOpen: true, children: [] }
        ]
      }
    ]
  },
  {
    id: 'mid-review',
    title: '中期评审',
    isOpen: true,
    children: [
      {
        id: 'draft-output',
        title: '方案初稿',
        isOpen: true,
        children: [
          { id: 'risk-check', title: '风险检查', isOpen: true, children: [] }
        ]
      }
    ]
  },
  {
    id: 'release-track',
    title: '发布跟踪',
    isOpen: true,
    children: [
      {
        id: 'test-pass',
        title: '测试验证',
        isOpen: true,
        children: [
          { id: 'rollback-ready', title: '回滚预案确认', isOpen: true, children: [] }
        ]
      }
    ]
  }
];

const DEFAULT_SETTINGS: { enableOpacity: boolean; opacityMode: OpacityMode } = {
  enableOpacity: true,
  opacityMode: 2
};
const MAX_TITLE_LENGTH = 36;
const PLACEHOLDER_TITLE = '新项目';
const MAX_DEPTH = 5;
const TREE_STATE_ICON_PATHS: Record<TreeOpenState, string> = {
  'all-open': '/icons/Expand.svg',
  'all-closed': '/icons/Collapse.svg',
  mixed: '/icons/Random.svg'
};
const TREE_STATE_ICON_HOVER_PATHS: Record<TreeOpenState, string> = {
  'all-open': '/icons/Expand_hover.svg',
  'all-closed': '/icons/Collapse_hover.svg',
  mixed: '/icons/Random_hover.svg'
};

// --- ID 工具集 ---
const generateId = (): string => Math.random().toString(36).slice(2, 11);
const generateUniqueId = (used: Set<string>): string => {
  let next = generateId();
  while (used.has(next)) next = generateId();
  used.add(next);
  return next;
};
const collectIds = (nodes: TreeItem[], used = new Set<string>()): Set<string> => {
  for (const node of nodes) {
    if (node.id) used.add(node.id);
    if (node.children) collectIds(node.children, used);
  }
  return used;
};
const normalizeTreeIds = (nodes: TreeItem[]): { tree: TreeItem[]; usedIds: Set<string>; changed: boolean } => {
  const usedIds = new Set<string>();
  let changed = false;
  const walk = (list: TreeItem[]): TreeItem[] =>
    list.map(node => {
      let nextId = node.id;
      if (!nextId || usedIds.has(nextId)) {
        nextId = generateUniqueId(usedIds);
        changed = true;
      } else {
        usedIds.add(nextId);
      }
      return { ...node, id: nextId, children: node.children ? walk(node.children) : [] };
    });
  return { tree: walk(nodes), usedIds, changed };
};

const getNodeMaxDepth = (node: TreeItem): number =>
  1 + (node.children.length ? Math.max(...node.children.map(getNodeMaxDepth)) : 0);

interface TreeContextWithDepth extends TreeContext {
  depth: number;
}

const findContextByIdWithDepth = (
  nodes: TreeItem[],
  targetId: string,
  depth = 0,
  parent: TreeItem | null = null
): TreeContextWithDepth | null => {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === targetId) return { list: nodes, index: i, node: nodes[i], parent, depth };
    if (nodes[i].children) {
      const res = findContextByIdWithDepth(nodes[i].children, targetId, depth + 1, nodes[i]);
      if (res) return res;
    }
  }
  return null;
};

const getTitleStyle = (selected: boolean): CSSProperties =>
  selected
    ? {
        whiteSpace: 'pre-wrap',
        overflow: 'hidden',
        display: 'block',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere'
      }
    : {
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      };
const formatTitle = (title: string, selected: boolean): string => {
  const effectiveTitle = title.trim() ? title : PLACEHOLDER_TITLE;
  return selected || effectiveTitle.length <= MAX_TITLE_LENGTH
    ? effectiveTitle
    : `${effectiveTitle.slice(0, MAX_TITLE_LENGTH)}…`;
};

const findContextById = (nodes: TreeItem[], targetId: string, parent: TreeItem | null = null): TreeContext | null => {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === targetId) return { list: nodes, index: i, node: nodes[i], parent };
    if (nodes[i].children) {
      const res = findContextById(nodes[i].children, targetId, nodes[i]);
      if (res) return res;
    }
  }
  return null;
};
const containsId = (node: TreeItem, targetId: string): boolean => {
  if (node.id === targetId) return true;
  return node.children?.some(child => containsId(child, targetId)) ?? false;
};

const ensureNodeOpenById = (nodes: TreeItem[], targetId: string): { tree: TreeItem[]; changed: boolean } => {
  let changed = false;
  const walk = (list: TreeItem[]): TreeItem[] =>
    list.map(node => {
      if (node.id === targetId) {
        if (node.isOpen) return node;
        changed = true;
        return { ...node, isOpen: true };
      }
      if (!node.children?.length) return node;
      const nextChildren = walk(node.children);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }
      return node;
    });
  const tree = walk(nodes);
  return { tree, changed };
};
const setAllNodesOpen = (nodes: TreeItem[], open: boolean): TreeItem[] =>
  nodes.map(node => ({
    ...node,
    isOpen: open,
    children: node.children ? setAllNodesOpen(node.children, open) : []
  }));

const getTreeOpenState = (nodes: TreeItem[]): TreeOpenState => {
  if (!nodes.length) return 'all-closed';
  let hasOpen = false;
  let hasClosed = false;
  const walk = (list: TreeItem[]) => {
    for (const node of list) {
      if (node.isOpen) hasOpen = true;
      else hasClosed = true;
      if (node.children?.length) walk(node.children);
      if (hasOpen && hasClosed) return;
    }
  };
  walk(nodes);
  if (hasOpen && hasClosed) return 'mixed';
  if (hasOpen) return 'all-open';
  return 'all-closed';
};

const TreeStateIcon: FC<{ state: TreeOpenState }> = ({ state }) => (
  <span className="relative inline-flex items-center justify-center">
    <img
      src={TREE_STATE_ICON_PATHS[state]}
      alt={state}
      width={16}
      height={16}
      className="w-4 h-4 group-hover:hidden"
      draggable={false}
    />
    <img
      src={TREE_STATE_ICON_HOVER_PATHS[state]}
      alt={`${state}-hover`}
      width={16}
      height={16}
      className="w-4 h-4 hidden group-hover:block"
      draggable={false}
    />
  </span>
);

const canPlaceNode = (tree: TreeItem[], dragId: string, targetId: string, position: InsertPosition): boolean => {
  const dragCtx = findContextByIdWithDepth(tree, dragId);
  const targetCtx = findContextByIdWithDepth(tree, targetId);
  if (!dragCtx || !targetCtx) return false;
  const dragHeight = getNodeMaxDepth(dragCtx.node);
  let baseDepth = targetCtx.depth;
  if (position === 'inside') baseDepth = targetCtx.depth + 1;
  return baseDepth + dragHeight - 1 < MAX_DEPTH;
};

const moveNodeInTree = (data: TreeItem[], dragId: string, targetId: string, position: InsertPosition): TreeItem[] | null => {
  if (!dragId || dragId === targetId) return null;
  const newData = JSON.parse(JSON.stringify(data)) as TreeItem[];
  const dragCtx = findContextById(newData, dragId);
  const dropCtx = findContextById(newData, targetId);
  if (!dragCtx || !dropCtx || containsId(dragCtx.node, targetId)) return null;

  const { list: fromList, index: fromIndex } = dragCtx;
  const { list: targetList, index: dropIndex } = dropCtx;

  if (position === 'inside') {
    fromList.splice(fromIndex, 1);
    if (!dropCtx.node.children) dropCtx.node.children = [];
    dropCtx.node.children.push(dragCtx.node);
    dropCtx.node.isOpen = true;
    return newData;
  }

  let to = position === 'before' ? dropIndex : dropIndex + 1;
  fromList.splice(fromIndex, 1);
  if (fromList === targetList && fromIndex < to) to -= 1;
  targetList.splice(to, 0, dragCtx.node);
  return newData;
};

// --- ProjectSorter 主界面 ---

const ProjectSorter: FC = () => {
  const [data, setData] = useState<TreeItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [enableOpacity, setEnableOpacity] = useState(DEFAULT_SETTINGS.enableOpacity);
  const [opacityMode, setOpacityMode] = useState<OpacityMode>(DEFAULT_SETTINGS.opacityMode);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [lengthWarning, setLengthWarning] = useState<{ id: string; excess: number } | null>(null);
  const treeOpenState = useMemo(() => getTreeOpenState(data), [data]);

  const dataInitializedRef = useRef(false);
  const settingsInitializedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollDirectionRef = useRef<ScrollDirection>(0);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
      return () => {
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      };
  }, []);

  // 初始化：流程复用旧逻辑，这里仅保留关键步骤注解
  useEffect(() => {
    const saved = localStorage.getItem(DATA_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setData(normalizeTreeIds(parsed).tree);
          dataInitializedRef.current = true;
          return;
        }
      } catch (e) {}
    }
    setData(FALLBACK_DATA);
    dataInitializedRef.current = true;
  }, []);

  useEffect(() => {
    if (dataInitializedRef.current) localStorage.setItem(DATA_STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  useEffect(() => {
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (saved) {
        try {
            const p = JSON.parse(saved);
            setEnableOpacity(p.enableOpacity ?? true);
            setOpacityMode(p.opacityMode ?? 2);
            settingsInitializedRef.current = true;
            return;
        } catch(e){}
    }
    setEnableOpacity(DEFAULT_SETTINGS.enableOpacity);
    setOpacityMode(DEFAULT_SETTINGS.opacityMode);
    settingsInitializedRef.current = true;
  }, []);

  useEffect(() => {
    if (settingsInitializedRef.current) localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ enableOpacity, opacityMode }));
  }, [enableOpacity, opacityMode]);

  useEffect(() => {
    const s = document.createElement('style');
    s.textContent = `@keyframes drag-slide { from { transform: translateY(2px); } to { transform: translateY(0); } }`;
    document.head.appendChild(s);
    return () => s.remove();
  }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.delete-action-area')) setDeleteConfirmId(null);
      if (!(e.target as HTMLElement).closest('.project-item')) setSelectedId(null);
    };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, []);

  const moveItem = useCallback((dir: MoveDirection) => {
    if (!selectedId) return;
    setData(prev => {
        const newData = JSON.parse(JSON.stringify(prev));
        const ctx = findContextByIdWithDepth(newData, selectedId);
        if (!ctx) return prev;
        const { list, index, node, depth } = ctx;
        const parent = ctx.parent;
        const nodeHeight = getNodeMaxDepth(node);
        if (dir === 'up' && index > 0) [list[index], list[index-1]] = [list[index-1], list[index]];
        else if (dir === 'down' && index < list.length - 1) [list[index], list[index+1]] = [list[index+1], list[index]];
        else if (dir === 'right' && index < list.length - 1) {
            const sibling = list[index + 1];
            if (!sibling) return prev;
            const parentCtx = findContextByIdWithDepth(newData, sibling.id);
            if (!parentCtx) return prev;
            const baseDepth = parentCtx.depth + 1;
            if (baseDepth + nodeHeight - 1 >= MAX_DEPTH) return prev;
            list.splice(index, 1);
            if (!parentCtx.node.children) parentCtx.node.children = [];
            parentCtx.node.children.unshift(node);
            parentCtx.node.isOpen = true;
        }
        else if (dir === 'left' && parent) {
            const pCtx = findContextById(newData, parent.id);
            if (pCtx) {
                list.splice(index, 1);
                pCtx.list.splice(pCtx.index, 0, node);
            }
        }
        else return prev;
        return newData;
    });
  }, [selectedId]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
        if (!selectedId || (e.target as HTMLElement).tagName === 'INPUT') return;
        if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); }
        if (e.key === 'ArrowUp') moveItem('up');
        if (e.key === 'ArrowDown') moveItem('down');
        if (e.key === 'ArrowRight') moveItem('right');
        if (e.key === 'ArrowLeft') moveItem('left');
        if (e.key === 'Enter') setSelectedId(null);
    };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); };
  }, [selectedId, moveItem]);

  const toggleOpen = (id: string) => setData(prev => {
    const rec = (nodes: TreeItem[]): TreeItem[] => nodes.map(n => ({ ...n, isOpen: n.id === id ? !n.isOpen : n.isOpen, children: rec(n.children) }));
    return rec(prev);
  });

  const handleAdd = (parentId: string | null, parentLevel: number) => {
    if (parentId && parentLevel >= MAX_DEPTH - 1) return;
    setSelectedId(null);
    setData(prev => {
        const u = collectIds(prev);
        const n: TreeItem = { id: generateUniqueId(u), title: '', isOpen: true, children: [] };
        setTimeout(() => {
          setSelectedId(n.id);
          setPendingEditId(n.id);
        }, 50);
        if (!parentId) return [...prev, n];
        const rec = (nodes: TreeItem[]): TreeItem[] => nodes.map(node => node.id === parentId ? { ...node, isOpen: true, children: [...node.children, n] } : { ...node, children: rec(node.children) });
        return rec(prev);
    });
  };

  const handleSelect = (id: string) => {
    setSelectedId(prev => (prev === id ? null : id));
    setData(prev => {
      const { tree, changed } = ensureNodeOpenById(prev, id);
      return changed ? tree : prev;
    });
  };

  const handleToggleAllNodes = () => {
    setData(prev => {
      if (!prev.length) return prev;
      if (treeOpenState === 'all-open') return setAllNodesOpen(prev, false);
      if (treeOpenState === 'all-closed') return setAllNodesOpen(prev, true);
      return setAllNodesOpen(prev, true);
    });
  };

  const handleDeleteRequest = (id: string) => {
    if (findContextById(data, id)?.node.children.length) setDeleteConfirmId(id);
    else confirmDelete(id);
  };

  const triggerLengthWarning = (id: string, excess: number) => {
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    setLengthWarning({ id, excess });
    warningTimerRef.current = setTimeout(() => {
      setLengthWarning(prev => (prev?.id === id ? null : prev));
    }, 2000);
  };

  const handleRename = (id: string, newTitle: string) => {
    const rawTitle = newTitle.trim() || '未命名节点';
    const sanitizedTitle = rawTitle.slice(0, MAX_TITLE_LENGTH);
    setData(prev => {
      const rec = (nodes: TreeItem[]): TreeItem[] =>
        nodes.map(node =>
          node.id === id ? { ...node, title: sanitizedTitle } : { ...node, children: rec(node.children) }
        );
      return rec(prev);
    });
    const excess = Math.max(0, rawTitle.length - MAX_TITLE_LENGTH);
    if (excess > 0) triggerLengthWarning(id, excess);
    else if (lengthWarning?.id === id) setLengthWarning(null);
  };

  const handleClearAll = () => {
    setData([]);
    setSelectedId(null);
    setDeleteConfirmId(null);
    setDraggingId(null);
    setShowClearAllConfirm(false);
  };

  const confirmDelete = (id: string) => {
    const rec = (nodes: TreeItem[]): TreeItem[] => nodes.filter(n => n.id !== id).map(n => ({ ...n, children: rec(n.children) }));
    setData(prev => rec(prev));
    setDeleteConfirmId(null);
    if (selectedId === id) setSelectedId(null);
  };

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    autoScrollDirectionRef.current = 0;
  }, []);

  const ensureAutoScrollLoop = useCallback(() => {
    if (autoScrollFrameRef.current) return;
    const step = () => {
      if (!autoScrollDirectionRef.current || !listRef.current) {
        stopAutoScroll();
        return;
      }
      listRef.current.scrollBy({ top: autoScrollDirectionRef.current * 4, behavior: 'auto' });
      autoScrollFrameRef.current = requestAnimationFrame(step);
    };
    autoScrollFrameRef.current = requestAnimationFrame(step);
  }, [stopAutoScroll]);

  const updateAutoScrollDirection = useCallback((dir: ScrollDirection) => {
    if (autoScrollDirectionRef.current === dir) return;
    autoScrollDirectionRef.current = dir;
    if (dir === 0) stopAutoScroll();
    else ensureAutoScrollLoop();
  }, [ensureAutoScrollLoop, stopAutoScroll]);

  const DEAD_ZONE_RATIO = 0.8;

  const computeScrollDirection = useCallback((clientY: number): ScrollDirection => {
    if (!listRef.current) return 0;
    const rect = listRef.current.getBoundingClientRect();
    const padding = rect.height * (1 - DEAD_ZONE_RATIO) / 2;
    const deadZoneTop = rect.top + padding;
    const deadZoneBottom = rect.bottom - padding;
    if (clientY >= deadZoneTop && clientY <= deadZoneBottom) return 0;
    return clientY < deadZoneTop ? -1 : 1;
  }, []);

  const handleListDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!draggingId || !listRef.current) return;
    e.preventDefault();
    updateAutoScrollDirection(computeScrollDirection(e.clientY));
  }, [draggingId, computeScrollDirection, updateAutoScrollDirection]);

  const handleListDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!listRef.current) return;
    const related = e.relatedTarget as Node | null;
    if (!related) return; // 边缘滚动逻辑由全局 dragover 统一处理
    if (!listRef.current.contains(related)) updateAutoScrollDirection(0);
  }, [updateAutoScrollDirection]);

  const handleListDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    updateAutoScrollDirection(0);
    stopAutoScroll();
    setDraggingId(null);
    setSelectedId(null);
  }, [stopAutoScroll, updateAutoScrollDirection]);

  const handleDragStart = (id: string) => {
    setDraggingId(id);
    setSelectedId(null);
  };
  const handleDropOn = (tid: string, pos: InsertPosition) => {
    if (!draggingId || draggingId === tid) return;
    setData(prev => {
      if (!canPlaceNode(prev, draggingId, tid, pos)) return prev;
      return moveNodeInTree(prev, draggingId, tid, pos) || prev;
    });
    setDraggingId(null);
    setSelectedId(null);
    stopAutoScroll();
  };
  const handlePreviewMove = (tid: string, pos: InsertPosition) => {
    if (draggingId && draggingId !== tid) {
      setData(prev => {
        if (!canPlaceNode(prev, draggingId, tid, pos)) return prev;
        return moveNodeInTree(prev, draggingId, tid, pos) || prev;
      });
    }
  };
  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setSelectedId(null);
    stopAutoScroll();
  }, [stopAutoScroll]);

  useEffect(() => {
    if (!draggingId) return;
    const handleWindowDragOver = (event: DragEvent) => {
      if (!listRef.current) return;
      event.preventDefault();
      updateAutoScrollDirection(computeScrollDirection(event.clientY));
    };
    const handleWindowDrop = (event: DragEvent) => {
      const targetNode = event.target as Node | null;
      const insideList = !!(targetNode && listRef.current?.contains(targetNode));
      if (!insideList) {
        setSelectedId(null);
        setDraggingId(null);
        updateAutoScrollDirection(0);
        stopAutoScroll();
      }
    };
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);
    window.addEventListener('dragend', handleWindowDrop);
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
      window.removeEventListener('dragend', handleWindowDrop);
      updateAutoScrollDirection(0);
      stopAutoScroll();
    };
  }, [draggingId, updateAutoScrollDirection, stopAutoScroll, computeScrollDirection]);

  useEffect(() => {
    if (!draggingId) return;
    const handleWheelWhileDragging = (event: WheelEvent) => {
      if (!listRef.current) return;
      event.preventDefault();
      listRef.current.scrollBy({ top: event.deltaY, behavior: 'auto' });
    };
    window.addEventListener('wheel', handleWheelWhileDragging, { passive: false });
    return () => window.removeEventListener('wheel', handleWheelWhileDragging);
  }, [draggingId]);

  return (
    <div
      className="bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#F0F4FF] via-white to-[#E6F0FF] text-slate-800 font-sans selection:bg-[#D4E3FD]"
      style={{ 
        width: '350px',
        height: '450px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
        {/* --- 1. 顶部工具条：静止区域 --- */}
        <div
          className="flex-shrink-0 flex justify-between items-center px-3"
          style={{ height: '50px', marginTop: '8px', marginBottom: '8px'}}
        >
            {/* 左上角图标 */}
            <div className="flex items-center" style={{ marginLeft: '12px' }}>
                <img 
                    src="/icons.png" 
                    alt="Plan P" 
                    className="w-8 h-8 rounded-lg shadow-sm"
                    style={{ objectFit: 'contain' }}
                />
            </div>

            {/* 右侧工具栏 */}
            <div className="flex items-center gap-1.5 p-1 bg-white/70 backdrop-blur-xl rounded-full border border-white/50 shadow-sm shadow-slate-200/40 hover:bg-white/80 transition-all">
                
                {/* 视图控制组合 */}
                <div className="flex items-center bg-slate-100/60 rounded-full p-0.5 border border-slate-200/50">
                    <button
                        onClick={() => setEnableOpacity(!enableOpacity)}
                        className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${enableOpacity ? 'bg-white text-[#5B8DEF] shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                        title={enableOpacity ? "关闭透明度" : "开启透明度"}
                    >
                        {enableOpacity ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                    
                    <div className={`flex items-center overflow-hidden transition-all duration-300 ease-in-out ${enableOpacity ? 'w-[70px] opacity-100 ml-0.5' : 'w-0 opacity-0'}`}>
                         <div className="flex items-center gap-0.5 border-l border-slate-200/50 pl-0.5">
                            {[1, 2, 3].map((mode) => (
                                <button
                                    key={mode}
                                    onClick={() => setOpacityMode(mode as OpacityMode)}
                                    className={`w-5 h-5 rounded-full text-[10px] font-bold transition-all flex items-center justify-center ${opacityMode === mode ? 'bg-[#5B8DEF] text-white shadow-sm' : 'text-slate-400 hover:text-slate-600 hover:bg-white/50'}`}
                                >
                                    {mode}
                                </button>
                            ))}
                         </div>
                    </div>
                </div>
                <button
                    onClick={handleToggleAllNodes}
                    disabled={!data.length}
                    style={{ width: '28.571px', height: '28.571px' }}
                    className={`ml-1 rounded-full flex items-center justify-center transition-all group ${data.length ? 'bg-slate-100 text-[#94A3B8] hover:text-black' : 'text-slate-300 cursor-not-allowed bg-slate-100/80'}`}
                    title={treeOpenState === 'all-open' ? '全部收起' : treeOpenState === 'all-closed' ? '全部展开' : '全部展开'}
                >
                    <TreeStateIcon state={treeOpenState} />
                </button>

                <div className="w-px h-3 bg-slate-300/50 ml-2 mr-0.5" />

                {/* 主操作按钮 */}
                <div className="flex items-center gap-1">
                    {data.length > 0 && (
                        <button 
                            onClick={() => setShowClearAllConfirm(true)}
                            className="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                            title="清空全部"
                        >
                            <Trash2 size={14} />
                        </button>
                    )}
                    <button 
                        onClick={() => handleAdd(null, -1)}
                        className="w-10 h-10 flex items-center justify-center bg-slate-800 hover:bg-slate-900 text-white rounded-full shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all active:scale-95"
                        title="新建项目"
                    >
                        <Plus size={16} />
                    </button>
                </div>
            </div>
        </div>

        {/* --- 2. 列表主体：独立滚动 --- */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-4 pt-3 pb-4 no-scrollbar relative"
          onDragOver={handleListDragOver}
          onDragLeave={handleListDragLeave}
          onDrop={handleListDrop}
        >
          {data.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center border-2 border-dashed border-white/40 rounded-2xl bg-white/10 backdrop-blur-sm mx-4">
              <p className="text-slate-400 mb-2 text-sm font-bold">暂无内容</p>
            </div>
          ) : (
            <ul className="space-y-3 pb-8"> 
              {data.map((item, index) => (
                <TreeNode 
                  key={item.id} 
                  item={item} index={index} level={0}
                  parentOpacity={1} enableOpacity={enableOpacity} opacityMode={opacityMode}
                  deleteConfirmId={deleteConfirmId} deletingAncestor={false} selectedId={selectedId} draggingId={draggingId}
                  lengthWarningId={lengthWarning?.id ?? null}
                  lengthWarningExcess={lengthWarning?.excess ?? null}
                  pendingEditId={pendingEditId}
                  onToggle={toggleOpen} onAdd={handleAdd} onDeleteRequest={handleDeleteRequest}
                  onConfirmDelete={confirmDelete} onRename={handleRename}
                  onSelect={handleSelect}
                  onDragStart={handleDragStart} onDrop={handleDropOn} onPreviewMove={handlePreviewMove} onDragEnd={handleDragEnd}
                  onResolvePendingEdit={id => {
                    if (pendingEditId === id) setPendingEditId(null);
                  }}
                />
              ))}
            </ul>
          )}
        </div>

        {/* --- 弹窗层 --- */}
        {showClearAllConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm" onClick={() => setShowClearAllConfirm(false)} />
            <div className="relative bg-white rounded-2xl p-4 shadow-2xl max-w-[200px] w-full animate-in fade-in zoom-in-95 duration-200 border border-red-100 text-center">
               <div className="mb-3 text-slate-800 font-bold text-sm">确认清空全部?</div>
               <div className="flex justify-center gap-2">
                 <button onClick={() => setShowClearAllConfirm(false)} className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100">取消</button>
                 <button onClick={handleClearAll} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500 text-white hover:bg-red-600 shadow-md">确认</button>
               </div>
            </div>
          </div>
        )}
    </div>
  );
};

const TreeNode: FC<TreeNodeProps> = ({ 
  item, index, level, parentOpacity, 
  enableOpacity, opacityMode, deleteConfirmId, deletingAncestor, selectedId, draggingId,
  lengthWarningId, lengthWarningExcess, pendingEditId,
  onToggle, onAdd, onDeleteRequest, onConfirmDelete, onRename, onSelect,
  onDragStart, onDrop, onPreviewMove, onDragEnd, onResolvePendingEdit
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item.title);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const childListRef = useRef<HTMLUListElement>(null);
  const centerHoverStartRef = useRef<number|null>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);

  const isSelected = selectedId === item.id;
  const isActive = isSelected || draggingId === item.id;
  useEffect(() => { if (isEditing && inputRef.current) inputRef.current.focus(); }, [isEditing]);
  useEffect(() => {
    if (!isEditing) setEditTitle(item.title);
  }, [item.title, isEditing]);

  useLayoutEffect(() => {
    if (isEditing && inputRef.current instanceof HTMLTextAreaElement) {
      const el = inputRef.current;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [editTitle, isEditing]);

  useEffect(() => {
    if (pendingEditId === item.id && !isEditing) {
      setIsEditing(true);
      onResolvePendingEdit(item.id);
    }
  }, [pendingEditId, item.id, isEditing, onResolvePendingEdit]);

  const saveEdit = () => { if (editTitle.trim()) onRename(item.id, editTitle); else setEditTitle(item.title); setIsEditing(false); };
  
  let localOpacity = 1;
  if (enableOpacity) {
    if (opacityMode === 1) localOpacity = index === 0 ? 1 : 0.01;
    else if (opacityMode === 2) localOpacity = index === 0 ? 1 : (index === 1 ? 0.5 : 0.01);
    else if (opacityMode === 3) localOpacity = index === 0 ? 1 : (index === 1 ? 0.5 : (index === 2 ? 0.15 : 0.01));
  }
  const currentOpacity = parentOpacity * Math.max(0.01, localOpacity);

  const isDeleting = deletingAncestor || deleteConfirmId === item.id;
  const baseContainerClass = `group relative flex items-center gap-2 bg-white/40 border border-white/60 shadow-sm text-slate-700 rounded-full px-3 py-1.5 hover:bg-white/80 cursor-pointer hover:!opacity-100 hover:shadow-md hover:border-white transition-all duration-300`;
  const containerClass = isDeleting 
    ? `relative flex items-center gap-2 bg-red-50/80 border border-red-200 shadow-sm text-red-700 rounded-full px-3 py-1.5 cursor-pointer hover:!opacity-100`
    : `${baseContainerClass} ${isActive ? 'ring-2 ring-[#5B8DEF]/40' : ''}`;

  return (
    <li 
      className="select-none transition-all duration-300 ease-in-out project-item" 
      style={{ paddingLeft: level > 0 ? '0.5rem' : '0', zIndex: 50 - level * 5 - index }}
      draggable={!isEditing} 
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); if(TRANSPARENT_DRAG_IMAGE) e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMAGE,0,0); onDragStart(item.id); }}
      onDragOver={(e) => {
          e.preventDefault(); e.stopPropagation();
          if (item.isOpen && childListRef.current) { const r = childListRef.current.getBoundingClientRect(); if (e.clientY >= r.top && e.clientY <= r.bottom) return; }
          if (draggingId && draggingId !== item.id) {
            const rect = (headerRef.current ?? e.currentTarget).getBoundingClientRect();
            const y = e.clientY, top = rect.top, h = rect.height;
            let pos: InsertPosition = 'inside';
            if (y >= top + h * 0.2 && y <= top + h * 0.8) {
                if (!centerHoverStartRef.current) centerHoverStartRef.current = Date.now();
                if (Date.now() - centerHoverStartRef.current < 500) pos = y < top + h/2 ? 'before' : 'after';
            } else { centerHoverStartRef.current = null; pos = y < top + h * 0.4 ? 'before' : 'after'; }
            onPreviewMove(item.id, pos);
          }
      }}
      onDrop={(e) => {
          e.preventDefault(); e.stopPropagation();
          if (item.isOpen && childListRef.current) { const r = childListRef.current.getBoundingClientRect(); if (e.clientY >= r.top && e.clientY <= r.bottom) return; }
          const rect = (headerRef.current ?? e.currentTarget).getBoundingClientRect();
          const y = e.clientY, top = rect.top, h = rect.height;
          let pos: InsertPosition = 'inside';
          if (y >= top + h * 0.1 && y <= top + h * 0.9) {
             if ((centerHoverStartRef.current && Date.now() - centerHoverStartRef.current < 500) || !centerHoverStartRef.current) pos = y < top + h/2 ? 'before' : 'after';
          } else pos = y < top + h * 0.1 ? 'before' : 'after';
          onDrop(item.id, pos);
      }}
      onDragEnd={(e) => { e.stopPropagation(); centerHoverStartRef.current = null; onDragEnd(); }}
    >
      <div 
        className={containerClass}
        style={{ opacity: currentOpacity, transition: 'all 0.3s ease', animation: draggingId ? 'drag-slide 0.32s' : undefined, minWidth: MIN_NODE_WIDTH }}
        ref={headerRef}
        onClick={(e) => { e.stopPropagation(); onSelect(item.id); }}
      >
        <div className="flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full cursor-pointer transition-all hover:bg-black/5 text-slate-500" onClick={(e) => { e.stopPropagation(); onToggle(item.id); }}>
           {item.children?.length ? (item.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <Circle size={4} className="fill-current opacity-40 stroke-none" />}
        </div>
        <div className="flex-1 min-w-0 flex items-baseline mr-1">
          {isEditing ? (
            <textarea
              ref={inputRef as RefObject<HTMLTextAreaElement>}
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onBlur={saveEdit}
              rows={1}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
                if (e.key === 'Escape') {
                  setEditTitle(item.title);
                  setIsEditing(false);
                }
              }}
              className="w-full bg-transparent border border-slate-400/50 rounded px-2 py-1 text-sm focus:outline-none resize-none leading-relaxed"
              style={{ whiteSpace: 'pre-wrap', overflow: 'hidden', wordBreak: 'break-word', overflowWrap: 'anywhere' }}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span
              onClick={(e) => { e.stopPropagation(); onSelect(item.id); }}
              onDoubleClick={e => { e.stopPropagation(); setIsEditing(true); }}
              className={`cursor-text hover:opacity-70 transition-opacity block w-full text-sm ${item.title.trim() ? '' : 'text-slate-400 italic'}`}
              style={getTitleStyle(isSelected)}
              title={item.title.trim() ? item.title : PLACEHOLDER_TITLE}
            >
              {formatTitle(item.title, isSelected)}
            </span>
          )}
        </div>
        {lengthWarningId === item.id && lengthWarningExcess !== null && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-red-100 text-red-600 text-[11px] font-medium px-2 py-0.5 rounded-full border border-red-200 shadow-sm animate-in fade-in duration-200">
            超出了{lengthWarningExcess}字
          </div>
        )}
        <div className={`flex items-center gap-0.5 ${deleteConfirmId === item.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-all duration-200 delete-action-area relative`}>
          <button
            onClick={e => { e.stopPropagation(); onAdd(item.id, level); }}
            disabled={level >= MAX_DEPTH - 1}
            className={`p-1 rounded-full transition-all ${level >= MAX_DEPTH - 1 ? 'text-slate-300 cursor-not-allowed' : 'hover:bg-black/5'}`}
            title={level >= MAX_DEPTH - 1 ? '最多 5 层，无法再添加子节点' : '添加子节点'}
          >
            <Plus size={14} />
          </button>
          <div className="relative">
             <button
               ref={deleteBtnRef}
               onClick={e => { e.stopPropagation(); onDeleteRequest(item.id); }}
               className={`p-1 rounded-full transition-all ${deleteConfirmId === item.id ? 'bg-red-500 text-white' : 'hover:bg-red-500/10 hover:text-red-600'}`}
             >
               <Trash2 size={14} />
             </button>
             {deleteConfirmId === item.id && (
               <DeleteConfirmPopover
                 anchorEl={deleteBtnRef.current}
                 onConfirm={(e) => { e.stopPropagation(); onConfirmDelete(item.id); }}
               />
             )}
          </div>
        </div>
      </div>
      {item.isOpen && item.children?.length > 0 && (
        <ul ref={childListRef} className="mt-1.5 space-y-1.5 border-l border-white/20 ml-2 pl-1 relative">
            {item.children.map((child, idx) => (
                <TreeNode
                  key={child.id}
                  item={child}
                  index={idx}
                  level={level + 1}
                  parentOpacity={currentOpacity}
                  enableOpacity={enableOpacity}
                  opacityMode={opacityMode}
                  deleteConfirmId={deleteConfirmId}
                  deletingAncestor={isDeleting}
                  selectedId={selectedId}
                  draggingId={draggingId}
                  lengthWarningId={lengthWarningId}
                  lengthWarningExcess={lengthWarningExcess}
                  pendingEditId={pendingEditId}
                  onToggle={onToggle}
                  onAdd={onAdd}
                  onDeleteRequest={onDeleteRequest}
                  onConfirmDelete={onConfirmDelete}
                  onRename={onRename}
                  onSelect={onSelect}
                  onDragStart={onDragStart}
                  onDrop={onDrop}
                  onPreviewMove={onPreviewMove}
                  onDragEnd={onDragEnd}
                  onResolvePendingEdit={onResolvePendingEdit}
                />
            ))}
        </ul>
      )}
    </li>
  );
};

export default ProjectSorter;

interface DeleteConfirmPopoverProps {
  anchorEl: HTMLElement | null;
  onConfirm: (event: React.MouseEvent) => void;
}

const DeleteConfirmPopover: FC<DeleteConfirmPopoverProps> = ({ anchorEl, onConfirm }) => {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorEl) {
      setPosition(null);
      return;
    }
    const updatePosition = () => {
      const rect = anchorEl.getBoundingClientRect();
      setPosition({
        top: rect.top - 50,
        left: rect.right - 96
      });
    };
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [anchorEl]);

  if (!anchorEl || !position || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="delete-action-area fixed w-24 bg-white rounded-lg shadow-xl border border-slate-100 p-1.5 text-slate-800 animate-in slide-in-from-bottom-2 duration-200"
      style={{ top: position.top, left: position.left, zIndex: 1000 }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        onClick={onConfirm}
        className="w-full bg-red-500 hover:bg-red-600 text-white text-[10px] font-bold py-1 rounded flex justify-center items-center"
      >
        删除全部任务
      </button>
    </div>,
    document.body
  );
};
