import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FilePlus,
  FileText,
  Folder as FolderIcon,
  FolderPlus,
  Heart,
  Import,
  KeyRound,
  Grid2X2,
  List,
  Menu,
  Pencil,
  RotateCcw,
  Search,
  Shield,
  Sparkles,
  Star,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import './App.css';

type ItemType = 'folder' | 'snippet';
type SortMode = 'manual' | 'name' | 'newest' | 'oldest' | 'updated';
type FolderViewMode = 'grid' | 'list';
type SaveStatus = 'idle' | 'copied' | 'saved' | 'imported' | 'exported';

type BaseItem = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type Snippet = BaseItem & {
  type: 'snippet';
  content: string;
  favorite: boolean;
  tags: string[];
};

type Folder = BaseItem & {
  type: 'folder';
  color: string;
  children: TreeItem[];
};

type TreeItem = Folder | Snippet;

type DragPayload = {
  id: string;
  type: ItemType;
};

type DeletedDraft = {
  item: TreeItem;
  parentId: string | null;
};

type StorageManifest = {
  version: 2;
  rootIds: string[];
  itemIds: string[];
  updatedAt: number;
};

type SearchRecord = {
  id: string;
  type: ItemType;
  name: string;
  tags: string[];
  parentId: string | null;
  path: string;
};

const LEGACY_STORAGE_KEY = 'copy-paste.snippet-tree.v1';
const STORAGE_MANIFEST_KEY = 'copy-paste.storage-manifest.v2';
const STORAGE_ITEM_PREFIX = 'copy-paste.item.v2.';
const STORAGE_SEARCH_INDEX_KEY = 'copy-paste.search-index.v2';
const SIDEBAR_WIDTH_KEY = 'copy-paste.sidebar-width.v1';
const FOLDER_VIEW_KEY = 'copy-paste.folder-view.v1';
const LOCK_KEY = 'copy-paste.local-lock.v1';
const MAX_DEPTH = 4;
const MIN_SIDEBAR_WIDTH = 320;
const MAX_SIDEBAR_WIDTH = 560;
const FOLDER_COLORS = ['#16756f', '#2563eb', '#9333ea', '#d97706', '#dc2626', '#475569'];

const now = () => Date.now();

const makeId = () => {
  if ('crypto' in window && 'randomUUID' in window.crypto) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const createSnippet = (folderId: string | null): Snippet => {
  const timestamp = now();
  return {
    id: makeId(),
    type: 'snippet',
    name: folderId ? 'Folder snippet' : 'Root snippet',
    content: '',
    favorite: false,
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const createFolder = (name = 'New folder', color = FOLDER_COLORS[0]): Folder => {
  const timestamp = now();
  return { id: makeId(), type: 'folder', name, color, children: [], createdAt: timestamp, updatedAt: timestamp };
};

const demoData = (): TreeItem[] => [
  {
    ...createFolder('Examples', FOLDER_COLORS[1]),
    children: [
      {
        ...createSnippet(null),
        name: 'Preserved formatting',
        content: 'Hello,\n\nPaste anything here.\n  - spacing stays intact\n  - line breaks stay intact\n  - symbols: (c) (tm) ->',
        tags: ['example'],
      },
    ],
  },
];

const isFolder = (item: TreeItem): item is Folder => item.type === 'folder';

const normalizeTree = (items: any[]): TreeItem[] =>
  Array.isArray(items)
    ? items.map((item) => {
        const timestamp = now();
        if (item?.type === 'folder') {
          return {
            id: item.id ?? makeId(),
            type: 'folder',
            name: item.name ?? 'Untitled folder',
            color: item.color ?? FOLDER_COLORS[0],
            createdAt: item.createdAt ?? timestamp,
            updatedAt: item.updatedAt ?? timestamp,
            children: normalizeTree(item.children ?? []),
          };
        }

        return {
          id: item?.id ?? makeId(),
          type: 'snippet',
          name: item?.name ?? 'Untitled text',
          content: item?.content ?? '',
          favorite: Boolean(item?.favorite),
          tags: Array.isArray(item?.tags) ? item.tags : [],
          createdAt: item?.createdAt ?? timestamp,
          updatedAt: item?.updatedAt ?? timestamp,
        };
      })
    : demoData();

const loadTree = (): TreeItem[] => {
  try {
    const manifestRaw = localStorage.getItem(STORAGE_MANIFEST_KEY);
    if (manifestRaw) {
      const manifest = JSON.parse(manifestRaw) as StorageManifest;
      const items = manifest.rootIds.map((id) => readStoredItem(id)).filter(Boolean) as TreeItem[];
      return normalizeTree(items);
    }

    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? normalizeTree(JSON.parse(raw)) : demoData();
  } catch {
    return demoData();
  }
};

const itemStorageKey = (id: string) => `${STORAGE_ITEM_PREFIX}${id}`;

const readStoredItem = (id: string, seen = new Set<string>()): TreeItem | null => {
  if (seen.has(id)) return null;
  seen.add(id);

  const raw = localStorage.getItem(itemStorageKey(id));
  if (!raw) return null;
  const stored = JSON.parse(raw);

  if (stored?.type === 'folder') {
    return {
      id: stored.id ?? id,
      type: 'folder',
      name: stored.name ?? 'Untitled folder',
      color: stored.color ?? FOLDER_COLORS[0],
      createdAt: stored.createdAt ?? now(),
      updatedAt: stored.updatedAt ?? now(),
      children: Array.isArray(stored.childIds)
        ? (stored.childIds.map((childId: string) => readStoredItem(childId, seen)).filter(Boolean) as TreeItem[])
        : [],
    };
  }

  if (stored?.type === 'snippet') {
    return {
      id: stored.id ?? id,
      type: 'snippet',
      name: stored.name ?? 'Untitled text',
      content: stored.content ?? '',
      favorite: Boolean(stored.favorite),
      tags: Array.isArray(stored.tags) ? stored.tags : [],
      createdAt: stored.createdAt ?? now(),
      updatedAt: stored.updatedAt ?? now(),
    };
  }

  return null;
};

const saveTreeToStorage = (items: TreeItem[]) => {
  const previousManifestRaw = localStorage.getItem(STORAGE_MANIFEST_KEY);
  const previousIds = new Set<string>();
  if (previousManifestRaw) {
    try {
      const previousManifest = JSON.parse(previousManifestRaw) as StorageManifest;
      previousManifest.itemIds.forEach((id) => previousIds.add(id));
    } catch {
      // Ignore corrupt manifests and rewrite the storage shape below.
    }
  }

  const itemIds = new Set<string>();
  const searchRecords: SearchRecord[] = [];

  const writeItem = (item: TreeItem, parentId: string | null, parentPath: string[]) => {
    const pathParts = [...parentPath, item.name];
    itemIds.add(item.id);
    searchRecords.push({
      id: item.id,
      type: item.type,
      name: item.name,
      tags: item.type === 'snippet' ? item.tags : [],
      parentId,
      path: pathParts.join(' / '),
    });

    if (isFolder(item)) {
      localStorage.setItem(
        itemStorageKey(item.id),
        JSON.stringify({
          id: item.id,
          type: item.type,
          name: item.name,
          color: item.color,
          childIds: item.children.map((child) => child.id),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })
      );
      item.children.forEach((child) => writeItem(child, item.id, pathParts));
      return;
    }

    localStorage.setItem(
      itemStorageKey(item.id),
      JSON.stringify({
        id: item.id,
        type: item.type,
        name: item.name,
        content: item.content,
        favorite: item.favorite,
        tags: item.tags,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })
    );
  };

  items.forEach((item) => writeItem(item, null, ['Root']));

  previousIds.forEach((id) => {
    if (!itemIds.has(id)) localStorage.removeItem(itemStorageKey(id));
  });

  localStorage.setItem(
    STORAGE_SEARCH_INDEX_KEY,
    JSON.stringify({ version: 2, updatedAt: now(), records: searchRecords })
  );
  localStorage.setItem(
    STORAGE_MANIFEST_KEY,
    JSON.stringify({ version: 2, rootIds: items.map((item) => item.id), itemIds: Array.from(itemIds), updatedAt: now() })
  );
  localStorage.removeItem(LEGACY_STORAGE_KEY);
};

const loadSidebarWidth = () => {
  const width = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(width)) return 420;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
};

const loadFolderViewMode = (): FolderViewMode => (localStorage.getItem(FOLDER_VIEW_KEY) === 'list' ? 'list' : 'grid');

const getRootFolderIds = (items: TreeItem[]): Set<string> => new Set(items.filter(isFolder).map((folder) => folder.id));

const findItem = (items: TreeItem[], id: string): TreeItem | null => {
  for (const item of items) {
    if (item.id === id) return item;
    if (isFolder(item)) {
      const found = findItem(item.children, id);
      if (found) return found;
    }
  }
  return null;
};

const getItemDepth = (items: TreeItem[], id: string, depth = 1): number | null => {
  for (const item of items) {
    if (item.id === id) return depth;
    if (isFolder(item)) {
      const found = getItemDepth(item.children, id, depth + 1);
      if (found) return found;
    }
  }
  return null;
};

const maxDepthInside = (item: TreeItem): number =>
  !isFolder(item) || item.children.length === 0 ? 1 : 1 + Math.max(...item.children.map(maxDepthInside));

const findParentId = (items: TreeItem[], id: string, parentId: string | null = null): string | null | undefined => {
  for (const item of items) {
    if (item.id === id) return parentId;
    if (isFolder(item)) {
      const found = findParentId(item.children, id, item.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const addItemToFolder = (items: TreeItem[], folderId: string | null, newItem: TreeItem): TreeItem[] => {
  if (!folderId) return [...items, newItem];
  return items.map((item) => {
    if (item.id === folderId && isFolder(item)) return { ...item, children: [...item.children, newItem], updatedAt: now() };
    return isFolder(item) ? { ...item, children: addItemToFolder(item.children, folderId, newItem) } : item;
  });
};

const updateItem = (items: TreeItem[], id: string, updater: (item: TreeItem) => TreeItem): TreeItem[] =>
  items.map((item) => (item.id === id ? updater(item) : isFolder(item) ? { ...item, children: updateItem(item.children, id, updater) } : item));

const removeItem = (items: TreeItem[], id: string): { items: TreeItem[]; removed: TreeItem | null } => {
  let removed: TreeItem | null = null;
  const next = items
    .map((item) => {
      if (item.id === id) {
        removed = item;
        return null;
      }
      if (isFolder(item)) {
        const childResult = removeItem(item.children, id);
        if (childResult.removed) {
          removed = childResult.removed;
          return { ...item, children: childResult.items, updatedAt: now() };
        }
      }
      return item;
    })
    .filter(Boolean) as TreeItem[];
  return { items: next, removed };
};

const isDescendant = (item: TreeItem, id: string): boolean =>
  isFolder(item) && item.children.some((child) => child.id === id || isDescendant(child, id));

const collectFolderIds = (items: TreeItem[]): string[] =>
  items.flatMap((item) => (isFolder(item) ? [item.id, ...collectFolderIds(item.children)] : []));

const countItems = (items: TreeItem[]): { folders: number; snippets: number } =>
  items.reduce(
    (total, item) => {
      if (isFolder(item)) {
        const childCount = countItems(item.children);
        return { folders: total.folders + 1 + childCount.folders, snippets: total.snippets + childCount.snippets };
      }
      return { ...total, snippets: total.snippets + 1 };
    },
    { folders: 0, snippets: 0 }
  );

const getFolderOptions = (items: TreeItem[], excludedId?: string, depth = 1): Array<{ id: string | null; name: string; depth: number }> => {
  const options: Array<{ id: string | null; name: string; depth: number }> = depth === 1 ? [{ id: null, name: 'Root', depth: 0 }] : [];
  items.forEach((item) => {
    if (isFolder(item) && item.id !== excludedId) {
      options.push({ id: item.id, name: item.name, depth });
      options.push(...getFolderOptions(item.children, excludedId, depth + 1).filter((option) => option.id !== null));
    }
  });
  return options;
};

const getBreadcrumb = (items: TreeItem[], id: string | null, trail: string[] = ['Root']): string[] => {
  if (!id) return trail;
  for (const item of items) {
    if (item.id === id) return [...trail, item.name];
    if (isFolder(item)) {
      const found = getBreadcrumb(item.children, id, [...trail, item.name]);
      if (found[found.length - 1] !== trail[trail.length - 1]) return found;
    }
  }
  return trail;
};

const flattenSnippets = (items: TreeItem[]): Snippet[] =>
  items.flatMap((item) => (isFolder(item) ? flattenSnippets(item.children) : [item]));

const collectSelectedItems = (items: TreeItem[], selectedIds: Set<string>): TreeItem[] =>
  items.flatMap((item) => {
    if (selectedIds.has(item.id)) return [item];
    return isFolder(item) ? collectSelectedItems(item.children, selectedIds) : [];
  });

const itemMatches = (item: TreeItem, query: string): boolean => {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  const selfMatches = item.name.toLowerCase().includes(value) || (item.type === 'snippet' && item.tags.some((tag) => tag.toLowerCase().includes(value)));
  return selfMatches || (isFolder(item) && item.children.some((child) => itemMatches(child, value)));
};

const getMatchingTags = (snippet: Snippet, query: string) => {
  const value = query.trim().toLowerCase();
  if (!value) return [];
  return snippet.tags.filter((tag) => tag.toLowerCase().includes(value));
};

const highlightMatch = (value: string, query: string) => {
  const needle = query.trim();
  if (!needle) return value;

  const index = value.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return value;

  return (
    <>
      {value.slice(0, index)}
      <mark>{value.slice(index, index + needle.length)}</mark>
      {value.slice(index + needle.length)}
    </>
  );
};

const sortTree = (items: TreeItem[], sortMode: SortMode): TreeItem[] => {
  const copy = [...items].map((item) => (isFolder(item) ? { ...item, children: sortTree(item.children, sortMode) } : item));
  return copy.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (sortMode === 'manual') return 0;
    if (sortMode === 'name') return a.name.localeCompare(b.name);
    if (sortMode === 'newest') return b.createdAt - a.createdAt;
    if (sortMode === 'oldest') return a.createdAt - b.createdAt;
    return b.updatedAt - a.updatedAt;
  });
};

const cloneItem = (item: TreeItem): TreeItem => {
  const timestamp = now();
  if (isFolder(item)) {
    return {
      ...item,
      id: makeId(),
      name: `${item.name} copy`,
      createdAt: timestamp,
      updatedAt: timestamp,
      children: item.children.map(cloneItem),
    };
  }
  return { ...item, id: makeId(), name: `${item.name} copy`, createdAt: timestamp, updatedAt: timestamp };
};

const getWordCount = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

const formatSavedTime = (timestamp?: number) => {
  if (!timestamp) return 'Not saved yet';
  const seconds = Math.max(1, Math.round((now() - timestamp) / 1000));
  if (seconds < 60) return `Saved ${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Saved ${minutes}m ago`;
  return `Saved ${Math.round(minutes / 60)}h ago`;
};

const getStatusMessage = (status: SaveStatus) => {
  if (status === 'copied') return 'Copied to clipboard';
  if (status === 'imported') return 'Backup imported';
  if (status === 'exported') return 'Backup exported';
  if (status === 'saved') return 'Saved locally';
  return 'Ready';
};

const hashValue = async (value: string) => {
  if (!window.crypto?.subtle) return btoa(value);
  const bytes = new TextEncoder().encode(value);
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

function App() {
  const [tree, setTree] = useState<TreeItem[]>(loadTree);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedSnippetId, setSelectedSnippetId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [dragged, setDragged] = useState<DragPayload | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => getRootFolderIds(tree));
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deletedDraft, setDeletedDraft] = useState<DeletedDraft | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [showSafety, setShowSafety] = useState(false);
  const [locked, setLocked] = useState(() => Boolean(localStorage.getItem(LOCK_KEY)));
  const [lockInput, setLockInput] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [folderViewMode, setFolderViewMode] = useState<FolderViewMode>(loadFolderViewMode);
  const importInputRef = useRef<HTMLInputElement>(null);

  const activeFolder = selectedFolderId ? (findItem(tree, selectedFolderId) as Folder | null) : null;
  const selectedSnippet = selectedSnippetId ? findItem(tree, selectedSnippetId) : null;
  const activeSnippet = selectedSnippet?.type === 'snippet' ? selectedSnippet : null;
  const currentFolderItems = useMemo(() => sortTree(activeFolder ? activeFolder.children : tree, sortMode), [activeFolder, tree, sortMode]);
  const totals = useMemo(() => countItems(tree), [tree]);
  const folderOptions = useMemo(() => getFolderOptions(tree), [tree]);
  const visibleTree = useMemo(() => sortTree(tree, sortMode), [tree, sortMode]);
  const allSnippets = useMemo(() => flattenSnippets(tree), [tree]);
  const favoriteSnippets = allSnippets.filter((snippet) => snippet.favorite);
  const breadcrumb = getBreadcrumb(tree, activeSnippet ? selectedFolderId : selectedFolderId);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      try {
        saveTreeToStorage(tree);
      } catch {
        window.alert('Browser storage is full. Export a backup before adding more text.');
      }
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [tree]);

  useEffect(() => {
    if (saveStatus === 'idle') return;
    const timeout = window.setTimeout(() => setSaveStatus('idle'), 1400);
    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(FOLDER_VIEW_KEY, folderViewMode);
  }, [folderViewMode]);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const onPointerMove = (event: PointerEvent) => {
      const nextWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX));
      setSidebarWidth(nextWidth);
    };
    const onPointerUp = () => setIsResizingSidebar(false);

    document.body.classList.add('is-resizing-sidebar');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        addSnippet();
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        addFolder();
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        setSaveStatus('saved');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const selectFolder = (folderId: string | null) => {
    setSelectedFolderId(folderId);
    setSelectedSnippetId(null);
    setMobileNavOpen(false);
  };

  const selectSnippet = (snippetId: string, folderId: string | null) => {
    setSelectedSnippetId(snippetId);
    setSelectedFolderId(folderId);
    setMobileNavOpen(false);
  };

  const addFolder = () => {
    const parentDepth = selectedFolderId ? getItemDepth(tree, selectedFolderId) ?? 1 : 0;
    if (parentDepth >= MAX_DEPTH) {
      window.alert(`Folders can only be nested ${MAX_DEPTH} levels deep.`);
      return;
    }
    const name = window.prompt('Folder name', 'New folder')?.trim();
    if (!name) return;
    const folder = createFolder(name);
    setTree((items) => addItemToFolder(items, selectedFolderId, folder));
    if (selectedFolderId) setExpandedFolderIds((current) => new Set(current).add(selectedFolderId));
    setSelectedFolderId(folder.id);
    setSelectedSnippetId(null);
  };

  const addSnippet = () => {
    const snippet = createSnippet(selectedFolderId);
    setTree((items) => addItemToFolder(items, selectedFolderId, snippet));
    if (selectedFolderId) setExpandedFolderIds((current) => new Set(current).add(selectedFolderId));
    setSelectedSnippetId(snippet.id);
  };

  const renameItem = (item: TreeItem) => {
    const nextName = window.prompt(`Rename ${item.type}`, item.name)?.trim();
    if (!nextName || nextName === item.name) return;
    setTree((items) => updateItem(items, item.id, (current) => ({ ...current, name: nextName, updatedAt: now() })));
  };

  const deleteItem = (item: TreeItem) => {
    const childWarning = isFolder(item) && item.children.length > 0 ? ' and everything inside it' : '';
    if (!window.confirm(`Delete "${item.name}"${childWarning}?`)) return;
    const parentId = findParentId(tree, item.id) ?? null;
    setDeletedDraft({ item, parentId });
    setTree((items) => removeItem(items, item.id).items);
    setSelectedIds((ids) => {
      const next = new Set(ids);
      next.delete(item.id);
      return next;
    });
    if (selectedFolderId === item.id) setSelectedFolderId(null);
    if (selectedSnippetId === item.id || (isFolder(item) && selectedSnippetId && isDescendant(item, selectedSnippetId))) setSelectedSnippetId(null);
  };

  const restoreDeleted = () => {
    if (!deletedDraft) return;
    setTree((items) => addItemToFolder(items, deletedDraft.parentId, deletedDraft.item));
    setDeletedDraft(null);
  };

  const moveItem = (itemId: string, targetFolderId: string | null) => {
    const movingItem = findItem(tree, itemId);
    if (!movingItem || movingItem.id === targetFolderId) return;
    if (targetFolderId && isDescendant(movingItem, targetFolderId)) {
      window.alert('A folder cannot be moved inside itself.');
      return;
    }
    const targetDepth = targetFolderId ? getItemDepth(tree, targetFolderId) ?? 1 : 0;
    if (targetDepth + maxDepthInside(movingItem) > MAX_DEPTH) {
      window.alert(`That move would exceed the ${MAX_DEPTH}-level folder limit.`);
      return;
    }
    setTree((items) => {
      const result = removeItem(items, itemId);
      return result.removed ? addItemToFolder(result.items, targetFolderId, { ...result.removed, updatedAt: now() }) : items;
    });
    if (movingItem.type === 'snippet') setSelectedFolderId(targetFolderId);
  };

  const duplicateItem = (item: TreeItem) => {
    const parentId = findParentId(tree, item.id) ?? null;
    const copyItem = cloneItem(item);
    setTree((items) => addItemToFolder(items, parentId, copyItem));
    if (copyItem.type === 'snippet') selectSnippet(copyItem.id, parentId);
  };

  const updateSnippetField = (field: 'name' | 'content', value: string) => {
    if (!activeSnippet) return;
    setTree((items) =>
      updateItem(items, activeSnippet.id, (item) => {
        if (item.type !== 'snippet') return item;
        const autoName = field === 'content' && item.name.trim() === '' ? value.split('\n')[0].slice(0, 60) || item.name : item.name;
        return { ...item, [field]: value, name: field === 'content' ? autoName : value, updatedAt: now() };
      })
    );
    setSaveStatus('saved');
  };

  const updateSnippetTags = (value: string) => {
    if (!activeSnippet) return;
    const tags = value.split(',').map((tag) => tag.trim()).filter(Boolean);
    setTree((items) => updateItem(items, activeSnippet.id, (item) => (item.type === 'snippet' ? { ...item, tags, updatedAt: now() } : item)));
  };

  const toggleFavorite = (snippet: Snippet) => {
    setTree((items) => updateItem(items, snippet.id, (item) => (item.type === 'snippet' ? { ...item, favorite: !item.favorite, updatedAt: now() } : item)));
  };

  const copySnippet = async (snippet: Snippet) => {
    try {
      await navigator.clipboard.writeText(snippet.content);
      setSaveStatus('copied');
    } catch {
      window.alert('Copy failed. Your browser may require HTTPS or clipboard permission.');
    }
  };

  const copySelected = async () => {
    const snippets = allSnippets.filter((snippet) => selectedIds.has(snippet.id));
    if (snippets.length === 0) return;
    await navigator.clipboard.writeText(snippets.map((snippet) => snippet.content).join('\n\n'));
    setSaveStatus('copied');
  };

  const deleteSelected = () => {
    if (selectedIds.size === 0 || !window.confirm(`Delete ${selectedIds.size} selected item(s)?`)) return;
    setTree((items) => Array.from(selectedIds).reduce((current, id) => removeItem(current, id).items, items));
    setSelectedIds(new Set());
  };

  const exportData = (items: TreeItem[] = tree, filename = 'copy-paste-backup.json') => {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setSaveStatus('exported');
  };

  const importData = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const nextTree = normalizeTree(Array.isArray(parsed) ? parsed : parsed.items);
      setTree(nextTree);
      setExpandedFolderIds(getRootFolderIds(nextTree));
      setSelectedFolderId(null);
      setSelectedSnippetId(null);
      setSaveStatus('imported');
    } catch {
      window.alert('Import failed. Please choose a valid backup JSON file.');
    }
  };

  const clearAllData = () => {
    if (!window.confirm('Clear all folders and snippets from this browser?')) return;
    const nextTree = demoData();
    setTree(nextTree);
    setExpandedFolderIds(getRootFolderIds(nextTree));
    setSelectedIds(new Set());
    setSelectedFolderId(null);
    setSelectedSnippetId(null);
  };

  const setLocalLock = async () => {
    const pin = window.prompt('Create a local unlock code');
    if (!pin) return;
    localStorage.setItem(LOCK_KEY, await hashValue(pin));
    setLocked(true);
  };

  const unlock = async () => {
    if ((await hashValue(lockInput)) === localStorage.getItem(LOCK_KEY)) setLocked(false);
    else window.alert('Unlock code did not match.');
  };

  const removeLocalLock = async () => {
    const storedLock = localStorage.getItem(LOCK_KEY);
    if (!storedLock) {
      window.alert('No local lock is set.');
      return;
    }
    const pin = window.prompt('Enter current unlock code to remove lock');
    if (!pin) return;
    if ((await hashValue(pin)) !== storedLock) {
      window.alert('Unlock code did not match.');
      return;
    }
    localStorage.removeItem(LOCK_KEY);
    setLocked(false);
    setLockInput('');
    setSaveStatus('saved');
  };

  const handleDrop = (event: React.DragEvent, folderId: string | null) => {
    event.preventDefault();
    const payloadText = event.dataTransfer.getData('application/json');
    const payload = dragged ?? (payloadText ? (JSON.parse(payloadText) as DragPayload) : null);
    if (!payload) return;
    moveItem(payload.id, folderId);
    setDragged(null);
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderTree = (items: TreeItem[], depth = 1, parentId: string | null = null): React.ReactNode =>
    items
      .filter((item) => itemMatches(item, search))
      .map((item) => {
        const selected = item.id === selectedFolderId || item.id === selectedSnippetId;
        const canNest = item.type === 'folder' && depth < MAX_DEPTH;
        const expanded = item.type === 'folder' && (expandedFolderIds.has(item.id) || search.trim().length > 0);
        const childCount = item.type === 'folder' ? item.children.length : 0;
        const folderColor = item.type === 'folder' ? item.color : undefined;
        const matchingTags = item.type === 'snippet' ? getMatchingTags(item, search) : [];

        return (
          <div className="tree-row-wrap" key={item.id}>
            <div
              className={`tree-row ${selected ? 'selected' : ''} ${item.type}`}
              style={{ paddingLeft: `${10 + (depth - 1) * 18}px`, '--folder-color': folderColor } as React.CSSProperties}
              draggable
              onDragStart={(event) => {
                const payload = { id: item.id, type: item.type };
                setDragged(payload);
                event.dataTransfer.setData('application/json', JSON.stringify(payload));
              }}
              onDragEnd={() => setDragged(null)}
              onDragOver={(event) => {
                if (item.type === 'folder' && canNest) event.preventDefault();
              }}
              onDrop={(event) => {
                if (item.type === 'folder') handleDrop(event, item.id);
              }}
              onContextMenu={(event) => {
                if (item.type !== 'folder') return;
                const target = event.target as HTMLElement;
                if (target.closest('.row-actions') || target.closest('.row-check')) return;
                event.preventDefault();
                toggleFolder(item.id);
              }}
            >
              <input className="row-check" type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} aria-label={`Select ${item.name}`} />
              {item.type === 'folder' ? (
                <button className="expand-button" type="button" onClick={() => toggleFolder(item.id)} title={expanded ? 'Collapse folder' : 'Expand folder'}>
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
              ) : null}
              <button className="tree-main" type="button" onClick={() => (item.type === 'folder' ? selectFolder(item.id) : selectSnippet(item.id, parentId))} title={item.name}>
                <span className="tree-icon">{item.type === 'folder' ? <FolderIcon size={17} /> : <FileText size={17} />}</span>
                <span className="tree-content">
                  <span className="tree-title-line">
                    <span className="tree-name">{highlightMatch(item.name, search)}</span>
                    {item.type === 'folder' && <span className="tree-count">{childCount}</span>}
                    {item.type === 'snippet' && item.favorite && <Star className="favorite-dot" size={14} fill="currentColor" />}
                  </span>
                  {matchingTags.length > 0 && (
                    <span className="tree-tags">
                      {matchingTags.map((tag) => (
                        <span key={tag}>#{highlightMatch(tag, search)}</span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              <div className="row-actions">
                {item.type === 'snippet' && (
                  <button className="icon-button" type="button" onClick={() => copySnippet(item)} title="Copy snippet">
                    <Copy size={15} />
                    <span className="sr-only">Copy snippet</span>
                  </button>
                )}
                <button className="icon-button" type="button" onClick={() => duplicateItem(item)} title="Duplicate">
                  <Archive size={15} />
                  <span className="sr-only">Duplicate</span>
                </button>
                <button className="icon-button" type="button" onClick={() => renameItem(item)} title="Rename">
                  <Pencil size={15} />
                  <span className="sr-only">Rename</span>
                </button>
                <button className="icon-button danger" type="button" onClick={() => deleteItem(item)} title="Delete">
                  <Trash2 size={15} />
                  <span className="sr-only">Delete</span>
                </button>
              </div>
            </div>
            {isFolder(item) && expanded && item.children.length > 0 && <div>{renderTree(item.children, depth + 1, item.id)}</div>}
          </div>
        );
      });

  if (locked) {
    return (
      <main className="lock-screen">
        <section className="lock-card">
          <Shield size={34} />
          <h1>Copy Paste is locked</h1>
          <input value={lockInput} onChange={(event) => setLockInput(event.target.value)} type="password" placeholder="Unlock code" />
          <button type="button" onClick={unlock}>Unlock</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell" style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      <aside className={`sidebar ${mobileNavOpen ? 'open' : ''}`}>
        <div className="brand">
          <div>
            <p className="eyebrow">Local clipboard</p>
            <h1>Copy Paste</h1>
          </div>
          <button className="mobile-close" type="button" onClick={() => setMobileNavOpen(false)} title="Close navigation">x</button>
        </div>

        <div className="sidebar-controls">
          <label className="search-box">
            <span>Search</span>
            <div className="search-input-wrap">
              <Search size={16} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title or tag..." />
            </div>
          </label>

          <div className="create-row">
            <button type="button" onClick={addFolder}><FolderPlus size={17} />Folder</button>
            <button type="button" onClick={() => addSnippet()}><FilePlus size={17} />Text</button>
          </div>

          <div className="sidebar-action-row">
            <div className="quick-panel">
              <button className="icon-action mobile-command" type="button" onClick={() => setCommandOpen(true)} title="Command palette" aria-label="Command palette"><Sparkles size={17} /></button>
              <button className="icon-action" type="button" onClick={() => setExpandedFolderIds(new Set(collectFolderIds(tree)))} title="Expand all folders" aria-label="Expand all folders"><ChevronDown size={17} /></button>
              <button className="icon-action" type="button" onClick={() => setExpandedFolderIds(new Set())} title="Collapse all folders" aria-label="Collapse all folders"><ChevronRight size={17} /></button>
            </div>

            <label className="sort-row">
              <span>Sort</span>
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
                <option value="manual">Manual</option>
                <option value="name">Name</option>
                <option value="updated">Recently updated</option>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
              </select>
            </label>
          </div>
        </div>

        <button className={`root-drop ${selectedFolderId === null && !selectedSnippetId ? 'selected' : ''}`} type="button" onClick={() => selectFolder(null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleDrop(event, null)}>
          <span>Root</span>
          <small>{totals.folders} folders - {totals.snippets} texts</small>
        </button>

        {favoriteSnippets.length > 0 && (
          <section className="rail-section">
            <h2><Star size={14} /> Favorites</h2>
            {favoriteSnippets.slice(0, 4).map((snippet) => (
              <button key={snippet.id} type="button" onClick={() => selectSnippet(snippet.id, findParentId(tree, snippet.id) ?? null)}>{snippet.name}</button>
            ))}
          </section>
        )}

        {selectedIds.size > 0 && (
          <section className="bulk-bar">
            <strong>{selectedIds.size} selected</strong>
            <div className="bulk-actions">
              <button className="icon-action" type="button" onClick={copySelected} title="Copy selected texts" aria-label="Copy selected texts"><Copy size={16} /></button>
              <button className="icon-action" type="button" onClick={() => exportData(collectSelectedItems(tree, selectedIds), 'copy-paste-selection.json')} title="Export selected" aria-label="Export selected"><Download size={16} /></button>
              <button className="icon-action danger" type="button" onClick={deleteSelected} title="Delete selected" aria-label="Delete selected"><Trash2 size={16} /></button>
            </div>
          </section>
        )}

        <nav className="tree" aria-label="Saved text snippets">
          {renderTree(visibleTree)}
          {visibleTree.filter((item) => itemMatches(item, search)).length === 0 && <p className="empty-state">No matching items.</p>}
        </nav>
      </aside>
      <button
        className="sidebar-resizer"
        type="button"
        aria-label="Resize sidebar"
        title="Drag to resize sidebar"
        onPointerDown={(event) => {
          event.preventDefault();
          setIsResizingSidebar(true);
        }}
        onDoubleClick={() => setSidebarWidth(420)}
      />

      <section className="workspace">
        <div className="workspace-grid">
          <section className="editor-panel">
            <div className="panel-header">
              <div className="panel-title">
                <button className="nav-toggle" type="button" onClick={() => setMobileNavOpen(true)} title="Browse" aria-label="Browse">
                  <Menu size={18} />
                  <span className="sr-only">Browse</span>
                </button>
                <div>
                  <h3>{activeSnippet ? 'Text editor' : activeFolder ? 'Folder selected' : 'Root selected'}</h3>
                  <p className="breadcrumb">{breadcrumb.join(' / ')}</p>
                </div>
              </div>
              <div className="top-actions">
                {deletedDraft && <button className="icon-action" type="button" onClick={restoreDeleted} title="Undo delete" aria-label="Undo delete"><RotateCcw size={18} /></button>}
                {activeSnippet && (
                  <>
                    <button className={`icon-action ${activeSnippet.favorite ? 'active-action' : ''}`} type="button" onClick={() => toggleFavorite(activeSnippet)} title={activeSnippet.favorite ? 'Remove favorite' : 'Add favorite'} aria-label={activeSnippet.favorite ? 'Remove favorite' : 'Add favorite'}><Heart size={18} /></button>
                    <button className="icon-action" type="button" onClick={() => copySnippet(activeSnippet)} title="Copy text" aria-label="Copy text"><Copy size={18} /></button>
                    <button className="icon-action" type="button" onClick={() => duplicateItem(activeSnippet)} title="Duplicate" aria-label="Duplicate"><Archive size={18} /></button>
                    <button className="icon-action danger" type="button" onClick={() => deleteItem(activeSnippet)} title="Delete text" aria-label="Delete text"><Trash2 size={18} /></button>
                  </>
                )}
              </div>
            </div>

            <div className="utility-strip">
              <select
                value={selectedFolderId ?? 'root'}
                onChange={(event) => {
                  const target = event.target.value === 'root' ? null : event.target.value;
                  if (activeSnippet) moveItem(activeSnippet.id, target);
                  else setSelectedFolderId(target);
                }}
                title="Move selected text"
              >
                {folderOptions.map((folder) => <option key={folder.id ?? 'root'} value={folder.id ?? 'root'}>{'  '.repeat(folder.depth)}{folder.name}</option>)}
              </select>
              <button className="icon-action" type="button" onClick={() => exportData()} title="Export backup" aria-label="Export backup"><Download size={17} /></button>
              <button className="icon-action" type="button" onClick={() => importInputRef.current?.click()} title="Import backup" aria-label="Import backup"><Upload size={17} /></button>
              <button className="icon-action" type="button" onClick={() => setShowSafety((value) => !value)} title="Safety tools" aria-label="Safety tools"><Shield size={17} /></button>
              <input ref={importInputRef} className="hidden-file" type="file" accept="application/json" onChange={(event) => event.target.files?.[0] && importData(event.target.files[0])} />
              {activeFolder && (
                <div className="folder-color-row">
                  <span>Folder color</span>
                  {FOLDER_COLORS.map((color) => (
                    <button
                      key={color}
                      className={`color-swatch ${activeFolder.color === color ? 'selected' : ''}`}
                      style={{ background: color }}
                      type="button"
                      title={color}
                      onClick={() => setTree((items) => updateItem(items, activeFolder.id, (item) => (item.type === 'folder' ? { ...item, color, updatedAt: now() } : item)))}
                    />
                  ))}
                </div>
              )}
            </div>

            {showSafety && (
              <section className="safety-panel">
                <button type="button" onClick={setLocalLock}><KeyRound size={16} />Set local lock</button>
                <button type="button" onClick={removeLocalLock}><KeyRound size={16} />Remove lock</button>
                <button className="danger" type="button" onClick={clearAllData}><Trash2 size={16} />Clear all data</button>
                <p>Everything stays in this browser. Export a backup before clearing browser data.</p>
              </section>
            )}

            {activeSnippet ? (
              <>
                <div className="editor-meta">
                  <label className="meta-field title-field">
                    <span><FileText size={16} />Title</span>
                    <input className="title-input" value={activeSnippet.name} onChange={(event) => updateSnippetField('name', event.target.value)} placeholder="Snippet title" />
                  </label>
                  <label className="meta-field">
                    <span><Tags size={16} />Tags</span>
                    <input value={activeSnippet.tags.join(', ')} onChange={(event) => updateSnippetTags(event.target.value)} placeholder="Add tags separated by commas" />
                  </label>
                </div>

                <div className="single-editor">
                  <textarea value={activeSnippet.content} onChange={(event) => updateSnippetField('content', event.target.value)} placeholder="Write or paste your text here..." spellCheck="true" />
                </div>

                <footer className="editor-footer">
                  <span>{activeSnippet.content.length} characters</span>
                  <span>{getWordCount(activeSnippet.content)} words</span>
                  <span>{formatSavedTime(activeSnippet.updatedAt)}</span>
                </footer>
              </>
            ) : (
              <div className="folder-browser">
                <div className="folder-browser-header">
                  <div>
                    <h3>{activeFolder ? activeFolder.name : 'Root'}</h3>
                    <p>{currentFolderItems.length} item{currentFolderItems.length === 1 ? '' : 's'} in this folder</p>
                  </div>
                  <div className="folder-browser-actions">
                    {folderViewMode === 'list' && (
                      <div className="create-actions">
                        <button className="create-text-action" type="button" onClick={addFolder} title="New folder" aria-label="New folder">
                          <FolderPlus size={17} />
                          <span>New folder</span>
                        </button>
                        <button className="create-text-action" type="button" onClick={() => addSnippet()} title="New text" aria-label="New text">
                          <FilePlus size={17} />
                          <span>New text</span>
                        </button>
                      </div>
                    )}
                    <div className="view-toggle" aria-label="Folder view mode">
                      <button className={folderViewMode === 'grid' ? 'selected' : ''} type="button" onClick={() => setFolderViewMode('grid')} title="Grid view" aria-label="Grid view"><Grid2X2 size={17} /></button>
                      <button className={folderViewMode === 'list' ? 'selected' : ''} type="button" onClick={() => setFolderViewMode('list')} title="List view" aria-label="List view"><List size={17} /></button>
                    </div>
                  </div>
                </div>

                {currentFolderItems.length > 0 ? (
                  <div className={`folder-items ${folderViewMode}`}>
                    {folderViewMode === 'grid' && (
                      <article className="folder-add-card" aria-label="Create new item">
                        <strong>Add new</strong>
                        <small>Create a folder or text</small>
                        <div className="folder-add-options">
                          <button type="button" onClick={addFolder}>
                            <FolderPlus size={18} />
                            <span>Folder</span>
                          </button>
                          <button type="button" onClick={() => addSnippet()}>
                            <FilePlus size={18} />
                            <span>Text</span>
                          </button>
                        </div>
                      </article>
                    )}
                    {currentFolderItems.map((item) => (
                      <article
                        className="folder-item-card"
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => (item.type === 'folder' ? selectFolder(item.id) : selectSnippet(item.id, selectedFolderId))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            item.type === 'folder' ? selectFolder(item.id) : selectSnippet(item.id, selectedFolderId);
                          }
                        }}
                      >
                        <div className="folder-item-main">
                          <span className="folder-item-icon" style={{ '--folder-color': item.type === 'folder' ? item.color : undefined } as React.CSSProperties}>
                            {item.type === 'folder' ? <FolderIcon size={20} /> : <FileText size={20} />}
                          </span>
                          <span>
                            <strong>{item.name}</strong>
                            <small>
                              {item.type === 'folder'
                                ? `${item.children.length} item${item.children.length === 1 ? '' : 's'}`
                              : `${item.content.length} chars${item.tags.length ? ` - ${item.tags.map((tag) => `#${tag}`).join(' ')}` : ''}`}
                            </small>
                          </span>
                        </div>
                        <div className="folder-item-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                          {item.type === 'snippet' && (
                            <>
                              <button className={`icon-action ${item.favorite ? 'active-action' : ''}`} type="button" onClick={() => toggleFavorite(item)} title={item.favorite ? 'Remove favorite' : 'Add favorite'} aria-label={item.favorite ? 'Remove favorite' : 'Add favorite'}><Heart size={17} /></button>
                              <button className="icon-action" type="button" onClick={() => copySnippet(item)} title="Copy text" aria-label="Copy text"><Copy size={17} /></button>
                            </>
                          )}
                          <button className="icon-action" type="button" onClick={() => duplicateItem(item)} title="Duplicate" aria-label="Duplicate"><Archive size={17} /></button>
                          <button className="icon-action" type="button" onClick={() => renameItem(item)} title="Rename" aria-label="Rename"><Pencil size={17} /></button>
                          <button className="icon-action danger" type="button" onClick={() => deleteItem(item)} title="Delete" aria-label="Delete"><Trash2 size={17} /></button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <section className="folder-empty-state">
                    <h3>No items here yet</h3>
                    <p>Create a blank text or add a folder.</p>
                    <button className="create-text-action" type="button" onClick={() => addSnippet()}><FilePlus size={17} />New text</button>
                  </section>
                )}
              </div>
            )}
          </section>
        </div>
      </section>

      {commandOpen && (
        <div className="modal-backdrop" onClick={() => setCommandOpen(false)}>
          <section className="command-palette" onClick={(event) => event.stopPropagation()}>
            <div className="command-header">
              <div>
                <p className="eyebrow">Quick actions</p>
                <h2>Command palette</h2>
              </div>
              <button className="command-close" type="button" onClick={() => setCommandOpen(false)} aria-label="Close command palette">x</button>
            </div>
            <div className="command-grid">
              <button type="button" onClick={() => { addSnippet(); setCommandOpen(false); }}><FilePlus size={18} /><span>New text</span><kbd>⌘N</kbd></button>
              <button type="button" onClick={() => { addFolder(); setCommandOpen(false); }}><FolderPlus size={18} /><span>New folder</span><kbd>⇧⌘F</kbd></button>
              <button type="button" onClick={() => exportData()}><Download size={18} /><span>Export backup</span></button>
              <button type="button" onClick={() => importInputRef.current?.click()}><Import size={18} /><span>Import backup</span></button>
              <button type="button" onClick={() => setExpandedFolderIds(new Set(collectFolderIds(tree)))}><ChevronDown size={18} /><span>Expand folders</span></button>
              <button type="button" onClick={() => setExpandedFolderIds(new Set())}><ChevronRight size={18} /><span>Collapse folders</span></button>
              <button type="button" onClick={() => setShowSafety(true)}><Shield size={18} /><span>Safety tools</span></button>
            </div>
            <p className="command-hint">Use Cmd/Ctrl+K to open this palette anytime.</p>
          </section>
        </div>
      )}

      {saveStatus !== 'idle' && (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-icon"><CheckCircle2 size={18} /></span>
          <span>{getStatusMessage(saveStatus)}</span>
          <button type="button" onClick={() => setSaveStatus('idle')} aria-label="Close notification">
            <X size={18} />
          </button>
        </div>
      )}
    </main>
  );
}

export default App;
