/**
 * ProjectSorter.tsx
 * ---------------------------------------------------------------------------
 * 一个具有层级视觉衰减效果的静态项目清单组件。
 *
 * [调整记录]
 * 1. 布局重构：改为 Flex-col 布局，工具栏固定顶部，列表独立滚动，彻底解决穿透问题。
 * 2. 尺寸锁定：容器强制锁定为 400px * 300px。
 * 3. 紧凑化：针对小窗口优化了 Padding 和间距。
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { CSSProperties, FC } from 'react';
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

const PROJECTS_FILE_PATH = 'projects.xml';
const SETTINGS_FILE_PATH = 'project-settings.json';
const DATA_STORAGE_KEY = 'project-sort-data-v37';
const SETTINGS_STORAGE_KEY = 'project-sort-settings-v2';
const MIN_NODE_WIDTH = 180;

const resolveAssetUrl = (path: string): string => {
  const runtime = (globalThis as any)?.chrome?.runtime;
  if (runtime?.getURL) {
    return runtime.getURL(path);
  }
  return path;
};

type MoveDirection = 'up' | 'down' | 'left' | 'right';
type OpacityMode = 1 | 2 | 3;
type InsertPosition = 'before' | 'after' | 'inside';

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
  onToggle: (id: string) => void;
  onAdd: (parentId: string | null) => void;
  onDeleteRequest: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onSelect: (id: string) => void;
  onDragStart: (id: string) => void;
  onDrop: (id: string, position: InsertPosition) => void;
  onPreviewMove: (id: string, position: InsertPosition) => void;
  onDragEnd: () => void;
}

const FALLBACK_DATA: TreeItem[] = [
  {
    id: 'study',
    title: '学习路线',
    isOpen: true,
    children: [
      {
        id: 'writing',
        title: '写作练习',
        isOpen: true,
        children: [
          { id: 'daily-words', title: '每日词汇', children: [] },
          { id: 'shadowing', title: '句子跟读', children: [] }
        ]
      },
      { id: 'reading', title: '阅读计划', children: [] }
    ]
  },
  {
    id: 'work',
    title: '工作项目',
    isOpen: true,
    children: [
      { id: 'q3-plan', title: 'Q3 规划稿', children: [] },
      { id: 'weekly', title: '周报整理', children: [] }
    ]
  }
];

const DEFAULT_SETTINGS: { enableOpacity: boolean; opacityMode: OpacityMode } = {
  enableOpacity: true,
  opacityMode: 2
};

// --- ID Helpers ---
const generateId = (): string => Math.random().toString(36).substr(2, 9);
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

const isOpacityMode = (value: unknown): value is OpacityMode => [1, 2, 3].includes(value as number);

const parseProjectsXml = (xmlText: string): TreeItem[] | null => {
  if (typeof DOMParser === 'undefined') return null;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const root = doc.querySelector('projects');
    if (!root) return null;
    const parseNode = (el: Element): TreeItem => {
      const isOpenAttr = el.getAttribute('isOpen');
      return {
        id: el.getAttribute('id') || generateId(),
        title: el.getAttribute('title') || '未命名节点',
        isOpen: isOpenAttr === null ? true : isOpenAttr !== 'false',
        children: Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'node').map(c => parseNode(c as Element))
      };
    };
    const nodes = Array.from(root.children).filter(c => c.tagName.toLowerCase() === 'node').map(c => parseNode(c as Element));
    return normalizeTreeIds(nodes).tree;
  } catch (e) {
    return null;
  }
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

// --- ProjectSorter ---

const ProjectSorter: FC = () => {
  const [data, setData] = useState<TreeItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [enableOpacity, setEnableOpacity] = useState(DEFAULT_SETTINGS.enableOpacity);
  const [opacityMode, setOpacityMode] = useState<OpacityMode>(DEFAULT_SETTINGS.opacityMode);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const lastWheelTime = useRef<number>(0);
  const dataInitializedRef = useRef(false);
  const settingsInitializedRef = useRef(false);

  // 初始化逻辑 (与之前相同，省略重复细节以保持专注)
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
    const loadFromXml = async () => {
      try {
        const res = await fetch(resolveAssetUrl(PROJECTS_FILE_PATH));
        if (res.ok) {
          const parsed = parseProjectsXml(await res.text());
          if (parsed?.length) {
            setData(parsed);
            dataInitializedRef.current = true;
            return;
          }
        }
      } catch (e) {}
      setData(FALLBACK_DATA);
      dataInitializedRef.current = true;
    };
    loadFromXml();
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
    fetch(resolveAssetUrl(SETTINGS_FILE_PATH)).then(r=>r.json()).then(p=>{
        setEnableOpacity(p.enableOpacity ?? true);
        setOpacityMode(p.opacityMode ?? 2);
    }).catch(()=>{})
    .finally(()=> settingsInitializedRef.current = true);
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
        const ctx = findContextById(newData, selectedId);
        if (!ctx) return prev;
        const { list, index, node, parent } = ctx;
        if (dir === 'up' && index > 0) [list[index], list[index-1]] = [list[index-1], list[index]];
        else if (dir === 'down' && index < list.length - 1) [list[index], list[index+1]] = [list[index+1], list[index]];
        else if (dir === 'right' && index < list.length - 1) {
            list.splice(index, 1);
            if (!list[index].children) list[index].children = [];
            list[index].children.unshift(node);
            list[index].isOpen = true;
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
    const w = (e: WheelEvent) => {
        if (!selectedId || Date.now() - lastWheelTime.current < 60) return;
        e.preventDefault();
        lastWheelTime.current = Date.now();
        moveItem(e.deltaY < 0 ? 'up' : 'down');
    };
    window.addEventListener('keydown', k);
    window.addEventListener('wheel', w, {passive:false});
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('wheel', w); };
  }, [selectedId, moveItem]);

  const toggleOpen = (id: string) => setData(prev => {
    const rec = (nodes: TreeItem[]): TreeItem[] => nodes.map(n => ({ ...n, isOpen: n.id === id ? !n.isOpen : n.isOpen, children: rec(n.children) }));
    return rec(prev);
  });

  const handleAdd = (parentId: string | null) => {
    setData(prev => {
        const u = collectIds(prev);
        const n: TreeItem = { id: generateUniqueId(u), title: '新项目', isOpen: true, children: [] };
        setTimeout(() => setSelectedId(n.id), 50);
        if (!parentId) return [...prev, n];
        const rec = (nodes: TreeItem[]): TreeItem[] => nodes.map(node => node.id === parentId ? { ...node, isOpen: true, children: [...node.children, n] } : { ...node, children: rec(node.children) });
        return rec(prev);
    });
  };

  const handleDeleteRequest = (id: string) => {
    if (findContextById(data, id)?.node.children.length) setDeleteConfirmId(id);
    else confirmDelete(id);
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

  const handleDragStart = (id: string) => setDraggingId(id);
  const handleDropOn = (tid: string, pos: InsertPosition) => {
    if (!draggingId || draggingId === tid) return;
    setData(p => moveNodeInTree(p, draggingId, tid, pos) || p);
    setSelectedId(draggingId); setDraggingId(null);
  };
  const handlePreviewMove = (tid: string, pos: InsertPosition) => {
    if (draggingId && draggingId !== tid) setData(p => moveNodeInTree(p, draggingId, tid, pos) || p);
  };

  return (
    <div
      className="bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#F0F4FF] via-white to-[#E6F0FF] text-slate-800 font-sans selection:bg-[#D4E3FD]"
      style={{ 
        width: '300px',
        height: '500px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
        {/* --- 1. 固定工具栏区域 (无滚动) --- */}
        <div
          className="flex-shrink-0 flex justify-end items-center px-3"
          style={{ height: '50px', marginTop: '8px', marginBottom: '8px'}}
        >
            <div className="flex items-center gap-1.5 p-1 bg-white/70 backdrop-blur-xl rounded-full border border-white/50 shadow-sm shadow-slate-200/40 hover:bg-white/80 transition-all">
                
                {/* 视图设置 */}
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

                <div className="w-px h-3 bg-slate-300/50 mx-0.5" />

                {/* 核心操作 */}
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
                        onClick={() => handleAdd(null)}
                        className="w-10 h-10 flex items-center justify-center bg-slate-800 hover:bg-slate-900 text-white rounded-full shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all active:scale-95"
                        title="新建项目"
                    >
                        <Plus size={16} />
                    </button>
                </div>
            </div>
        </div>

        {/* --- 2. 滚动列表区域 (独立滚动，不与工具栏重叠) --- */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 no-scrollbar relative">
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
                  onToggle={toggleOpen} onAdd={handleAdd} onDeleteRequest={handleDeleteRequest}
                  onConfirmDelete={confirmDelete} onRename={(id, t) => setData(p => {
                      const rec = (ns:TreeItem[]):TreeItem[] => ns.map(n=>n.id===id?{...n,title:t}:{...n,children:rec(n.children)});
                      return rec(p);
                  })}
                  onSelect={id => setSelectedId(id===selectedId?null:id)}
                  onDragStart={handleDragStart} onDrop={handleDropOn} onPreviewMove={handlePreviewMove} onDragEnd={() => setDraggingId(null)}
                />
              ))}
            </ul>
          )}
        </div>

        {/* --- 弹窗 --- */}
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
  onToggle, onAdd, onDeleteRequest, onConfirmDelete, onRename, onSelect,
  onDragStart, onDrop, onPreviewMove, onDragEnd
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const childListRef = useRef<HTMLUListElement>(null);
  const centerHoverStartRef = useRef<number|null>(null);

  const isSelected = selectedId === item.id;
  useEffect(() => { if (isEditing && inputRef.current) inputRef.current.focus(); }, [isEditing]);

  const saveEdit = () => { if (editTitle.trim()) onRename(item.id, editTitle); else setEditTitle(item.title); setIsEditing(false); };
  
  let localOpacity = 1;
  if (enableOpacity) {
    if (opacityMode === 1) localOpacity = index === 0 ? 1 : 0.01;
    else if (opacityMode === 2) localOpacity = index === 0 ? 1 : (index === 1 ? 0.5 : 0.01);
    else if (opacityMode === 3) localOpacity = index === 0 ? 1 : (index === 1 ? 0.5 : (index === 2 ? 0.15 : 0.01));
  }
  const currentOpacity = isSelected ? 1 : parentOpacity * Math.max(0.01, localOpacity);

  const isDeleting = deletingAncestor || deleteConfirmId === item.id;
  const containerClass = isSelected
    ? `group relative flex items-center gap-2 bg-[#D4E3FD] border-2 border-[#7BA7F7] shadow-md text-slate-800 rounded-full px-3 py-1.5 cursor-pointer z-10 hover:!opacity-100`
    : (isDeleting 
        ? `relative flex items-center gap-2 bg-red-50/80 border border-red-200 shadow-sm text-red-700 rounded-full px-3 py-1.5 cursor-pointer hover:!opacity-100`
        : `group relative flex items-center gap-2 bg-white/40 border border-white/60 shadow-sm text-slate-700 rounded-full px-3 py-1.5 hover:bg-white/80 cursor-pointer hover:!opacity-100 hover:shadow-md hover:border-white transition-all duration-300 ${draggingId === item.id ? 'ring-2 ring-[#5B8DEF]/40' : ''}`);

  return (
    <li 
      className="select-none transition-all duration-300 ease-in-out project-item" 
      style={{ paddingLeft: level > 0 ? '1.5rem' : '0', zIndex: 50 - level * 5 - index }}
      draggable={!isEditing} 
      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); if(TRANSPARENT_DRAG_IMAGE) e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMAGE,0,0); onDragStart(item.id); }}
      onDragOver={(e) => {
          e.preventDefault(); e.stopPropagation();
          if (item.isOpen && childListRef.current) { const r = childListRef.current.getBoundingClientRect(); if (e.clientY >= r.top && e.clientY <= r.bottom) return; }
          if (draggingId && draggingId !== item.id) {
            const rect = (headerRef.current ?? e.currentTarget).getBoundingClientRect();
            const y = e.clientY, top = rect.top, h = rect.height;
            let pos: InsertPosition = 'inside';
            if (y >= top + h * 0.4 && y <= top + h * 0.8) {
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
        style={{ opacity: currentOpacity, transition: 'all 0.3s ease', animation: draggingId ? 'drag-slide 0.32s' : undefined, transform: isSelected ? 'scale(1.01) translateX(2px)' : 'scale(1)', minWidth: MIN_NODE_WIDTH }}
        ref={headerRef}
        onClick={(e) => { e.stopPropagation(); onSelect(item.id); }}
      >
        <div className={`flex-shrink-0 flex items-center justify-center w-5 h-5 rounded-full cursor-pointer transition-all ${isSelected ? 'text-[#5B8DEF]' : 'hover:bg-black/5 text-slate-500'}`} onClick={(e) => { e.stopPropagation(); onToggle(item.id); }}>
           {item.children?.length ? (item.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <Circle size={4} className="fill-current opacity-40 stroke-none" />}
        </div>
        <div className="flex-1 truncate flex items-baseline mr-1">
          {isEditing ? (
            <input ref={inputRef} value={editTitle} onChange={e => setEditTitle(e.target.value)} onBlur={saveEdit} onKeyDown={e => {if(e.key==='Enter') saveEdit(); if(e.key==='Escape'){setEditTitle(item.title);setIsEditing(false);}}} className={`w-full bg-transparent border-b px-1 text-sm focus:outline-none ${isSelected ? 'border-[#5B8DEF]/50 text-slate-900' : 'border-slate-400/50'}`} onClick={e => e.stopPropagation()} />
          ) : (
            <span onClick={e => e.stopPropagation()} onDoubleClick={e => { e.stopPropagation(); setIsEditing(true); }} className="cursor-text hover:opacity-70 transition-opacity block w-full truncate text-sm" title={item.title}>{item.title}</span>
          )}
        </div>
        <div className={`flex items-center gap-0.5 ${deleteConfirmId === item.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-all duration-200 delete-action-area relative`}>
          <button onClick={e => { e.stopPropagation(); onAdd(item.id); }} className={`p-1 rounded-full transition-all ${isSelected ? 'hover:bg-[#5B8DEF]/20 text-[#5B8DEF]' : 'hover:bg-black/5'}`}><Plus size={14} /></button>
          <div className="relative">
             <button onClick={e => { e.stopPropagation(); onDeleteRequest(item.id); }} className={`p-1 rounded-full transition-all ${deleteConfirmId === item.id ? 'bg-red-500 text-white' : 'hover:bg-red-500/10 hover:text-red-600'}`}><Trash2 size={14} /></button>
              {deleteConfirmId === item.id && (
                <div className="absolute bottom-full mb-1 right-0 w-24 bg-white rounded-lg shadow-xl border border-slate-100 p-1.5 z-10 animate-in slide-in-from-bottom-2 duration-200 text-slate-800" style={{ zIndex:"1000"}} onClick={e => e.stopPropagation()}>
                   <button
                     onClick={e => { e.stopPropagation(); onConfirmDelete(item.id); }}
                     className="w-full bg-red-500 hover:bg-red-600 text-white text-[10px] font-bold py-1 rounded flex justify-center items-center"
                   >
                     删除全部任务
                   </button>
                </div>
             )}
          </div>
        </div>
      </div>
      {item.isOpen && item.children?.length > 0 && (
        <ul ref={childListRef} className="mt-1.5 space-y-1.5 border-l border-white/20 ml-4 pl-2 relative">
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
                />
            ))}
        </ul>
      )}
    </li>
  );
};

export default ProjectSorter;
