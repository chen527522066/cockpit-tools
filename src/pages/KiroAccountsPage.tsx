import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from 'react';
import {
  Plus,
  RefreshCw,
  Download,
  Upload,
  Trash2,
  X,
  Globe,
  KeyRound,
  Database,
  Copy,
  Check,
  RotateCw,
  CircleAlert,
  LayoutGrid,
  List,
  Search,
  ArrowDownWideNarrow,
  Tag,
  ChevronDown,
  Play,
  Eye,
  EyeOff,
  Lock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useKiroAccountStore } from '../stores/useKiroAccountStore';
import * as kiroService from '../services/kiroService';
import { TagEditModal } from '../components/TagEditModal';
import {
  getKiroCreditsSummary,
} from '../types/kiro';
import { buildKiroAccountPresentation } from '../presentation/platformAccountPresentation';

import { save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { KiroOverviewTabsHeader, KiroTab } from '../components/KiroOverviewTabsHeader';
import { KiroInstancesContent } from './KiroInstancesPage';
import { QuickSettingsPopover } from '../components/QuickSettingsPopover';
import {
  isPrivacyModeEnabledByDefault,
  maskSensitiveValue,
  persistPrivacyModeEnabled,
} from '../utils/privacy';

const WINDSURF_FLOW_NOTICE_COLLAPSED_KEY = 'agtools.kiro.flow_notice_collapsed';
const WINDSURF_CURRENT_ACCOUNT_ID_KEY = 'agtools.kiro.current_account_id';
const KIRO_KNOWN_PLAN_FILTERS = ['FREE', 'INDIVIDUAL', 'PRO', 'BUSINESS', 'ENTERPRISE'] as const;
const KIRO_TOKEN_SINGLE_EXAMPLE = `{"access_token":"eyJ...","refresh_token":"rt_..."}`;
const KIRO_TOKEN_BATCH_EXAMPLE = `[
  {"access_token":"eyJ...","refresh_token":"rt_a..."},
  {"access_token":"eyJ...","refresh_token":"rt_b..."}
]`;

export function KiroAccountsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'zh-CN';
  const untaggedKey = '__untagged__';
  const [activeTab, setActiveTab] = useState<KiroTab>('overview');

  const {
    accounts,
    loading,
    fetchAccounts,
    deleteAccounts,
    refreshToken,
    refreshAllTokens,
    updateAccountTags,
  } = useKiroAccountStore();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAddModal, setShowAddModal] = useState(false);
  const [addTab, setAddTab] = useState<'oauth' | 'token' | 'import'>('oauth');
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [injecting, setInjecting] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [privacyModeEnabled, setPrivacyModeEnabled] = useState<boolean>(() =>
    isPrivacyModeEnabledByDefault()
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [groupByTag, setGroupByTag] = useState(false);
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [showTagModal, setShowTagModal] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'credits' | 'plan_end' | 'created_at'>('created_at');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [exporting, setExporting] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addStatus, setAddStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthUrlCopied, setOauthUrlCopied] = useState(false);
  const [oauthUserCode, setOauthUserCode] = useState<string | null>(null);
  const [oauthUserCodeCopied, setOauthUserCodeCopied] = useState(false);
  const [oauthMeta, setOauthMeta] = useState<{ expiresIn: number; intervalSeconds: number } | null>(null);
  const [oauthPrepareError, setOauthPrepareError] = useState<string | null>(null);
  const [oauthCompleteError, setOauthCompleteError] = useState<string | null>(null);
  const [oauthPolling, setOauthPolling] = useState(false);
  const [oauthTimedOut, setOauthTimedOut] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone?: 'error' } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; message: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tagDeleteConfirm, setTagDeleteConfirm] = useState<{ tag: string; count: number } | null>(null);
  const [deletingTag, setDeletingTag] = useState(false);
  const [isFlowNoticeCollapsed, setIsFlowNoticeCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WINDSURF_FLOW_NOTICE_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [currentAccountId, setCurrentAccountId] = useState<string | null>(() => {
    try {
      const value = localStorage.getItem(WINDSURF_CURRENT_ACCOUNT_ID_KEY);
      return value && value.trim() ? value : null;
    } catch {
      return null;
    }
  });

  const showAddModalRef = useRef(showAddModal);
  const addTabRef = useRef(addTab);
  const addStatusRef = useRef(addStatus);
  const oauthActiveRef = useRef(false);
  const oauthLoginIdRef = useRef<string | null>(null);
  const oauthCompletingRef = useRef(false);
  const tagFilterRef = useRef<HTMLDivElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const oauthLog = useCallback((...args: unknown[]) => {
    console.info('[KiroOAuth]', ...args);
  }, []);
  const togglePrivacyMode = useCallback(() => {
    setPrivacyModeEnabled((prev) => {
      const next = !prev;
      persistPrivacyModeEnabled(next);
      return next;
    });
  }, []);
  const maskAccountText = useCallback(
    (value?: string | null) => maskSensitiveValue(value, privacyModeEnabled),
    [privacyModeEnabled]
  );

  useEffect(() => {
    showAddModalRef.current = showAddModal;
    addTabRef.current = addTab;
    addStatusRef.current = addStatus;
  }, [showAddModal, addTab, addStatus]);

  useEffect(() => {
    if (!showTagFilter) return;
    const handleClick = (event: MouseEvent) => {
      if (!tagFilterRef.current) return;
      if (!tagFilterRef.current.contains(event.target as Node)) {
        setShowTagFilter(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTagFilter]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    try {
      localStorage.setItem(WINDSURF_FLOW_NOTICE_COLLAPSED_KEY, isFlowNoticeCollapsed ? '1' : '0');
    } catch {
      // ignore persistence failures
    }
  }, [isFlowNoticeCollapsed]);

  useEffect(() => {
    if (!currentAccountId) return;
    const exists = accounts.some((account) => account.id === currentAccountId);
    if (!exists) {
      setCurrentAccountId(null);
    }
  }, [accounts, currentAccountId]);

  useEffect(() => {
    try {
      if (currentAccountId) {
        localStorage.setItem(WINDSURF_CURRENT_ACCOUNT_ID_KEY, currentAccountId);
      } else {
        localStorage.removeItem(WINDSURF_CURRENT_ACCOUNT_ID_KEY);
      }
    } catch {
      // ignore persistence failures
    }
  }, [currentAccountId]);

  const handleOauthPrepareError = useCallback((e: unknown) => {
    const msg = String(e).replace(/^Error:\s*/, '');
    console.error('[KiroOAuth] 准备授权信息失败', { error: msg });
    oauthActiveRef.current = false;
    oauthCompletingRef.current = false;
    setOauthPolling(false);
    setOauthPrepareError(t('common.shared.oauth.failed', '授权失败') + ': ' + msg);
  }, [t]);

  const completeOauthSuccess = useCallback(async () => {
    oauthLog('授权完成并保存成功', {
      loginId: oauthLoginIdRef.current,
    });
    await fetchAccounts();
    setAddStatus('success');
    setAddMessage(t('common.shared.oauth.success', '授权成功'));
    setTimeout(() => {
      setShowAddModal(false);
      resetAddModalState();
    }, 1200);
  }, [fetchAccounts, t, oauthLog]);

  const handleOauthCompleteError = useCallback((e: unknown) => {
    const msg = String(e).replace(/^Error:\s*/, '');
    setOauthCompleteError(msg);
    setOauthTimedOut(/超时|过期|expired|timeout/i.test(msg));
    setOauthPolling(false);
    oauthCompletingRef.current = false;
    oauthActiveRef.current = false;
    oauthLog('Kiro OAuth 授权失败', { loginId: oauthLoginIdRef.current, error: msg });
  }, [oauthLog]);

  const prepareOauthUrl = useCallback(() => {
    if (!showAddModalRef.current || addTabRef.current !== 'oauth') return;
    if (oauthActiveRef.current) return;
    if (oauthCompletingRef.current) return;
    oauthActiveRef.current = true;
    setOauthPrepareError(null);
    setOauthCompleteError(null);
    setOauthTimedOut(false);
    setOauthPolling(false);
    setOauthUrlCopied(false);
    setOauthUserCodeCopied(false);
    setOauthMeta(null);
    setOauthUserCode(null);
    oauthLog('开始准备 Kiro OAuth 授权信息');

    let started = false;

    kiroService
      .startKiroOAuthLogin()
      .then((resp) => {
        started = true;
        oauthLoginIdRef.current = resp.loginId ?? null;

        const url = resp.verificationUriComplete || resp.verificationUri;
        setOauthUrl(url);
        setOauthUserCode(resp.userCode);
        setOauthMeta({ expiresIn: resp.expiresIn, intervalSeconds: resp.intervalSeconds });

        oauthLog('授权信息已就绪并展示在弹框', {
          loginId: resp.loginId,
          url,
          expiresIn: resp.expiresIn,
          intervalSeconds: resp.intervalSeconds,
        });

        // 后台开始轮询 Kiro 授权结果
        setOauthPolling(true);
        oauthCompletingRef.current = true;
        oauthActiveRef.current = false;
        return kiroService.completeKiroOAuthLogin(resp.loginId);
      })
      .then(async () => {
        setOauthPolling(false);
        oauthCompletingRef.current = false;
        await completeOauthSuccess();
      })
      .catch((e) => {
        if (!started) {
          handleOauthPrepareError(e);
          return;
        }
        handleOauthCompleteError(e);
      })
      .finally(() => {
        oauthActiveRef.current = false;
      });
  }, [completeOauthSuccess, handleOauthCompleteError, handleOauthPrepareError, oauthLog]);

  useEffect(() => {
    if (!showAddModal || addTab !== 'oauth' || oauthUrl) return;
    prepareOauthUrl();
  }, [showAddModal, addTab, oauthUrl, prepareOauthUrl]);

  useEffect(() => {
    if (showAddModal && addTab === 'oauth') return;
    const loginId = oauthLoginIdRef.current ?? undefined;
    if (!loginId) return;
    oauthLog('弹框关闭或切换标签，准备取消授权流程', { loginId });
    kiroService.cancelKiroOAuthLogin(loginId).catch(() => {});
    oauthActiveRef.current = false;
    oauthLoginIdRef.current = null;
    oauthCompletingRef.current = false;
    setOauthUrl(null);
    setOauthUrlCopied(false);
    setOauthUserCode(null);
    setOauthUserCodeCopied(false);
    setOauthMeta(null);
    setOauthPrepareError(null);
    setOauthCompleteError(null);
    setOauthTimedOut(false);
    setOauthPolling(false);
  }, [showAddModal, addTab, oauthLog]);

  const handleRefresh = async (accountId: string) => {
    setRefreshing(accountId);
    try {
      await refreshToken(accountId);
    } catch (e) {
      console.error(e);
    }
    setRefreshing(null);
  };

  const handleRefreshAll = async () => {
    setRefreshingAll(true);
    try {
      await refreshAllTokens();
    } catch (e) {
      console.error(e);
    }
    setRefreshingAll(false);
  };

  const handleDelete = (accountId: string) => {
    setDeleteConfirm({
      ids: [accountId],
      message: t('messages.deleteConfirm', '确定要删除此账号吗？'),
    });
  };

  const handleInjectToVSCode = async (accountId: string) => {
    setMessage(null);
    const account = accounts.find((item) => item.id === accountId);
    const accountPresentation = account
      ? buildKiroAccountPresentation(account, t)
      : null;
    if (accountPresentation?.isBanned) {
      setMessage({ text: t('accounts.status.forbidden_msg'), tone: 'error' });
      return;
    }
    setInjecting(accountId);
    const displayEmail = accountPresentation?.displayName || accountId;
    try {
      await kiroService.injectKiroToVSCode(accountId);
      setCurrentAccountId(accountId);
      setMessage({ text: t('messages.switched', { email: maskAccountText(displayEmail) }) });
    } catch (e: any) {
      setMessage({
        text: t('messages.switchFailed', { error: e?.toString() || t('common.failed', 'Failed') }),
        tone: 'error',
      });
    }
    setInjecting(null);
  };

  const handleBatchDelete = () => {
    if (selected.size === 0) return;
    setDeleteConfirm({
      ids: Array.from(selected),
      message: t('messages.batchDeleteConfirm', { count: selected.size }),
    });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm || deleting) return;
    setDeleting(true);
    try {
      await deleteAccounts(deleteConfirm.ids);
      setSelected((prev) => {
        const next = new Set(prev);
        deleteConfirm.ids.forEach((id) => next.delete(id));
        return next;
      });
      setDeleteConfirm(null);
    } finally {
      setDeleting(false);
    }
  };

  const resetAddModalState = () => {
    setAddStatus('idle');
    setAddMessage('');
    setTokenInput('');
    setOauthUrl(null);
    setOauthUrlCopied(false);
    setOauthUserCode(null);
    setOauthUserCodeCopied(false);
    setOauthMeta(null);
    setOauthPrepareError(null);
    setOauthCompleteError(null);
    setOauthTimedOut(false);
    setOauthPolling(false);
    oauthActiveRef.current = false;
  };

  const openAddModal = (tab: 'oauth' | 'token' | 'import') => {
    setAddTab(tab);
    setShowAddModal(true);
    resetAddModalState();
  };

  const closeAddModal = () => {
    setShowAddModal(false);
    resetAddModalState();
  };

  const handlePickImportFile = () => {
    importFileInputRef.current?.click();
  };

  const importFromJsonContent = async (content: string): Promise<number> => {
    const imported = await kiroService.importKiroFromJson(content);
    return imported.length;
  };

  const handleImportJsonFile = async (file: File) => {
    setImporting(true);
    setAddStatus('loading');
    setAddMessage(t('common.shared.import.importing', '正在导入...'));

    try {
      const content = await file.text();
      const importedCount = await importFromJsonContent(content);
      await fetchAccounts();

      setAddStatus('success');
      setAddMessage(
        t('common.shared.token.importSuccessMsg', {
          count: importedCount,
          defaultValue: '成功导入 {{count}} 个账号',
        })
      );
      setTimeout(() => {
        setShowAddModal(false);
        resetAddModalState();
      }, 1200);
    } catch (e) {
      setAddStatus('error');
      const errorMsg = String(e).replace(/^Error:\s*/, '');
      setAddMessage(
        t('common.shared.import.failedMsg', {
          error: errorMsg,
          defaultValue: '导入失败: {{error}}',
        })
      );
    }

    setImporting(false);
  };

  const handleImportFromLocalClient = async () => {
    setImporting(true);
    setAddStatus('loading');
    setAddMessage(t('common.shared.import.importing', '正在导入...'));
    try {
      const imported = await kiroService.importKiroFromLocal();
      await fetchAccounts();
      setAddStatus('success');
      setAddMessage(
        t('common.shared.token.importSuccessMsg', {
          count: imported.length,
          defaultValue: '成功导入 {{count}} 个账号',
        })
      );
      setTimeout(() => {
        setShowAddModal(false);
        resetAddModalState();
      }, 1200);
    } catch (e) {
      setAddStatus('error');
      const errorMsg = String(e).replace(/^Error:\s*/, '');
      setAddMessage(
        t('common.shared.import.failedMsg', {
          error: errorMsg,
          defaultValue: '导入失败: {{error}}',
        })
      );
    }
    setImporting(false);
  };

  const handleTokenImport = async () => {
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setAddStatus('error');
      setAddMessage(t('common.shared.token.empty', '请输入 Token 或 JSON'));
      return;
    }

    setImporting(true);
    setAddStatus('loading');
    setAddMessage(t('common.shared.token.importing', '正在导入...'));

    try {
      let importedCount = 0;
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const accounts = await kiroService.importKiroFromJson(trimmed);
        importedCount = accounts.length;
      } else {
        await kiroService.addKiroAccountWithToken(trimmed);
        importedCount = 1;
      }
      await fetchAccounts();
      setAddStatus('success');
      setAddMessage(
        t('common.shared.token.importSuccessMsg', {
          count: importedCount,
          defaultValue: '成功导入 {{count}} 个账号',
        })
      );
      setTimeout(() => {
        setShowAddModal(false);
        resetAddModalState();
      }, 1200);
    } catch (e) {
      setAddStatus('error');
      const errorMsg = String(e).replace(/^Error:\s*/, '');
      setAddMessage(
        t('common.shared.token.importFailedMsg', {
          error: errorMsg,
          defaultValue: '导入失败: {{error}}',
        })
      );
    }
    setImporting(false);
  };

  const handleCopyOauthUrl = async () => {
    if (!oauthUrl) return;
    try {
      await navigator.clipboard.writeText(oauthUrl);
      oauthLog('已复制授权链接', {
        loginId: oauthLoginIdRef.current,
        authUrl: oauthUrl,
      });
      setOauthUrlCopied(true);
      window.setTimeout(() => setOauthUrlCopied(false), 1200);
    } catch (e) {
      console.error('复制失败:', e);
    }
  };

  const handleCopyOauthUserCode = async () => {
    if (!oauthUserCode) return;
    try {
      await navigator.clipboard.writeText(oauthUserCode);
      oauthLog('已复制 user_code', { loginId: oauthLoginIdRef.current });
      setOauthUserCodeCopied(true);
      window.setTimeout(() => setOauthUserCodeCopied(false), 1200);
    } catch (e) {
      console.error('复制失败:', e);
    }
  };

  const handleRetryOauth = () => {
    oauthLog('用户点击刷新授权信息', {
      loginId: oauthLoginIdRef.current,
      error: oauthCompleteError,
      timedOut: oauthTimedOut,
    });
    oauthActiveRef.current = false;
    oauthLoginIdRef.current = null;
    oauthCompletingRef.current = false;
    setOauthPrepareError(null);
    setOauthCompleteError(null);
    setOauthTimedOut(false);
    setOauthPolling(false);
    setOauthMeta(null);
    setOauthUrl(null);
    setOauthUrlCopied(false);
    setOauthUserCode(null);
    setOauthUserCodeCopied(false);
    prepareOauthUrl();
  };

  const handleOpenOauthUrl = async () => {
    if (!oauthUrl) return;
    oauthLog('用户点击在浏览器打开授权链接', {
      loginId: oauthLoginIdRef.current,
      authUrl: oauthUrl,
    });
    try {
      await openUrl(oauthUrl);
    } catch (e) {
      console.error('打开浏览器失败:', e);
      await navigator.clipboard.writeText(oauthUrl).catch(() => {});
      setOauthUrlCopied(true);
      setTimeout(() => setOauthUrlCopied(false), 1200);
    }
  };

  const resolveDefaultExportPath = async (fileName: string) => {
    const userAgent = navigator.userAgent.toLowerCase();
    if (!userAgent.includes('mac')) return fileName;
    try {
      const dir = await invoke<string>('get_downloads_dir');
      if (!dir) return fileName;
      const normalized = dir.endsWith('/') ? dir.slice(0, -1) : dir;
      return `${normalized}/${fileName}`;
    } catch (e) {
      console.error('获取下载目录失败:', e);
      return fileName;
    }
  };

  const saveJsonFile = async (json: string, defaultFileName: string) => {
    const defaultPath = await resolveDefaultExportPath(defaultFileName);
    const filePath = await save({
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!filePath) return null;
    await invoke('save_text_file', { path: filePath, content: json });
    return filePath;
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const ids = selected.size > 0 ? Array.from(selected) : accounts.map((a) => a.id);
      const json = await kiroService.exportKiroAccounts(ids);
      const defaultName = `kiro_accounts_${new Date().toISOString().slice(0, 10)}.json`;
      const savedPath = await saveJsonFile(json, defaultName);
      if (savedPath) {
        setMessage({ text: `${t('common.success')}: ${savedPath}` });
      }
    } catch (e) {
      setMessage({ text: t('messages.exportFailed', { error: String(e) }), tone: 'error' });
    }
    setExporting(false);
  };

  const formatDate = (timestamp: number) => {
    const d = new Date(timestamp * 1000);
    return (
      d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }) +
      ' ' +
      d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    );
  };

  const formatCycleDate = useCallback(
    (timestamp: number | null | undefined) => {
      if (!timestamp) return '';
      const d = new Date(timestamp * 1000);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
    },
    [locale],
  );

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleSelectAll = () => {
    const allIds = filteredAccounts.map((account) => account.id);
    const allSelected = selected.size === allIds.length && allIds.length > 0;
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const normalizeTag = (tag: string) => tag.trim().toLowerCase();

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    accounts.forEach((account) => {
      (account.tags || []).forEach((tag) => {
        const normalized = normalizeTag(tag);
        if (normalized) set.add(normalized);
      });
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [accounts]);

  const creditsSummaryById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getKiroCreditsSummary>>();
    accounts.forEach((account) => {
      map.set(account.id, getKiroCreditsSummary(account));
    });
    return map;
  }, [accounts]);

  const resolveCreditsSummary = useCallback(
    (account: (typeof accounts)[number]) =>
      creditsSummaryById.get(account.id) ?? getKiroCreditsSummary(account),
    [creditsSummaryById],
  );

  const accountPresentations = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildKiroAccountPresentation>>();
    accounts.forEach((account) => {
      map.set(account.id, buildKiroAccountPresentation(account, t));
    });
    return map;
  }, [accounts, t]);

  const resolvePresentation = useCallback(
    (account: (typeof accounts)[number]) =>
      accountPresentations.get(account.id) ?? buildKiroAccountPresentation(account, t),
    [accountPresentations, t],
  );

  const resolvePlanKey = useCallback(
    (account: (typeof accounts)[number]) => {
      const presentation = resolvePresentation(account);
      if (presentation.planClass && presentation.planClass !== 'unknown') {
        return presentation.planClass.toUpperCase();
      }
      const label = presentation.planLabel?.trim();
      return label ? label.toUpperCase() : 'UNKNOWN';
    },
    [resolvePresentation],
  );

  const resolvePlanLabel = useCallback(
    (account: (typeof accounts)[number], planKey: string) => {
      const label = resolvePresentation(account).planLabel?.trim();
      return label || planKey;
    },
    [resolvePresentation],
  );

  const resolvePlanBadgeClass = useCallback(
    (account: (typeof accounts)[number]) => resolvePresentation(account).planClass,
    [resolvePresentation],
  );

  const formatCreditsNumber = useCallback(
    (value: number | null | undefined) => {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      const hasDecimal = Math.abs(n - Math.trunc(n)) > 0.0001;
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: hasDecimal ? 2 : 0,
        maximumFractionDigits: 2,
      }).format(n);
    },
    [locale],
  );

  const resolvePromptMetrics = useCallback(
    (account: (typeof accounts)[number]) =>
      resolvePresentation(account).quotaItems.find((item) => item.key === 'prompt') ?? null,
    [resolvePresentation],
  );

  const resolveAddOnMetrics = useCallback(
    (account: (typeof accounts)[number]) =>
      resolvePresentation(account).quotaItems.find((item) => item.key === 'addon') ?? null,
    [resolvePresentation],
  );

  const resolveDisplayEmail = useCallback((account: (typeof accounts)[number]) => {
    return resolvePresentation(account).displayName.trim();
  }, [resolvePresentation]);

  const resolveDisplayUserId = useCallback((account: (typeof accounts)[number]) => {
    return resolvePresentation(account).userIdText.trim();
  }, [resolvePresentation]);

  const resolveSignedInWithText = useCallback(
    (account: (typeof accounts)[number]) => resolvePresentation(account).signedInWithText,
    [resolvePresentation],
  );

  const resolveCycleDisplay = useCallback(
    (credits: ReturnType<typeof getKiroCreditsSummary>) => {
      const end = credits.planEndsAt ?? null;
      const start = credits.planStartsAt ?? null;

      if (!end) {
        const summary = t('common.shared.credits.planEndsUnknown', '配额周期时间未知');
        return {
          summary,
          detail: '',
          title: summary,
        };
      }

      const now = Math.floor(Date.now() / 1000);
      const secondsLeft = end - now;
      const days = secondsLeft <= 0 ? 0 : Math.floor(secondsLeft / 86400);
      const summary = t('common.shared.credits.planEndsIn', {
        days,
        defaultValue: '配额周期剩余 {{days}} 天',
      });

      const startText = formatCycleDate(start);
      const endText = formatCycleDate(end);
      let detail = '';
      if (startText && endText) {
        detail = t('common.shared.credits.periodRange', {
          start: startText,
          end: endText,
          defaultValue: '周期：{{start}} - {{end}}',
        });
      } else if (endText) {
        detail = t('common.shared.credits.periodEndOnly', {
          end: endText,
          defaultValue: '周期结束：{{end}}',
        });
      }

      const title = detail ? `${summary} · ${detail}` : summary;
      return {
        summary,
        detail,
        title,
      };
    },
    [formatCycleDate, t],
  );

  const formatUsedLine = useCallback(
    (used: number | null | undefined, total: number | null | undefined) =>
      t('common.shared.credits.usedLine', {
        used: formatCreditsNumber(used),
        total: formatCreditsNumber(total),
        defaultValue: '{{used}} / {{total}} used',
      }),
    [formatCreditsNumber, t],
  );

  const formatLeftLine = useCallback(
    (left: number | null | undefined) =>
      t('common.shared.credits.leftInline', {
        left: formatCreditsNumber(left),
        defaultValue: '{{left}} left',
      }),
    [formatCreditsNumber, t],
  );

  const resolveBonusExpiryValue = useCallback(
    (account: (typeof accounts)[number]) => resolvePresentation(account).addOnExpiryText,
    [resolvePresentation],
  );

  const shouldShowAddOnCredits = useCallback(
    (account: (typeof accounts)[number]) => resolveAddOnMetrics(account) != null,
    [resolveAddOnMetrics],
  );

  const tierSummary = useMemo(() => {
    const knownCounts = {
      FREE: 0,
      INDIVIDUAL: 0,
      PRO: 0,
      BUSINESS: 0,
      ENTERPRISE: 0,
    };
    const dynamicCounts = new Map<string, number>();
    const displayLabels = new Map<string, string>();

    accounts.forEach((account) => {
      const tier = resolvePlanKey(account);
      dynamicCounts.set(tier, (dynamicCounts.get(tier) ?? 0) + 1);
      if (tier in knownCounts) {
        knownCounts[tier as keyof typeof knownCounts] += 1;
      }
      if (!displayLabels.has(tier)) {
        displayLabels.set(tier, resolvePlanLabel(account, tier));
      }
    });

    const extraKeys = Array.from(dynamicCounts.keys())
      .filter((tier) => !(KIRO_KNOWN_PLAN_FILTERS as readonly string[]).includes(tier))
      .sort((a, b) => a.localeCompare(b));

    return {
      all: accounts.length,
      knownCounts,
      dynamicCounts,
      extraKeys,
      displayLabels,
    };
  }, [accounts, resolvePlanKey, resolvePlanLabel]);

  useEffect(() => {
    if (filterType === 'all') return;
    if (tierSummary.dynamicCounts.has(filterType)) return;
    setFilterType('all');
  }, [filterType, tierSummary.dynamicCounts]);

  const resolveFilterLabel = useCallback(
    (planKey: string, count: number) => {
      const label = tierSummary.displayLabels.get(planKey) ?? planKey;
      return `${label} (${count})`;
    },
    [tierSummary.displayLabels],
  );

  const filteredAccounts = useMemo(() => {
    let result = [...accounts];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((account) => {
        const presentation = resolvePresentation(account);
        const haystacks = [
          presentation.displayName,
          presentation.userIdText,
          presentation.signedInWithText,
          account.id,
        ];
        return haystacks.some((item) => item.toLowerCase().includes(query));
      });
    }

    if (filterType !== 'all') {
      result = result.filter((account) => resolvePlanKey(account) === filterType);
    }

    if (tagFilter.length > 0) {
      const selectedTags = new Set(tagFilter.map(normalizeTag));
      result = result.filter((acc) => {
        const tags = (acc.tags || []).map(normalizeTag);
        return tags.some((tag) => selectedTags.has(tag));
      });
    }

    result.sort((a, b) => {
      if (sortBy === 'created_at') {
        const diff = b.created_at - a.created_at;
        return sortDirection === 'desc' ? diff : -diff;
      }

      if (sortBy === 'plan_end') {
        const aReset = resolveCreditsSummary(a).planEndsAt ?? null;
        const bReset = resolveCreditsSummary(b).planEndsAt ?? null;
        if (aReset == null && bReset == null) return 0;
        if (aReset == null) return 1;
        if (bReset == null) return -1;
        const diff = bReset - aReset;
        return sortDirection === 'desc' ? diff : -diff;
      }

      const aValue = resolveCreditsSummary(a).creditsLeft ?? -1;
      const bValue = resolveCreditsSummary(b).creditsLeft ?? -1;
      const diff = bValue - aValue;
      return sortDirection === 'desc' ? diff : -diff;
    });

    return result;
  }, [accounts, filterType, resolveCreditsSummary, resolvePlanKey, resolvePresentation, searchQuery, sortBy, sortDirection, tagFilter]);

  const groupedAccounts = useMemo(() => {
    if (!groupByTag) return [] as Array<[string, typeof filteredAccounts]>;
    const groups = new Map<string, typeof filteredAccounts>();
    const selectedTags = new Set(tagFilter.map(normalizeTag));

    filteredAccounts.forEach((account) => {
      const tags = (account.tags || []).map(normalizeTag).filter(Boolean);
      const matchedTags = selectedTags.size > 0
        ? tags.filter((tag) => selectedTags.has(tag))
        : tags;

      if (matchedTags.length === 0) {
        if (!groups.has(untaggedKey)) groups.set(untaggedKey, []);
        groups.get(untaggedKey)?.push(account);
        return;
      }

      matchedTags.forEach((tag) => {
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag)?.push(account);
      });
    });

    return Array.from(groups.entries()).sort(([aKey], [bKey]) => {
      if (aKey === untaggedKey) return 1;
      if (bKey === untaggedKey) return -1;
      return aKey.localeCompare(bKey);
    });
  }, [filteredAccounts, groupByTag, tagFilter, untaggedKey]);

  const toggleTagFilterValue = (tag: string) => {
    setTagFilter((prev) => {
      if (prev.includes(tag)) return prev.filter((item) => item !== tag);
      return [...prev, tag];
    });
  };

  const clearTagFilter = () => {
    setTagFilter([]);
  };

  const requestDeleteTag = (tag: string) => {
    const normalized = normalizeTag(tag);
    if (!normalized) return;
    const count = accounts.filter((account) =>
      (account.tags || []).some((item) => normalizeTag(item) === normalized)
    ).length;
    setTagDeleteConfirm({ tag: normalized, count });
  };

  const confirmDeleteTag = async () => {
    if (!tagDeleteConfirm || deletingTag) return;
    setDeletingTag(true);
    const target = tagDeleteConfirm.tag;
    const affected = accounts.filter((account) =>
      (account.tags || []).some((item) => normalizeTag(item) === target)
    );

    try {
      await Promise.allSettled(
        affected.map((account) => {
          const nextTags = (account.tags || []).filter(
            (item) => normalizeTag(item) !== target
          );
          return kiroService.updateKiroAccountTags(account.id, nextTags);
        })
      );
      setTagFilter((prev) => prev.filter((item) => normalizeTag(item) !== target));
      await fetchAccounts();
    } finally {
      setDeletingTag(false);
      setTagDeleteConfirm(null);
      setShowTagFilter(false);
    }
  };

  const openTagModal = (accountId: string) => {
    setShowTagModal(accountId);
  };

  const handleSaveTags = async (tags: string[]) => {
    if (!showTagModal) return;
    await updateAccountTags(showTagModal, tags);
    setShowTagModal(null);
  };

  const resolveGroupLabel = (groupKey: string) =>
    groupKey === untaggedKey ? t('accounts.defaultGroup', '默认分组') : groupKey;

  const renderGridCards = (items: typeof filteredAccounts, groupKey?: string) =>
    items.map((account) => {
      const presentation = resolvePresentation(account);
      const displayEmail = resolveDisplayEmail(account);
      const displayUserId = resolveDisplayUserId(account);
      const emailText = displayEmail || displayUserId || account.id;
      const signedInWithText = resolveSignedInWithText(account);
      const userIdText = displayUserId || account.id;
      const credits = resolveCreditsSummary(account);
      const cycleDisplay = resolveCycleDisplay(credits);
      const promptMetrics = resolvePromptMetrics(account);
      const addOnMetrics = resolveAddOnMetrics(account);
      const planKey = resolvePlanKey(account);
      const planLabel = resolvePlanLabel(account, planKey);
      const bonusExpiryValue = resolveBonusExpiryValue(account);
      const showAddOnCredits = shouldShowAddOnCredits(account);
      const accountTags = (account.tags || []).map((tag) => tag.trim()).filter(Boolean);
      const visibleTags = accountTags.slice(0, 2);
      const moreTagCount = Math.max(0, accountTags.length - visibleTags.length);
      const isSelected = selected.has(account.id);
      const isCurrent = currentAccountId === account.id;
      const statusReason = presentation.accountStatusReason;
      const isBanned = presentation.isBanned;
      const hasStatusError = presentation.hasStatusError;
      const bannedTitle = statusReason || t('accounts.status.forbidden_tooltip');
      const errorTitle = statusReason || t('accounts.status.refreshFailed');

      return (
        <div
          key={groupKey ? `${groupKey}-${account.id}` : account.id}
          className={`ghcp-account-card ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''} ${isBanned ? 'disabled' : ''}`}
        >
          <div className="card-top">
            <div className="card-select">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleSelect(account.id)}
              />
            </div>
            <span className="account-email" title={maskAccountText(emailText)}>
              {maskAccountText(emailText)}
            </span>
            {isCurrent && (
              <span className="current-tag">
                {t('accounts.status.current')}
              </span>
            )}
            {hasStatusError && (
              <span className="status-pill warning" title={errorTitle}>
                <CircleAlert size={12} />
                {t('accounts.status.refreshFailed')}
              </span>
            )}
            {isBanned && (
              <span className="status-pill forbidden" title={bannedTitle}>
                <Lock size={12} />
                {t('accounts.status.forbidden')}
              </span>
            )}
            <span className={`tier-badge ${resolvePlanBadgeClass(account)}`}>{planLabel}</span>
          </div>

          <div className="account-sub-line">
            <span className="kiro-table-subline" title={`${signedInWithText} | ${t('kiro.account.userId', 'User ID')}: ${maskAccountText(userIdText)}`}>
              {signedInWithText} | {t('kiro.account.userId', 'User ID')}: {maskAccountText(userIdText)}
            </span>
          </div>

          {accountTags.length > 0 && (
            <div className="card-tags">
              {visibleTags.map((tag, idx) => (
                <span key={`${account.id}-${tag}-${idx}`} className="tag-pill">
                  {tag}
                </span>
              ))}
              {moreTagCount > 0 && <span className="tag-pill more">+{moreTagCount}</span>}
            </div>
          )}

          <div className="ghcp-quota-section">
            <div className="quota-item windsurf-credit-item">
              <div className="quota-header">
                <span className="quota-label">{promptMetrics?.label ?? t('common.shared.columns.promptCredits', 'User Prompt credits')}</span>
                <span className={`quota-pct ${promptMetrics?.quotaClass ?? 'high'}`}>
                  {promptMetrics?.valueText ?? '0%'}
                </span>
              </div>
              <div className="windsurf-credit-meta-row">
                <span className="windsurf-credit-used">{formatUsedLine(promptMetrics?.used, promptMetrics?.total)}</span>
                <span className="windsurf-credit-left">{formatLeftLine(promptMetrics?.left)}</span>
              </div>
              <div className="quota-bar-track">
                <div
                  className={`quota-bar ${promptMetrics?.quotaClass ?? 'high'}`}
                  style={{ width: `${promptMetrics?.percentage ?? 0}%` }}
                />
              </div>
            </div>

            {showAddOnCredits && (
              <div className="quota-item windsurf-credit-item">
                <div className="quota-header">
                  <span className="quota-label">{addOnMetrics?.label ?? t('common.shared.columns.addOnPromptCredits', 'Add-on prompt credits')}</span>
                  <span className={`quota-pct ${addOnMetrics?.quotaClass ?? 'high'}`}>
                    {addOnMetrics?.valueText ?? '0%'}
                  </span>
                </div>
                <div className="windsurf-credit-meta-row">
                  <span className="windsurf-credit-used">{formatUsedLine(addOnMetrics?.used, addOnMetrics?.total)}</span>
                  <span className="windsurf-credit-left">{formatLeftLine(addOnMetrics?.left)}</span>
                </div>
                <div className="windsurf-credit-meta-row expiry">
                  <span className="windsurf-credit-expiry">
                    {t('kiro.columns.expiry', 'Expiry')}: {bonusExpiryValue}
                  </span>
                </div>
                <div className="quota-bar-track">
                  <div
                    className={`quota-bar ${addOnMetrics?.quotaClass ?? 'high'}`}
                    style={{ width: `${addOnMetrics?.percentage ?? 0}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="windsurf-plan-cycle" title={cycleDisplay.title}>
            <span className="windsurf-plan-cycle-summary">{cycleDisplay.summary}</span>
            {cycleDisplay.detail ? (
              <span className="windsurf-plan-cycle-detail">{cycleDisplay.detail}</span>
            ) : null}
          </div>

          <div className="card-footer">
            <span className="card-date">{formatDate(account.created_at)}</span>
            <div className="card-actions">
              <button
                className="card-action-btn success"
                onClick={() => handleInjectToVSCode(account.id)}
                disabled={!!injecting || isBanned}
                title={
                  isBanned
                    ? t('accounts.status.forbidden_msg')
                    : t('kiro.injectToVSCode', '切换到 Kiro')
                }
              >
                {injecting === account.id ? (
                  <RefreshCw size={14} className="loading-spinner" />
                ) : (
                  <Play size={14} />
                )}
              </button>
              <button
                className="card-action-btn"
                onClick={() => openTagModal(account.id)}
                title={t('accounts.editTags', '编辑标签')}
              >
                <Tag size={14} />
              </button>
              <button
                className="card-action-btn"
                onClick={() => handleRefresh(account.id)}
                disabled={refreshing === account.id}
                title={t('common.shared.refreshQuota', '刷新配额')}
              >
                <RotateCw
                  size={14}
                  className={refreshing === account.id ? 'loading-spinner' : ''}
                />
              </button>
              <button
                className="card-action-btn danger"
                onClick={() => handleDelete(account.id)}
                title={t('common.delete', '删除')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
      );
    });

  const renderTableRows = (items: typeof filteredAccounts, groupKey?: string) =>
    items.map((account) => {
      const presentation = resolvePresentation(account);
      const displayEmail = resolveDisplayEmail(account);
      const displayUserId = resolveDisplayUserId(account);
      const emailText = displayEmail || displayUserId || account.id;
      const signedInWithText = resolveSignedInWithText(account);
      const userIdText = displayUserId || account.id;
      const credits = resolveCreditsSummary(account);
      const cycleDisplay = resolveCycleDisplay(credits);
      const promptMetrics = resolvePromptMetrics(account);
      const addOnMetrics = resolveAddOnMetrics(account);
      const planKey = resolvePlanKey(account);
      const planLabel = resolvePlanLabel(account, planKey);
      const bonusExpiryValue = resolveBonusExpiryValue(account);
      const showAddOnCredits = shouldShowAddOnCredits(account);
      const accountTags = (account.tags || []).map((tag) => tag.trim()).filter(Boolean);
      const visibleTags = accountTags.slice(0, 3);
      const moreTagCount = Math.max(0, accountTags.length - visibleTags.length);
      const isCurrent = currentAccountId === account.id;
      const statusReason = presentation.accountStatusReason;
      const isBanned = presentation.isBanned;
      const hasStatusError = presentation.hasStatusError;
      const bannedTitle = statusReason || t('accounts.status.forbidden_tooltip');
      const errorTitle = statusReason || t('accounts.status.refreshFailed');
      return (
        <tr
          key={groupKey ? `${groupKey}-${account.id}` : account.id}
          className={`${isCurrent ? 'current' : ''} ${isBanned ? 'disabled' : ''}`}
        >
          <td>
            <input
              type="checkbox"
              checked={selected.has(account.id)}
              onChange={() => toggleSelect(account.id)}
            />
          </td>
          <td>
            <div className="account-cell">
              <div className="account-main-line">
                <span className="account-email-text" title={maskAccountText(emailText)}>
                  {maskAccountText(emailText)}
                </span>
                {isCurrent && <span className="mini-tag current">{t('accounts.status.current')}</span>}
              </div>
              {(hasStatusError || isBanned) && (
                <div className="account-sub-line">
                  {hasStatusError && (
                    <span className="status-pill warning" title={errorTitle}>
                      <CircleAlert size={12} />
                      {t('accounts.status.refreshFailed')}
                    </span>
                  )}
                  {isBanned && (
                    <span className="status-pill forbidden" title={bannedTitle}>
                      <Lock size={12} />
                      {t('accounts.status.forbidden')}
                    </span>
                  )}
                </div>
              )}
              <div className="account-sub-line">
                <span className="kiro-table-subline">
                  {signedInWithText} | {t('kiro.account.userId', 'User ID')}: {maskAccountText(userIdText)}
                </span>
              </div>
              <div className="account-sub-line windsurf-cycle-line" title={cycleDisplay.title}>
                <span className="windsurf-cycle-text">{cycleDisplay.summary}</span>
              </div>
              {accountTags.length > 0 && (
                <div className="account-tags-inline">
                  {visibleTags.map((tag, idx) => (
                    <span key={`${account.id}-inline-${tag}-${idx}`} className="tag-pill">
                      {tag}
                    </span>
                  ))}
                  {moreTagCount > 0 && <span className="tag-pill more">+{moreTagCount}</span>}
                </div>
              )}
            </div>
          </td>
          <td>
            <span className={`tier-badge ${resolvePlanBadgeClass(account)}`}>{planLabel}</span>
          </td>
          <td>
            <div className="quota-item windsurf-table-credit-item">
              <div className="quota-header">
                <span className="quota-name">{promptMetrics?.label ?? t('common.shared.columns.promptCredits', 'User Prompt credits')}</span>
                <span className={`quota-value ${promptMetrics?.quotaClass ?? 'high'}`}>
                  {promptMetrics?.valueText ?? '0%'}
                </span>
              </div>
              <div className="windsurf-credit-meta-row table">
                <span className="windsurf-credit-used">{formatUsedLine(promptMetrics?.used, promptMetrics?.total)}</span>
                <span className="windsurf-credit-left">{formatLeftLine(promptMetrics?.left)}</span>
              </div>
              <div className="quota-progress-track">
                <div
                  className={`quota-progress-bar ${promptMetrics?.quotaClass ?? 'high'}`}
                  style={{ width: `${promptMetrics?.percentage ?? 0}%` }}
                />
              </div>
            </div>
          </td>
          <td>
            {showAddOnCredits ? (
              <div className="quota-item windsurf-table-credit-item">
                <div className="quota-header">
                  <span className="quota-name">{addOnMetrics?.label ?? t('common.shared.columns.addOnPromptCredits', 'Add-on prompt credits')}</span>
                  <span className={`quota-value ${addOnMetrics?.quotaClass ?? 'high'}`}>
                    {addOnMetrics?.valueText ?? '0%'}
                  </span>
                </div>
                <div className="windsurf-credit-meta-row table">
                  <span className="windsurf-credit-used">{formatUsedLine(addOnMetrics?.used, addOnMetrics?.total)}</span>
                  <span className="windsurf-credit-left">{formatLeftLine(addOnMetrics?.left)}</span>
                </div>
                <div className="windsurf-credit-meta-row table expiry">
                  <span className="windsurf-credit-expiry">
                    {t('kiro.columns.expiry', 'Expiry')}: {bonusExpiryValue}
                  </span>
                </div>
                <div className="quota-progress-track">
                  <div
                    className={`quota-progress-bar ${addOnMetrics?.quotaClass ?? 'high'}`}
                    style={{ width: `${addOnMetrics?.percentage ?? 0}%` }}
                  />
                </div>
              </div>
            ) : (
              <div className="quota-empty">{t('kiro.credits.expiryUnknown', '—')}</div>
            )}
          </td>
          <td className="sticky-action-cell table-action-cell">
            <div className="action-buttons">
              <button
                className="action-btn success"
                onClick={() => handleInjectToVSCode(account.id)}
                disabled={!!injecting || isBanned}
                title={
                  isBanned
                    ? t('accounts.status.forbidden_msg')
                    : t('kiro.injectToVSCode', '切换到 Kiro')
                }
              >
                {injecting === account.id ? <RefreshCw size={14} className="loading-spinner" /> : <Play size={14} />}
              </button>
              <button
                className="action-btn"
                onClick={() => openTagModal(account.id)}
                title={t('accounts.editTags', '编辑标签')}
              >
                <Tag size={14} />
              </button>
              <button
                className="action-btn"
                onClick={() => handleRefresh(account.id)}
                disabled={refreshing === account.id}
                title={t('common.shared.refreshQuota', '刷新配额')}
              >
                <RotateCw size={14} className={refreshing === account.id ? 'loading-spinner' : ''} />
              </button>
              <button
                className="action-btn danger"
                onClick={() => handleDelete(account.id)}
                title={t('common.delete', '删除')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </td>
        </tr>
      );
    });

  return (
    <div className="ghcp-accounts-page">
      <KiroOverviewTabsHeader active={activeTab} onTabChange={setActiveTab} />
      <div className={`ghcp-flow-notice ${isFlowNoticeCollapsed ? 'collapsed' : ''}`} role="note" aria-live="polite">
        <button
          type="button"
          className="ghcp-flow-notice-toggle"
          onClick={() => setIsFlowNoticeCollapsed((prev) => !prev)}
          aria-expanded={!isFlowNoticeCollapsed}
        >
          <div className="ghcp-flow-notice-title">
            <CircleAlert size={16} />
            <span>{t('kiro.flowNotice.title', 'Kiro 账号管理说明（点击展开/收起）')}</span>
          </div>
          <ChevronDown size={16} className={`ghcp-flow-notice-arrow ${isFlowNoticeCollapsed ? 'collapsed' : ''}`} />
        </button>
        {!isFlowNoticeCollapsed && (
          <div className="ghcp-flow-notice-body">
            <div className="ghcp-flow-notice-desc">
              {t(
                'kiro.flowNotice.desc',
                'Switching accounts requires reading VS Code local auth storage and using the system credential service for decrypt/re-encrypt. Data is processed locally only.',
              )}
            </div>
            <ul className="ghcp-flow-notice-list">
              <li>
                {t(
                  'kiro.flowNotice.reason',
                  'Permission scope: read VS Code auth database (state.vscdb) and call system credential capability (Windows DPAPI / macOS Keychain / Linux Secret Service) for decrypt/write-back.',
                )}
              </li>
              <li>
                {t(
                  'kiro.flowNotice.storage',
                  'Data scope: only Kiro auth-session related entries are read/updated; system secrets are not modified and no key/token is uploaded.',
                )}
              </li>
            </ul>
          </div>
        )}
      </div>

      {activeTab === 'overview' && (
        <>

      {message && (
        <div className={`message-bar ${message.tone === 'error' ? 'error' : 'success'}`}>
          {message.text}
          <button onClick={() => setMessage(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <Search size={16} className="search-icon" />
            <input
              type="text"
              placeholder={t('common.shared.search', '搜索账号...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="view-switcher">
            <button
              className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              title={t('common.shared.view.list', '列表视图')}
            >
              <List size={16} />
            </button>
            <button
              className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => setViewMode('grid')}
              title={t('common.shared.view.grid', '卡片视图')}
            >
              <LayoutGrid size={16} />
            </button>
          </div>

          <div className="filter-select">
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              aria-label={t('common.shared.filterLabel', '筛选')}
            >
              <option value="all">{`ALL (${tierSummary.all})`}</option>
              <option value="FREE">
                {resolveFilterLabel('FREE', tierSummary.knownCounts.FREE)}
              </option>
              <option value="INDIVIDUAL">
                {resolveFilterLabel('INDIVIDUAL', tierSummary.knownCounts.INDIVIDUAL)}
              </option>
              <option value="PRO">
                {resolveFilterLabel('PRO', tierSummary.knownCounts.PRO)}
              </option>
              <option value="BUSINESS">
                {resolveFilterLabel('BUSINESS', tierSummary.knownCounts.BUSINESS)}
              </option>
              <option value="ENTERPRISE">
                {resolveFilterLabel('ENTERPRISE', tierSummary.knownCounts.ENTERPRISE)}
              </option>
              {tierSummary.extraKeys.map((planKey) => (
                <option key={planKey} value={planKey}>
                  {resolveFilterLabel(planKey, tierSummary.dynamicCounts.get(planKey) ?? 0)}
                </option>
              ))}
            </select>
          </div>

          <div className="tag-filter" ref={tagFilterRef}>
            <button
              type="button"
              className={`tag-filter-btn ${tagFilter.length > 0 ? 'active' : ''}`}
              onClick={() => setShowTagFilter((prev) => !prev)}
              aria-label={t('accounts.filterTags', '标签筛选')}
            >
              <Tag size={14} />
              {tagFilter.length > 0 ? `${t('accounts.filterTagsCount', '标签')}(${tagFilter.length})` : t('accounts.filterTags', '标签筛选')}
            </button>
            {showTagFilter && (
              <div className="tag-filter-panel">
                {availableTags.length === 0 ? (
                  <div className="tag-filter-empty">{t('accounts.noAvailableTags', '暂无可用标签')}</div>
                ) : (
                  <div className="tag-filter-options">
                    {availableTags.map((tag) => (
                      <label key={tag} className={`tag-filter-option ${tagFilter.includes(tag) ? 'selected' : ''}`}>
                        <input
                          type="checkbox"
                          checked={tagFilter.includes(tag)}
                          onChange={() => toggleTagFilterValue(tag)}
                        />
                        <span className="tag-filter-name">{tag}</span>
                        <button
                          type="button"
                          className="tag-filter-delete"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            requestDeleteTag(tag);
                          }}
                          aria-label={t('accounts.deleteTagAria', {
                            tag,
                            defaultValue: '删除标签 {{tag}}',
                          })}
                        >
                          <X size={12} />
                        </button>
                      </label>
                    ))}
                  </div>
                )}
                <div className="tag-filter-divider" />
                <label className="tag-filter-group-toggle">
                  <input
                    type="checkbox"
                    checked={groupByTag}
                    onChange={(e) => setGroupByTag(e.target.checked)}
                  />
                  <span>{t('accounts.groupByTag', '按标签分组展示')}</span>
                </label>
                {tagFilter.length > 0 && (
                  <button type="button" className="tag-filter-clear" onClick={clearTagFilter}>
                    {t('accounts.clearFilter', '清空筛选')}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="sort-select">
            <ArrowDownWideNarrow size={14} className="sort-icon" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              aria-label={t('common.shared.sortLabel', '排序')}
            >
              <option value="created_at">{t('common.shared.sort.createdAt', '按创建时间')}</option>
              <option value="credits">{t('common.shared.sort.credits', '按剩余 Credits')}</option>
              <option value="plan_end">{t('common.shared.sort.planEnd', '按配额周期结束时间')}</option>
            </select>
          </div>

          <button
            className="sort-direction-btn"
            onClick={() => setSortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
            title={
              sortDirection === 'desc'
                ? t('common.shared.sort.descTooltip', '当前：降序，点击切换为升序')
                : t('common.shared.sort.ascTooltip', '当前：升序，点击切换为降序')
            }
            aria-label={t('common.shared.sort.toggleDirection', '切换排序方向')}
          >
            {sortDirection === 'desc' ? '⬇' : '⬆'}
          </button>
        </div>
        <div className="toolbar-right">
          <button
            className="btn btn-primary icon-only"
            onClick={() => openAddModal('oauth')}
            title={t('common.shared.addAccount', '添加账号')}
            aria-label={t('common.shared.addAccount', '添加账号')}
          >
            <Plus size={14} />
          </button>
          <button
            className="btn btn-secondary icon-only"
            onClick={handleRefreshAll}
            disabled={refreshingAll || accounts.length === 0}
            title={t('common.shared.refreshAll', '刷新全部')}
            aria-label={t('common.shared.refreshAll', '刷新全部')}
          >
            <RefreshCw size={14} className={refreshingAll ? 'loading-spinner' : ''} />
          </button>
          <button
            className="btn btn-secondary icon-only"
            onClick={togglePrivacyMode}
            title={
              privacyModeEnabled
                ? t('privacy.showSensitive', '显示邮箱')
                : t('privacy.hideSensitive', '隐藏邮箱')
            }
            aria-label={
              privacyModeEnabled
                ? t('privacy.showSensitive', '显示邮箱')
                : t('privacy.hideSensitive', '隐藏邮箱')
            }
          >
            {privacyModeEnabled ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button
            className="btn btn-secondary icon-only"
            onClick={() => openAddModal('token')}
            disabled={importing}
            title={t('common.shared.import.label', '导入')}
            aria-label={t('common.shared.import.label', '导入')}
          >
            <Download size={14} />
          </button>
          <button
            className="btn btn-secondary export-btn icon-only"
            onClick={handleExport}
            disabled={exporting}
            title={selected.size > 0 ? `${t('common.shared.export', '导出')} (${selected.size})` : t('common.shared.export', '导出')}
            aria-label={selected.size > 0 ? `${t('common.shared.export', '导出')} (${selected.size})` : t('common.shared.export', '导出')}
          >
            <Upload size={14} />
          </button>
          {selected.size > 0 && (
            <button
              className="btn btn-danger icon-only"
              onClick={handleBatchDelete}
              title={`${t('common.delete', '删除')} (${selected.size})`}
              aria-label={`${t('common.delete', '删除')} (${selected.size})`}
            >
              <Trash2 size={14} />
            </button>
          )}
            <QuickSettingsPopover type="kiro" />
        </div>
      </div>

      {loading && accounts.length === 0 ? (
        <div className="loading-container">
          <RefreshCw size={24} className="loading-spinner" />
          <p>{t('common.loading', '加载中...')}</p>
        </div>
      ) : accounts.length === 0 ? (
        <div className="empty-state">
          <Globe size={48} />
          <h3>{t('common.shared.empty.title', '暂无账号')}</h3>
          <p>{t('kiro.empty.description', '点击"添加账号"开始管理您的 Kiro 账号')}</p>
          <button className="btn btn-primary" onClick={() => openAddModal('oauth')}>
            <Plus size={16} />
            {t('common.shared.addAccount', '添加账号')}
          </button>
        </div>
      ) : filteredAccounts.length === 0 ? (
        <div className="empty-state">
          <h3>{t('common.shared.noMatch.title', '没有匹配的账号')}</h3>
          <p>{t('common.shared.noMatch.desc', '请尝试调整搜索或筛选条件')}</p>
        </div>
      ) : viewMode === 'grid' ? (
        groupByTag ? (
          <div className="tag-group-list">
            {groupedAccounts.map(([groupKey, groupAccounts]) => (
              <div key={groupKey} className="tag-group-section">
                <div className="tag-group-header">
                  <span className="tag-group-title">{resolveGroupLabel(groupKey)}</span>
                  <span className="tag-group-count">{groupAccounts.length}</span>
                </div>
                <div className="tag-group-grid ghcp-accounts-grid">
                  {renderGridCards(groupAccounts, groupKey)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="ghcp-accounts-grid">
            {renderGridCards(filteredAccounts)}
          </div>
        )
      ) : groupByTag ? (
        <div className="account-table-container grouped">
          <table className="account-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={selected.size === filteredAccounts.length && filteredAccounts.length > 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th style={{ width: 240 }}>{t('common.shared.columns.email', '邮箱')}</th>
                <th style={{ width: 120 }}>{t('common.shared.columns.plan', '计划')}</th>
                <th>{t('common.shared.columns.promptCredits', 'User Prompt credits')}</th>
                <th>{t('common.shared.columns.addOnPromptCredits', 'Add-on prompt credits')}</th>
                <th className="sticky-action-header table-action-header">{t('common.shared.columns.actions', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {groupedAccounts.map(([groupKey, groupAccounts]) => (
                <Fragment key={groupKey}>
                  <tr className="tag-group-row">
                    <td colSpan={6}>
                      <div className="tag-group-header">
                        <span className="tag-group-title">{resolveGroupLabel(groupKey)}</span>
                        <span className="tag-group-count">{groupAccounts.length}</span>
                      </div>
                    </td>
                  </tr>
                  {renderTableRows(groupAccounts, groupKey)}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="account-table-container">
          <table className="account-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={selected.size === filteredAccounts.length && filteredAccounts.length > 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th style={{ width: 240 }}>{t('common.shared.columns.email', '邮箱')}</th>
                <th style={{ width: 120 }}>{t('common.shared.columns.plan', '计划')}</th>
                <th>{t('common.shared.columns.promptCredits', 'User Prompt credits')}</th>
                <th>{t('common.shared.columns.addOnPromptCredits', 'Add-on prompt credits')}</th>
                <th className="sticky-action-header table-action-header">{t('common.shared.columns.actions', '操作')}</th>
              </tr>
            </thead>
            <tbody>
              {renderTableRows(filteredAccounts)}
            </tbody>
          </table>
        </div>
      )}

      {showAddModal && (
        <div className="modal-overlay" onClick={closeAddModal}>
          <div className="modal-content ghcp-add-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('kiro.addModal.title', '添加 Kiro 账号')}</h2>
              <button className="modal-close" onClick={closeAddModal} aria-label={t('common.close', '关闭')}>
                <X />
              </button>
            </div>

            <div className="modal-tabs">
              <button
                className={`modal-tab ${addTab === 'oauth' ? 'active' : ''}`}
                onClick={() => openAddModal('oauth')}
              >
                <Globe size={14} />
                {t('common.shared.addModal.oauth', 'OAuth')}
              </button>
              <button
                className={`modal-tab ${addTab === 'token' ? 'active' : ''}`}
                onClick={() => openAddModal('token')}
              >
                <KeyRound size={14} />
                Token / JSON
              </button>
              <button
                className={`modal-tab ${addTab === 'import' ? 'active' : ''}`}
                onClick={() => openAddModal('import')}
              >
                <Database size={14} />
                {t('common.shared.addModal.import', '本地导入')}
              </button>
            </div>

            <div className="modal-body">
              {addTab === 'oauth' && (
                <div className="add-section">
                  <p className="section-desc">
                    {t('kiro.oauth.desc', '点击下方按钮，在浏览器中完成 Kiro 授权登录。')}
                  </p>

                  {oauthPrepareError ? (
                    <div className="add-status error">
                      <CircleAlert size={16} />
                      <span>{oauthPrepareError}</span>
                      <button className="btn btn-sm btn-outline" onClick={handleRetryOauth}>
                        {t('common.shared.oauth.retry', '重新生成授权信息')}
                      </button>
                    </div>
                  ) : oauthUrl ? (
                    <div className="oauth-url-section">
                      <div className="oauth-url-box">
                        <input type="text" value={oauthUrl} readOnly />
                        <button onClick={handleCopyOauthUrl}>
                          {oauthUrlCopied ? <Check size={16} /> : <Copy size={16} />}
                        </button>
                      </div>
                      {!oauthUrl.includes('user_code=') && oauthUserCode && (
                        <div className="oauth-url-box">
                          <input type="text" value={oauthUserCode} readOnly />
                          <button onClick={handleCopyOauthUserCode}>
                            {oauthUserCodeCopied ? <Check size={16} /> : <Copy size={16} />}
                          </button>
                        </div>
                      )}
                      {oauthMeta && (
                        <p className="oauth-hint">
                          {t('common.shared.oauth.meta', '授权有效期：{{expires}}s；轮询间隔：{{interval}}s', {
                            expires: oauthMeta.expiresIn,
                            interval: oauthMeta.intervalSeconds,
                          })}
                        </p>
                      )}
                      <button
                        className="btn btn-primary btn-full"
                        onClick={handleOpenOauthUrl}
                      >
                        <Globe size={16} />
                        {t('common.shared.oauth.openBrowser', '在浏览器中打开')}
                      </button>
                      {oauthPolling && (
                        <div className="add-status loading">
                          <RefreshCw size={16} className="loading-spinner" />
                          <span>{t('common.shared.oauth.waiting', '等待授权完成...')}</span>
                        </div>
                      )}
                      {oauthCompleteError && (
                        <div className="add-status error">
                          <CircleAlert size={16} />
                          <span>{oauthCompleteError}</span>
                          {oauthTimedOut && (
                            <button className="btn btn-sm btn-outline" onClick={handleRetryOauth}>
                              {t('common.shared.oauth.timeoutRetry', '刷新授权链接')}
                            </button>
                          )}
                        </div>
                      )}
                      <p className="oauth-hint">
                        {t('common.shared.oauth.hint', 'Once authorized, this window will update automatically')}
                      </p>
                    </div>
                  ) : (
                    <div className="oauth-loading">
                      <RefreshCw size={24} className="loading-spinner" />
                      <span>{t('common.shared.oauth.preparing', '正在准备授权信息...')}</span>
                    </div>
                  )}
                </div>
              )}

              {addTab === 'token' && (
                <div className="add-section">
                  <p className="section-desc">
                    {t('kiro.token.desc', '粘贴您的 Kiro Access Token 或导出的 JSON 数据。')}
                  </p>
                  <details className="token-format-collapse">
                    <summary className="token-format-collapse-summary">必填字段与示例（点击展开）</summary>
                    <div className="token-format">
                      <p className="token-format-required">
                        必填字段：JSON 建议使用 access_token + refresh_token（accessToken/refreshToken 仅兼容）
                      </p>
                      <div className="token-format-group">
                        <div className="token-format-label">单条示例（JSON）</div>
                        <pre className="token-format-code">{KIRO_TOKEN_SINGLE_EXAMPLE}</pre>
                      </div>
                      <div className="token-format-group">
                        <div className="token-format-label">批量示例（JSON）</div>
                        <pre className="token-format-code">{KIRO_TOKEN_BATCH_EXAMPLE}</pre>
                      </div>
                    </div>
                  </details>
                  <textarea
                    className="token-input"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder={t('common.shared.token.placeholder', '粘贴 Token 或 JSON...')}
                  />
                  <button
                    className="btn btn-primary btn-full"
                    onClick={handleTokenImport}
                    disabled={importing || !tokenInput.trim()}
                  >
                    {importing ? <RefreshCw size={16} className="loading-spinner" /> : <Download size={16} />}
                    {t('common.shared.token.import', 'Import')}
                  </button>
                </div>
              )}

              {addTab === 'import' && (
                <div className="add-section">
                  <p className="section-desc">
                    {t('kiro.import.localDesc', '支持从本机 Kiro 客户端或 JSON 文件导入账号数据。')}
                  </p>
                  <button className="btn btn-secondary btn-full" onClick={handleImportFromLocalClient} disabled={importing}>
                    {importing ? <RefreshCw size={16} className="loading-spinner" /> : <Database size={16} />}
                    {t('kiro.import.localClient', '从本机 Kiro 导入')}
                  </button>
                  <div className="oauth-hint" style={{ margin: '8px 0 4px' }}>
                    {t('common.shared.import.orJson', '或从 JSON 文件导入')}
                  </div>
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept="application/json"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      // reset immediately so selecting the same file will trigger change again
                      e.target.value = '';
                      if (!file) return;
                      void handleImportJsonFile(file);
                    }}
                  />
                  <button className="btn btn-primary btn-full" onClick={handlePickImportFile} disabled={importing}>
                    {importing ? <RefreshCw size={16} className="loading-spinner" /> : <Database size={16} />}
                    {t('common.shared.import.pickFile', '选择 JSON 文件导入')}
                  </button>
                </div>
              )}

              {addStatus !== 'idle' && addStatus !== 'loading' && (
                <div className={`add-status ${addStatus}`}>
                  {addStatus === 'success' ? <Check size={16} /> : <CircleAlert size={16} />}
                  <span>{addMessage}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => !deleting && setDeleteConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('common.confirm')}</h2>
              <button
                className="modal-close"
                onClick={() => !deleting && setDeleteConfirm(null)}
                aria-label={t('common.close', '关闭')}
              >
                <X />
              </button>
            </div>
            <div className="modal-body">
              <p>{deleteConfirm.message}</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)} disabled={deleting}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {tagDeleteConfirm && (
        <div className="modal-overlay" onClick={() => !deletingTag && setTagDeleteConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('common.confirm')}</h2>
              <button
                className="modal-close"
                onClick={() => !deletingTag && setTagDeleteConfirm(null)}
                aria-label={t('common.close', '关闭')}
              >
                <X />
              </button>
            </div>
            <div className="modal-body">
              <p>
                {t('accounts.confirmDeleteTag', 'Delete tag "{{tag}}"? This tag will be removed from {{count}} accounts.', { tag: tagDeleteConfirm.tag, count: tagDeleteConfirm.count })}
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setTagDeleteConfirm(null)} disabled={deletingTag}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-danger" onClick={confirmDeleteTag} disabled={deletingTag}>
                {deletingTag ? t('common.processing', '处理中...') : t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <TagEditModal
        isOpen={!!showTagModal}
        initialTags={accounts.find((a) => a.id === showTagModal)?.tags || []}
        availableTags={availableTags}
        onClose={() => setShowTagModal(null)}
        onSave={handleSaveTags}
      />
        </>
      )}

      {activeTab === 'instances' && (
        <KiroInstancesContent />
      )}
    </div>
  );
}
