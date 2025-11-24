/**
 * ProjectSorter.tsx
 * ---------------------------------------------------------------------------
 * 一个具有层级视觉衰减效果的静态项目清单组件。
 *
 * [主要功能特点]
 * 1. 无限层级展示：支持无限级递归渲染项目树结构。
 * 2. 视觉聚焦系统：通过“透明度模式”控制非顶部项目的可见度，实现视觉降噪。
 * - 档位 1：极简模式，仅高亮显示第 1 条。
 * - 档位 2：适中模式，显示前 2 条。
 * - 档位 3：宽松模式，显示前 3 条。
 * 3. 完整的增删改（CRUD）。
 * - 添加：支持添加根项目和子项目。
 * - 删除：支持单个删除（带子项目时有防误删确认气泡）和一键清空全部。
 * - 重命名：点击文本即可进入编辑模式。
 * 4. 高级交互体验。
 * - 选中高亮：点击项目选中，选中项高亮且强制完全不透明。
 * - 键盘排序：选中后支持上下同级排序，← 升级移出，→ 降级移入。
 * - 滚轮排序：选中后支持滚轮微调顺序。
 * - 磨砂玻璃 UI：采用 backdrop-blur 效果，配合淡蓝色 (#D4E3FD) 主题。
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { CSSProperties, FC } from 'react';
import { 
  ChevronRight, 
  ChevronDown, 
  Plus, 
  Trash2, 
  LayoutList,
  Eye,
  EyeOff,
  Circle,
  Check,
  MousePointer2,
  Keyboard
} from 'lucide-react';

const PROJECTS_FILE_PATH = 'projects.xml';
const SETTINGS_FILE_PATH = 'project-settings.json';
const DATA_STORAGE_KEY = 'project-sort-data-v36';
const SETTINGS_STORAGE_KEY = 'project-sort-settings-v1';
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
type SortMode = 'keyboard' | 'mouse';
type InsertPosition = 'before' | 'after' | 'inside';

// 透明拖拽占位图，避免浏览器默认半透明影子
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
  selectedId: string | null;
  sortMode: SortMode;
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
          { id: 'shadowing', title: '句子跟读', children: [] },
          { id: 'grammar', title: '语法纠错', children: [] },
          { id: 'polish', title: '长文打磨', children: [] }
        ]
      },
      { id: 'reading', title: '阅读计划', children: [] },
      { id: 'output', title: '输出练习', children: [] }
    ]
  },
  {
    id: 'work',
    title: '工作项目',
    isOpen: true,
    children: [
      { id: 'q3-plan', title: 'Q3 规划稿', children: [] },
      { id: 'weekly', title: '周报整理', children: [] },
      { id: 'meeting-notes', title: '会议记录', children: [] }
    ]
  }
];

const DEFAULT_SETTINGS: { enableOpacity: boolean; opacityMode: OpacityMode; sortMode: SortMode } = {
  enableOpacity: true,
  opacityMode: 2,
  sortMode: 'keyboard'
};

// 生成随机短 ID 的辅助函数
const generateId = (): string => Math.random().toString(36).substr(2, 9);

const generateUniqueId = (used: Set<string>): string => {
  let next = generateId();
  while (used.has(next)) {
    next = generateId();
  }
  used.add(next);
  return next;
};

const collectIds = (nodes: TreeItem[], used = new Set<string>()): Set<string> => {
  for (const node of nodes) {
    if (node.id) used.add(node.id);
    if (node.children && node.children.length > 0) {
      collectIds(node.children, used);
    }
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

      const nextChildren = node.children ? walk(node.children) : [];
      return { ...node, id: nextId, children: nextChildren };
    });

  return { tree: walk(nodes), usedIds, changed };
};

const isOpacityMode = (value: unknown): value is OpacityMode =>
  value === 1 || value === 2 || value === 3;

const isSortMode = (value: unknown): value is SortMode =>
  value === 'keyboard' || value === 'mouse';

const parseProjectsXml = (xmlText: string): TreeItem[] | null => {
  if (typeof DOMParser === 'undefined') return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      console.error('projects.xml parse error', errorNode.textContent);
      return null;
    }

    const root = doc.querySelector('projects');
    if (!root) return null;

    const parseNode = (el: Element): TreeItem => {
      const isOpenAttr = el.getAttribute('isOpen');
      const parsedChildren = Array.from(el.children)
        .filter(child => child.tagName.toLowerCase() === 'node')
        .map(child => parseNode(child as Element));

      return {
        id: el.getAttribute('id') || generateId(),
        title: el.getAttribute('title') || '未命名节点',
        isOpen: isOpenAttr === null ? true : isOpenAttr !== 'false',
        children: parsedChildren
      };
    };

    const nodes = Array.from(root.children)
      .filter(child => child.tagName.toLowerCase() === 'node')
      .map(child => parseNode(child as Element));

    const normalized = normalizeTreeIds(nodes);
    if (normalized.changed) {
      console.warn('projects.xml contains missing or duplicate ids; regenerated automatically');
    }
    return normalized.tree;
  } catch (error) {
    console.error('Failed to parse projects.xml', error);
    return null;
  }
};

// 在树中查找指定节点的上下文（所在列表、索引、节点本身及父节点）
const findContextById = (
  nodes: TreeItem[],
  targetId: string,
  parent: TreeItem | null = null
): TreeContext | null => {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.id === targetId) {
      return { list: nodes, index: i, node, parent };
    }
    if (node.children && node.children.length > 0) {
      const childResult = findContextById(node.children, targetId, node);
      if (childResult) return childResult;
    }
  }
  return null;
};

// 判断 targetId 是否在 node 的子树中（含自身），用于避免拖入自身后代造成循环
const containsId = (node: TreeItem, targetId: string): boolean => {
  if (node.id === targetId) return true;
  return node.children?.some(child => containsId(child, targetId)) ?? false;
};

// 纯函数：按指定位置移动节点，返回新的数据副本；如无需变更则返回 null
const moveNodeInTree = (
  data: TreeItem[],
  dragId: string,
  targetId: string,
  position: InsertPosition
): TreeItem[] | null => {
  if (!dragId || dragId === targetId) return null;

  const newData = JSON.parse(JSON.stringify(data)) as TreeItem[];
  const dragCtx = findContextById(newData, dragId);
  const dropCtx = findContextById(newData, targetId);
  if (!dragCtx || !dropCtx) return null;
  if (containsId(dragCtx.node, targetId)) return null; // 避免拖到自身后代导致循环

  const fromList = dragCtx.list;
  const fromIndex = dragCtx.index;

  if (position === 'inside') {
    fromList.splice(fromIndex, 1);
    if (!dropCtx.node.children) dropCtx.node.children = [];
    dropCtx.node.children.push(dragCtx.node);
    dropCtx.node.isOpen = true;
    return newData;
  }

  const targetList = dropCtx.list;
  let to = position === 'before' ? dropCtx.index : dropCtx.index + 1;

  fromList.splice(fromIndex, 1);

  if (fromList === targetList && fromIndex < to) to -= 1;
  if (to < 0) to = 0;
  if (to > targetList.length) to = targetList.length;

  // 若移除后位置未变，则不更新
  if (fromList === targetList && fromIndex === to) return null;

  targetList.splice(to, 0, dragCtx.node);
  return newData;
};

// --- 2. 主容器组件 (ProjectSorter) ---

const ProjectSorter: FC = () => {
  const [data, setData] = useState<TreeItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [enableOpacity, setEnableOpacity] = useState(DEFAULT_SETTINGS.enableOpacity);
  const [opacityMode, setOpacityMode] = useState<OpacityMode>(DEFAULT_SETTINGS.opacityMode);
  const [sortMode, setSortMode] = useState<SortMode>(DEFAULT_SETTINGS.sortMode);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const lastWheelTime = useRef<number>(0);
  const dataInitializedRef = useRef(false);
  const settingsInitializedRef = useRef(false);

  // 初始化：组件挂载时从 LocalStorage 读取数据
  useEffect(() => {
    const saved = localStorage.getItem(DATA_STORAGE_KEY);
    let hasSavedData = false;

    if (saved) {
      try {
        const parsedData = JSON.parse(saved) as TreeItem[];
        if (Array.isArray(parsedData)) {
          const normalized = normalizeTreeIds(parsedData);
          setData(normalized.tree);
          dataInitializedRef.current = true;
          hasSavedData = true;
        }
      } catch (e) {
        console.error('Failed to load saved data', e);
      }
    }

    if (hasSavedData) return;

    let cancelled = false;

    const loadFromXml = async () => {
      try {
        const response = await fetch(resolveAssetUrl(PROJECTS_FILE_PATH));
        if (cancelled) return;

        if (response.ok) {
          const xmlText = await response.text();
          if (cancelled) return;

          const parsed = parseProjectsXml(xmlText);
          if (parsed && parsed.length > 0) {
            setData(parsed);
            dataInitializedRef.current = true;
            return;
          }
        }
      } catch (e) {
        console.error('Failed to load projects.xml', e);
      }

      if (!cancelled) {
        setData(FALLBACK_DATA);
        dataInitializedRef.current = true;
      }
    };

    loadFromXml();

    return () => {
      cancelled = true;
    };
  }, []);

  // 监听数据变化：自动保存到 LocalStorage
  useEffect(() => {
    if (!dataInitializedRef.current) return;
    localStorage.setItem(DATA_STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  // 初始化设置：先看 LocalStorage，再读取 JSON 文件
  useEffect(() => {
    const savedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings) as Partial<{
          enableOpacity: boolean;
          opacityMode: OpacityMode;
          sortMode: SortMode;
        }>;

        if (typeof parsed.enableOpacity === 'boolean') setEnableOpacity(parsed.enableOpacity);
        if (isOpacityMode(parsed.opacityMode)) setOpacityMode(parsed.opacityMode);
        if (isSortMode(parsed.sortMode)) setSortMode(parsed.sortMode);
        settingsInitializedRef.current = true;
        return;
      } catch (error) {
        console.error('Failed to load saved settings', error);
      }
    }

    let cancelled = false;

    const loadSettingsFile = async () => {
      try {
        const response = await fetch(resolveAssetUrl(SETTINGS_FILE_PATH));
        if (!response.ok) {
          throw new Error(response.statusText);
        }
        const payload = await response.json();
        if (cancelled) return;

        if (typeof payload.enableOpacity === 'boolean') setEnableOpacity(payload.enableOpacity);
        if (isOpacityMode(payload.opacityMode)) setOpacityMode(payload.opacityMode);
        if (isSortMode(payload.sortMode)) setSortMode(payload.sortMode);
      } catch (error) {
        console.error('Failed to load settings file', error);
      } finally {
        if (!cancelled) settingsInitializedRef.current = true;
      }
    };

    loadSettingsFile();

    return () => {
      cancelled = true;
    };
  }, []);

  // 设置变更：保存到 LocalStorage 以便恢复
  useEffect(() => {
    if (!settingsInitializedRef.current) return;
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ enableOpacity, opacityMode, sortMode })
    );
  }, [enableOpacity, opacityMode, sortMode]);

  // 注入拖拽滑动动画的 keyframes
  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      @keyframes drag-slide {
        from { transform: translateY(2px); }
        to { transform: translateY(0); }
      }
    `;
    document.head.appendChild(styleEl);
    return () => {
      document.head.removeChild(styleEl);
    };
  }, []);

  // 全局点击监听：处理“点击外部取消状态”的逻辑
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (deleteConfirmId && !target.closest('.delete-action-area')) {
        setDeleteConfirmId(null);
      }
      if (selectedId && !target.closest('.project-item')) {
        setSelectedId(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [deleteConfirmId, selectedId]);

  // --- 3. 核心排序与移动逻辑 (Move Logic) ---
  
  const moveItem = useCallback((direction: MoveDirection) => {
    if (!selectedId) return; 

    setData(prevData => {
      const newData = JSON.parse(JSON.stringify(prevData)) as TreeItem[]; 
      
      const ctx = findContextById(newData, selectedId);
      if (!ctx) return prevData; 

      const { list, index, node, parent } = ctx;

      switch (direction) {
        case 'up': {
          if (index > 0) {
            [list[index], list[index - 1]] = [list[index - 1], list[index]];
            return newData;
          }
          break;
        }
        case 'down': {
          if (index < list.length - 1) {
            [list[index], list[index + 1]] = [list[index + 1], list[index]];
            return newData;
          }
          break;
        }
        case 'right': {
          if (index < list.length - 1) { 
            const nextSibling = list[index + 1];
            list.splice(index, 1);
            if (!nextSibling.children) nextSibling.children = [];
            nextSibling.children.unshift(node);
            nextSibling.isOpen = true;
            return newData;
          }
          break;
        }
        case 'left': {
          if (parent) {
            const findParentContext = (nodes: TreeItem[]): { list: TreeItem[]; index: number } | null => {
              for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].id === parent.id) {
                  return { list: nodes, index: i };
                }
                if (nodes[i].children) {
                  const res = findParentContext(nodes[i].children);
                  if (res) return res;
                }
              }
              return null;
            };

            const parentCtx = findParentContext(newData);
            
            if (parentCtx) {
              const { list: parentList, index: parentIndex } = parentCtx;
              list.splice(index, 1);
              parentList.splice(parentIndex, 0, node);
              return newData;
            }
          }
          break;
        }
        default:
          break;
      }

      return prevData; 
    });
  }, [selectedId]);

  // --- 4. 事件监听 (键盘与滚轮) ---

  useEffect(() => {
    if (sortMode !== 'keyboard') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedId) return;

      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveItem('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveItem('down');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveItem('right');
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveItem('left');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setSelectedId(null);
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (!selectedId) return;
      
      const now = Date.now();
      if (now - lastWheelTime.current < 60) return; 
      
      e.preventDefault(); 
      lastWheelTime.current = now;

      if (e.deltaY < 0) {
        moveItem('up');
      } else if (e.deltaY > 0) {
        moveItem('down');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('wheel', handleWheel);
    };
  }, [selectedId, moveItem, sortMode]);

  // --- 5. 业务逻辑处理（CRUD） ---

  const toggleOpen = (id: string) => {
    const toggleRecursive = (nodes: TreeItem[]): TreeItem[] => {
      return nodes.map(node => {
        if (node.id === id) return { ...node, isOpen: !node.isOpen };
        if (node.children) return { ...node, children: toggleRecursive(node.children) };
        return node;
      });
    };
    setData(prev => toggleRecursive(prev));
  };

  const handleAdd = (parentId: string | null) => {
    setData(prev => {
      const usedIds = collectIds(prev);
      const newItem: TreeItem = {
        id: generateUniqueId(usedIds),
        title: '新项目',
        isOpen: true,
        children: []
      };

      if (!parentId) {
        setTimeout(() => setSelectedId(newItem.id), 50);
        return [...prev, newItem];
      }

      const addRecursive = (nodes: TreeItem[]): TreeItem[] => {
        return nodes.map(node => {
          if (node.id === parentId) {
            return { ...node, isOpen: true, children: [...(node.children || []), newItem] };
          }
          if (node.children) return { ...node, children: addRecursive(node.children) };
          return node;
        });
      };

      setTimeout(() => setSelectedId(newItem.id), 50);
      return addRecursive(prev);
    });
  };

  const handleDeleteRequest = (id: string) => {
    let hasChildren = false;
    const checkChildren = (nodes: TreeItem[]) => {
      for (const node of nodes) {
        if (node.id === id) {
          if (node.children && node.children.length > 0) hasChildren = true;
          return;
        }
        if (node.children) checkChildren(node.children);
      }
    };
    checkChildren(data);

    if (hasChildren) {
      setDeleteConfirmId(id);
    } else {
      confirmDelete(id);
    }
  };

  const confirmDelete = (id: string) => {
    const deleteRecursive = (nodes: TreeItem[]): TreeItem[] => {
      return nodes
        .filter(node => node.id !== id)
        .map(node => ({
          ...node,
          children: node.children ? deleteRecursive(node.children) : []
        }));
    };
    setData(prev => deleteRecursive(prev));
    setDeleteConfirmId(null);
    if (selectedId === id) setSelectedId(null);
  };

  const handleClearAll = () => {
    setData([]);
    setShowClearAllConfirm(false);
    setSelectedId(null);
  };

  const handleRename = (id: string, newTitle: string) => {
    const renameRecursive = (nodes: TreeItem[]): TreeItem[] => {
      return nodes.map(node => {
        if (node.id === id) return { ...node, title: newTitle };
        if (node.children) return { ...node, children: renameRecursive(node.children) };
        return node;
      });
    };
    setData(prev => renameRecursive(prev));
  };

  const handleSelect = (id: string) => {
    setSelectedId(id === selectedId ? null : id); 
  };

  // --- 鼠标拖动排序 ---

  const handleDragStart = (id: string) => {
    if (sortMode !== 'mouse') return;
    setDraggingId(id);
  };

  const handleDropOn = (targetId: string, position: InsertPosition) => {
    if (sortMode !== 'mouse' || !draggingId || draggingId === targetId) return;

    setData(prevData => {
      const moved = moveNodeInTree(prevData, draggingId, targetId, position);
      return moved ?? prevData;
    });

    setSelectedId(draggingId);
    setDraggingId(null);
  };

  const handlePreviewMove = (targetId: string, position: InsertPosition) => {
    if (sortMode !== 'mouse' || !draggingId || draggingId === targetId) return;
    setData(prevData => {
      const moved = moveNodeInTree(prevData, draggingId, targetId, position);
      return moved ?? prevData;
    });
  };

  const handleDragEnd = () => setDraggingId(null);

  // --- 6. 界面渲染 ---

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#F0F4FF] via-white to-[#E6F0FF] text-slate-800 p-8 font-sans selection:bg-[#D4E3FD]">
      <div className="max-w-3xl mx-auto pb-32">
        
        {/* --- 顶部工具栏 --- */}
        <div className="mb-10 flex justify-between items-center p-6 bg-white/40 backdrop-blur-xl rounded-[2rem] border border-white/60 shadow-xl shadow-[#D4E3FD]/30">
          {/* 标题区 */}
          <div>
            <div className="flex items-center gap-3 mb-1">
                <div className="p-2.5 bg-white/60 rounded-2xl shadow-sm ring-1 ring-black/5">
                    <LayoutList size={24} className="text-[#5B8DEF]" />
                </div>
            </div>
          </div>

          {/* 控制区 */}
          <div className="flex items-center gap-4">
            {/* 清空按钮 */}
            {data.length > 0 && (
                <button 
                  onClick={() => setShowClearAllConfirm(true)}
                  className="flex items-center justify-center w-11 h-11 rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50 transition-all border border-transparent hover:border-red-100"
                  title="删除全部"
                >
                  <Trash2 size={18} />
                </button>
            )}

            {/* 透明度控制器 */}
            <div className="flex items-center gap-2 bg-white/30 px-2 py-1.5 rounded-full border border-white/40">
                {/* 开关 */}
                <button 
                  onClick={() => setEnableOpacity(!enableOpacity)}
                  className={`
                    flex items-center justify-center w-9 h-9 rounded-full transition-all
                    ${enableOpacity ? 'bg-[#5B8DEF] text-white shadow-md shadow-[#5B8DEF]/30' : 'text-slate-400 hover:bg-white/50'}
                  `}
                  title={enableOpacity ? '关闭透明度' : '开启透明度'}
                >
                  {enableOpacity ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
                
                {/* 档位选择 */}
                <div className={`flex bg-white/50 rounded-full border border-slate-200 p-0.5 shadow-sm transition-opacity duration-300 ${enableOpacity ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                    {[1, 2, 3].map((mode) => (
                        <button
                            key={mode}
                            onClick={() => setOpacityMode(mode as OpacityMode)}
                            className={`
                                w-8 h-8 flex items-center justify-center rounded-full text-sm font-bold transition-all duration-200
                                ${opacityMode === mode 
                                    ? 'text-[#FFDF00] scale-125' 
                                    : 'text-slate-400 hover:text-slate-600 hover:bg-black/5'}
                            `}
                        >
                            {mode}
                        </button>
                    ))}
                </div>
            </div>

            {/* 排序模式切换 */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSortMode('keyboard')}
                className={`
                  flex items-center justify-center w-11 h-11 rounded-full transition-all
                  ${sortMode === 'keyboard' 
                    ? 'bg-[#4E7BFF] text-white shadow-lg shadow-[#4E7BFF]/40' 
                    : 'bg-white text-[#4E7BFF] border border-slate-200 shadow-sm hover:shadow-md'}
                `}
                title="键盘排序 (↑↓←→)"
              >
                <Keyboard size={18} />
              </button>
              <button
                onClick={() => setSortMode('mouse')}
                className={`
                  flex items-center justify-center w-11 h-11 rounded-full transition-all
                  ${sortMode === 'mouse' 
                    ? 'bg-[#10B981] text-white shadow-lg shadow-[#10B981]/40' 
                    : 'bg-white text-[#10B981] border border-slate-200 shadow-sm hover:shadow-md'}
                `}
                title="鼠标拖动排序"
              >
                <MousePointer2 size={18} />
              </button>
            </div>

            {/* 新建按钮 */}
            <button 
                onClick={() => handleAdd(null)}
                className="flex items-center justify-center w-11 h-11 bg-slate-800 hover:bg-black backdrop-blur-md text-white rounded-full transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5 active:scale-95"
                title="新建根项目"
            >
                <Plus size={24} />
            </button>
          </div>
        </div>

        {/* --- 列表主区域 --- */}
        <div className="min-h-[500px] relative z-10">
          {Array.isArray(data) && data.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 border-4 border-dashed border-white/40 rounded-[3rem] bg-white/10 backdrop-blur-sm">
              <p className="text-slate-400 mb-4 text-lg font-bold">暂无内容</p>
            </div>
          ) : (
            <ul className="space-y-4"> 
              {Array.isArray(data) && data.map((item, index) => (
                <TreeNode 
                  key={item.id} 
                  item={item}
                  index={index}
                  level={0}
                  parentOpacity={1}
                  enableOpacity={enableOpacity}
                  opacityMode={opacityMode}
                  deleteConfirmId={deleteConfirmId}
                  selectedId={selectedId}
                  sortMode={sortMode}
                  draggingId={draggingId}
                  onToggle={toggleOpen}
                  onAdd={handleAdd}
                  onDeleteRequest={handleDeleteRequest}
                  onConfirmDelete={confirmDelete}
                  onRename={handleRename}
                  onSelect={handleSelect}
                  onDragStart={handleDragStart}
                  onDrop={handleDropOn}
                  onPreviewMove={handlePreviewMove}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </ul>
          )}
        </div>

        {/* --- 全局弹窗：清空全部确认 --- */}
        {showClearAllConfirm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm transition-all" onClick={() => setShowClearAllConfirm(false)} />
            <div className="relative bg-white rounded-3xl p-6 shadow-2xl max-w-sm w-full animate-in fade-in zoom-in-95 duration-200 border border-red-100">
               <div className="flex items-center gap-3 mb-4 text-red-600">
                  <div className="p-2 bg-red-100 rounded-full"><Trash2 size={24} /></div>
                  <h3 className="text-xl font-bold text-slate-900">清空全部?</h3>
               </div>
               <div className="flex justify-end gap-3 mt-6">
                 <button onClick={() => setShowClearAllConfirm(false)} className="px-5 py-2.5 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition-colors">取消</button>
                 <button onClick={handleClearAll} className="px-5 py-2.5 rounded-xl font-medium bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/30 transition-all active:scale-95">确认清空</button>
               </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};

// --- 3. 递归树节点组件 (核心渲染逻辑) ---

const TreeNode: FC<TreeNodeProps> = ({ 
  item, index, level, parentOpacity, 
  enableOpacity, opacityMode, deleteConfirmId, selectedId, sortMode, draggingId,
  onToggle, onAdd, onDeleteRequest, onConfirmDelete, onRename, onSelect,
  onDragStart, onDrop, onPreviewMove, onDragEnd
}) => {
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editTitle, setEditTitle] = useState<string>(item.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const childListRef = useRef<HTMLUListElement | null>(null);
  const centerHoverStartRef = useRef<number | null>(null);

  // 判断当前节点是否被选中
  const isSelected = selectedId === item.id;

  // 进入编辑模式时自动聚焦
  useEffect(() => {
    if (isEditing && inputRef.current) inputRef.current.focus();
  }, [isEditing]);

  // 提交编辑
  const saveEdit = () => {
    if (editTitle.trim()) onRename(item.id, editTitle);
    else setEditTitle(item.title); // 如果为空则还原
    setIsEditing(false);
  };

  // 按键处理
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') saveEdit();
    if (e.key === 'Escape') { setEditTitle(item.title); setIsEditing(false); }
  };

  // --- 视觉逻辑核心：透明度计算 ---
  let localOpacity = 1;
  if (enableOpacity) {
    const faintOpacity = 0.01; // 极低透明度（几乎隐形）
    
    if (opacityMode === 1) {
      if (index === 0) localOpacity = 1;
      else localOpacity = faintOpacity;
    } else if (opacityMode === 2) {
      if (index === 0) localOpacity = 1;
      else if (index === 1) localOpacity = 0.5;
      else localOpacity = faintOpacity;
    } else if (opacityMode === 3) {
      if (index === 0) localOpacity = 1;
      else if (index === 1) localOpacity = 0.5;
      else if (index === 2) localOpacity = 0.15;
      else localOpacity = faintOpacity;
    }
  }
  
  // 最终透明度 = 继承父级透明度 * 当前行透明度
  const calculatedOpacity = parentOpacity * Math.max(0.01, localOpacity); 
  const currentOpacity = isSelected ? 1 : calculatedOpacity;

  const nodeStyle: CSSProperties = {
    opacity: currentOpacity,
    transition: 'all 0.3s ease',
    animation: draggingId ? 'drag-slide 0.32s cubic-bezier(0.25, 0.8, 0.25, 1)' : undefined,
    marginBottom: 0,
    transform: isSelected ? 'scale(1.01) translateX(4px)' : 'scale(1)',
    minWidth: MIN_NODE_WIDTH
  };

  // 容器 CSS 类名逻辑
  let containerClass = `
    group relative flex items-center gap-3
    bg-white/40 backdrop-blur-md border border-white/60 shadow-sm text-slate-700 rounded-full px-5 py-2
    hover:bg-white/80 cursor-pointer
    hover:!opacity-100 hover:shadow-[0_0_20px_rgba(255,255,255,0.8)] hover:border-white
    transition-all duration-300
  `;

  // 选中状态样式：使用新的淡蓝色主色 (#D4E3FD)
  if (isSelected) {
    containerClass = `
      group relative flex items-center gap-3
      bg-[#D4E3FD] backdrop-blur-xl border-2 border-[#7BA7F7] shadow-lg text-slate-800 rounded-full px-5 py-2
      cursor-pointer z-10 hover:!opacity-100
    `;
  }

  const isConfirmingDelete = deleteConfirmId === item.id;
  if (isConfirmingDelete) {
    containerClass = `relative flex items-center gap-3 bg-red-50/80 backdrop-blur-md border border-red-200 shadow-md text-slate-700 rounded-full px-5 py-2 cursor-pointer hover:!opacity-100`;
  }

  const isDragging = draggingId === item.id;
  if (isDragging) {
    containerClass += ' ring-2 ring-[#5B8DEF]/40';
  }

  return (
    <li 
      className="select-none transition-all duration-300 ease-in-out project-item" 
      style={{ 
        paddingLeft: level > 0 ? '2rem' : '0',
        zIndex: 50 - level * 5 - index
      }}
      draggable={sortMode === 'mouse'}
      onDragStart={(e: React.DragEvent<HTMLLIElement>) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
        if (TRANSPARENT_DRAG_IMAGE) {
          e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMAGE, 0, 0);
        }
        onDragStart(item.id);
      }}
      onDragOver={(e: React.DragEvent<HTMLLIElement>) => {
        if (sortMode === 'mouse') {
          e.preventDefault();
          e.stopPropagation();

          // 如果鼠标在子列表区域，交给子项处理，避免父级被误判
          if (item.isOpen && childListRef.current) {
            const childRect = childListRef.current.getBoundingClientRect();
            if (e.clientY >= childRect.top && e.clientY <= childRect.bottom) return;
          }

          if (draggingId && draggingId !== item.id) {
            const rect = (headerRef.current ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
            const y = e.clientY;
            const top = rect.top;
            const height = rect.height;
            const beforeZone = top + height * 0.4;
            const afterZone = top + height * 0.8;
            let position: InsertPosition = 'inside';

            // 中间区域需停留 0.5s 才视为 inside，否则按上下半区处理
            const inCenter = y >= beforeZone && y <= afterZone;
            if (inCenter) {
              if (centerHoverStartRef.current === null) {
                centerHoverStartRef.current = Date.now();
              }
              const elapsed = Date.now() - centerHoverStartRef.current;
              if (elapsed < 500) {
                position = y < top + height / 2 ? 'before' : 'after';
              }
            } else {
              centerHoverStartRef.current = null;
              position = y < beforeZone ? 'before' : 'after';
            }

            onPreviewMove(item.id, position);
          }
        }
      }}
      onDrop={(e: React.DragEvent<HTMLLIElement>) => {
        e.preventDefault();
        e.stopPropagation();

        if (item.isOpen && childListRef.current) {
          const childRect = childListRef.current.getBoundingClientRect();
          if (e.clientY >= childRect.top && e.clientY <= childRect.bottom) return;
        }

        const rect = (headerRef.current ?? (e.currentTarget as HTMLElement)).getBoundingClientRect();
        const y = e.clientY;
        const top = rect.top;
        const height = rect.height;
        const beforeZone = top + height * 0.1;
        const afterZone = top + height * 0.9;
        let position: InsertPosition = 'inside';
        const inCenter = y >= beforeZone && y <= afterZone;
        if (inCenter) {
          const elapsed = centerHoverStartRef.current ? Date.now() - centerHoverStartRef.current : 0;
          if (elapsed < 500) {
            position = y < top + height / 2 ? 'before' : 'after';
          }
        } else {
          position = y < beforeZone ? 'before' : 'after';
        }
        onDrop(item.id, position);
      }}
      onDragEnd={(e: React.DragEvent<HTMLLIElement>) => {
        e.stopPropagation();
        centerHoverStartRef.current = null;
        onDragEnd();
      }}
    >
      <div 
        className={containerClass}
        style={nodeStyle}
        ref={headerRef}
        onClick={(e: React.MouseEvent<HTMLDivElement>) => {
          e.stopPropagation();
          onSelect(item.id);
        }}
      >
        {/* 展开/收起 按钮 */}
        <div 
          className={`flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full cursor-pointer transition-all ${isSelected ? 'text-[#5B8DEF]' : 'hover:bg-black/5 text-slate-500'}`}
          onClick={(e) => { e.stopPropagation(); onToggle(item.id); }}
        >
           {item.children && item.children.length > 0 ? (
             item.isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />
           ) : (
             <Circle size={6} className="fill-current opacity-40 stroke-none" />
           )}
        </div>

        {/* 标题文本区 */}
        <div className="flex-1 truncate flex items-baseline mr-2">
          {isEditing ? (
            <input 
              ref={inputRef}
              value={editTitle}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditTitle(e.target.value)}
              onBlur={saveEdit}
              onKeyDown={handleKeyDown}
              className={`w-full bg-transparent border-b px-1 focus:outline-none ${isSelected ? 'border-[#5B8DEF]/50 text-slate-900' : 'border-slate-400/50 text-current'}`}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span 
              onClick={(e) => { e.stopPropagation(); }} 
              onDoubleClick={(e) => { e.stopPropagation(); setIsEditing(true); }}
              className="cursor-text hover:opacity-70 transition-opacity block w-full truncate"
              title="点击重命名"
            >
              {item.title}
            </span>
          )}
        </div>

        {/* 操作按钮组 (悬停或特定状态下显示) */}
        <div className={`
          flex items-center gap-1 
          ${isConfirmingDelete ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} 
          transition-all duration-200 
          translate-x-2 group-hover:translate-x-0 
          delete-action-area relative
        `}>
          {/* 添加子项按钮 */}
          <button 
            onClick={(e) => { e.stopPropagation(); onAdd(item.id); }} 
            className={`p-1.5 rounded-full transition-all active:scale-90 ${isSelected ? 'hover:bg-[#5B8DEF]/20 text-[#5B8DEF]' : 'hover:bg-black/5'}`}
            title="添加子项"
          >
            <Plus size={16} />
          </button>
          
          {/* 删除按钮容器 */}
          <div className="relative">
             <button 
               onClick={(e) => { e.stopPropagation(); onDeleteRequest(item.id); }} 
               className={`
                 p-1.5 rounded-full transition-all active:scale-90 
                 ${isConfirmingDelete ? 'bg-red-500 text-white' : 'hover:bg-red-500/10 hover:text-red-600'}
               `}
               title="删除"
             >
               <Trash2 size={16} />
             </button>
             
             {/* 局部二次确认气泡 (仅当该项目有子项目且点击删除时显示) */}
             {isConfirmingDelete && (
                <div className="absolute bottom-full mb-2 right-0 w-32 bg-white rounded-xl shadow-xl border border-slate-100 p-2 z-[100] animate-in slide-in-from-bottom-2 duration-200 text-slate-800" onClick={(e) => e.stopPropagation()}>
                   <div className="text-xs text-slate-500 text-center mb-2">含子项目，确认删除？</div>
                   <div className="flex justify-center gap-2">
                     <button onClick={(e) => { e.stopPropagation(); onConfirmDelete(item.id); }} className="flex-1 bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1 rounded-lg transition-colors flex justify-center items-center"><Check size={12} /></button>
                   </div>
                   <div className="absolute top-full right-2 w-2 h-2 bg-white rotate-45 -mt-1 border-r border-b border-slate-100"></div>
                </div>
             )}
          </div>
        </div>
      </div>

      {/* 递归渲染子列表 */}
      {item.isOpen && item.children.length > 0 && (
        <ul ref={childListRef} className="mt-2 space-y-2 border-l border-white/20 ml-6 pl-2 relative">
      {item.children.map((child, childIndex) => (
        <TreeNode 
          key={child.id} 
          item={child} 
          index={childIndex}
          level={level + 1}
          parentOpacity={currentOpacity} 
          enableOpacity={enableOpacity}
          opacityMode={opacityMode}
          deleteConfirmId={deleteConfirmId}
          selectedId={selectedId}
          sortMode={sortMode}
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
