import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { BookOpenText, Download, MoreHorizontal, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { PlatformId } from '../types/platform';
import type {
  PlatformPackageChangelogEntry,
  PlatformPackageOperation,
  PlatformPackageProgressPayload,
  PlatformPackageProgressPhase,
  PlatformPackageState,
} from '../types/platformPackage';
import {
  formatPlatformPackageSize,
  getPlatformPackageFromPackages,
  usePlatformPackageStore,
} from '../stores/usePlatformPackageStore';
import { getPlatformUiDevConfig } from '../services/platformPackageService';
import { useGlobalModal } from '../hooks/useGlobalModal';
import { getPlatformLabel } from '../utils/platformMeta';
import './PlatformPackageToolbar.css';

const PLATFORM_PACKAGE_PROGRESS_EVENT = 'platform-package://progress';
const PLATFORM_PACKAGE_PROGRESS_LOCAL_EVENT = 'agtools:platform-package-progress';
const ERROR_URL_PATTERN = /https?:\/\/[^\s)]+/gi;
const RETRYABLE_PACKAGE_ERROR_TOKENS = [
  'error sending request',
  'failed to send request',
  'timeout',
  'timed out',
  'network',
  'dns',
  'tls',
  'ssl',
  'connection reset',
  'connection refused',
  'connection aborted',
  'broken pipe',
  'unexpected eof',
  'temporarily unavailable',
  'temporary failure',
  'no route to host',
  'unreachable',
];
const SOURCE_MISSING_ERROR_TOKENS = [
  '未找到平台包源',
  'no matching',
  'missing artifact',
  'no artifact',
];

type PackageAction = PlatformPackageOperation;

interface PlatformPackageDisplayError {
  summary: string;
  detail: string | null;
  retryable: boolean;
}

interface PlatformPackageToolbarProps {
  platformId: PlatformId;
  className?: string;
  fallbackState?: PlatformPackageState | null;
}

function normalizeLocaleKey(value: string): string {
  return value.trim().replace('_', '-').toLowerCase();
}

function buildLocaleFallbacks(language: string | undefined): string[] {
  const normalized = normalizeLocaleKey(language || '');
  const fallbacks: string[] = [];
  const push = (value: string) => {
    const key = normalizeLocaleKey(value);
    if (key && !fallbacks.includes(key)) {
      fallbacks.push(key);
    }
  };

  push(normalized);
  if (normalized.includes('-')) {
    push(normalized.split('-')[0]);
  }
  push('en-us');
  push('en');
  return fallbacks;
}

function getLocalizedChangelogNotes(
  entry: PlatformPackageChangelogEntry,
  language: string | undefined,
): string[] {
  const locales = entry.locales || {};
  const localeEntries = Object.entries(locales).map(([key, value]) => [
    normalizeLocaleKey(key),
    value,
  ] as const);

  for (const fallback of buildLocaleFallbacks(language)) {
    const match = localeEntries.find(([key]) => key === fallback);
    if (match && Array.isArray(match[1]?.notes) && match[1].notes.length > 0) {
      return match[1].notes;
    }
  }

  return entry.notes || [];
}

function comparePackageVersions(left: string | null | undefined, right: string | null | undefined): number {
  const parse = (value: string | null | undefined) => (value || '')
    .trim()
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  const leftParts = parse(left);
  const rightParts = parse(right);
  while (leftParts.length < 3) leftParts.push(0);
  while (rightParts.length < 3) rightParts.push(0);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function getRelevantChangelogEntries(state: PlatformPackageState): PlatformPackageChangelogEntry[] {
  const entries = state.changelog || [];
  if (state.installedVersion) {
    const newerEntries = entries.filter((entry) =>
      comparePackageVersions(entry.version, state.installedVersion) > 0,
    );
    if (newerEntries.length > 0) {
      return newerEntries;
    }
  }
  if (state.latestVersion) {
    const latestEntries = entries.filter((entry) => entry.version === state.latestVersion);
    if (latestEntries.length > 0) {
      return latestEntries;
    }
  }
  return entries;
}

function ChangelogEntryList({
  entries,
  language,
  t,
}: {
  entries: PlatformPackageChangelogEntry[];
  language: string | undefined;
  t: TFunction;
}) {
  if (entries.length <= 0) {
    return (
      <div className="platform-package-changelog-empty">
        {t('platformLayout.packageChangelogEmpty', '暂无更新日志。')}
      </div>
    );
  }

  return (
    <div className="platform-package-changelog-list">
      {entries.map((entry) => {
        const notes = getLocalizedChangelogNotes(entry, language);
        return (
          <section className="platform-package-changelog-entry" key={`${entry.version}:${entry.date || ''}`}>
            <div className="platform-package-changelog-entry-head">
              <strong>v{entry.version}</strong>
              {entry.date ? <span>{entry.date}</span> : null}
            </div>
            {notes.length > 0 ? (
              <ul>
                {notes.map((note, index) => (
                  <li key={`${entry.version}:${index}`}>{note}</li>
                ))}
              </ul>
            ) : (
              <p>{t('platformLayout.packageChangelogEntryEmpty', '此版本暂无说明。')}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function getPlatformPackageShortStatus(
  state: PlatformPackageState | null | undefined,
  t: TFunction,
): { label: string; tone: 'warning' | 'info' | 'danger' | 'muted' } | null {
  if (!state || state.packageMode !== 'hotUpdate') {
    return null;
  }

  if (state.installStatus === 'notInstalled') {
    return {
      label: t('platformLayout.packageInstallRequired', '未安装'),
      tone: 'warning',
    };
  }
  if (state.installStatus === 'updateAvailable') {
    return {
      label: t('platformLayout.packageUpdateAvailableShort', '可更新'),
      tone: 'info',
    };
  }
  if (state.installStatus === 'incompatible') {
    return {
      label: t('platformLayout.packageIncompatibleShort', '不兼容'),
      tone: 'danger',
    };
  }
  if (state.installStatus === 'error' || !state.runtimeReady) {
    return {
      label: t('platformLayout.packageRepairRequired', '需修复'),
      tone: 'danger',
    };
  }
  if (
    state.installStatus === 'installing'
    || state.installStatus === 'updating'
    || state.installStatus === 'uninstalling'
  ) {
    return {
      label: t('platformLayout.packageOperating', '处理中'),
      tone: 'muted',
    };
  }
  return null;
}

export function getPlatformPackageStatusText(
  state: PlatformPackageState,
  t: TFunction,
): string {
  if (state.packageMode === 'bundled') {
    return t('platformLayout.packageBundledStatus', '随主应用提供');
  }

  const version = state.installedVersion || state.latestVersion || '--';
  const installedSize = formatPlatformPackageSize(state.installedSizeBytes);
  const downloadSize = formatPlatformPackageSize(state.downloadSizeBytes);

  switch (state.installStatus) {
    case 'notInstalled':
      return t('platformLayout.packageNotInstalled', {
        size: downloadSize,
        defaultValue: '未下载 · {{size}}',
      });
    case 'updateAvailable':
      return t('platformLayout.packageUpdateAvailable', {
        version: state.latestVersion || '--',
        size: downloadSize,
        defaultValue: '可更新 {{version}} · {{size}}',
      });
    case 'incompatible':
      return t('platformLayout.packageIncompatible', '主应用版本不兼容');
    case 'error':
      return state.errorMessage || t('platformLayout.packageError', '状态异常');
    case 'installing':
    case 'updating':
    case 'uninstalling':
      return t('platformLayout.packageOperating', '处理中');
    default:
      return t('platformLayout.packageInstalled', {
        version,
        size: installedSize,
        defaultValue: '已安装 v{{version}} · {{size}}',
      });
  }
}

function dispatchPlatformPackageChanged(state: PlatformPackageState) {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent('agtools:platform-package-changed', {
      detail: state,
    }),
  );
}

function dispatchPlatformPackageProgress(payload: PlatformPackageProgressPayload) {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<PlatformPackageProgressPayload>(PLATFORM_PACKAGE_PROGRESS_LOCAL_EVENT, {
      detail: payload,
    }),
  );
}

function getProgressPhaseText(phase: PlatformPackageProgressPhase, t: TFunction): string {
  switch (phase) {
    case 'resolving':
      return t('platformLayout.packageProgressResolving', '正在解析平台包来源');
    case 'downloading':
      return t('platformLayout.packageProgressDownloading', '正在下载平台包');
    case 'verifying':
      return t('platformLayout.packageProgressVerifying', '正在校验平台包');
    case 'extracting':
      return t('platformLayout.packageProgressExtracting', '正在解压平台包');
    case 'installing':
      return t('platformLayout.packageProgressInstalling', '正在切换运行组件');
    case 'uninstalling':
      return t('platformLayout.packageProgressUninstalling', '正在移除平台包');
    case 'completed':
      return t('platformLayout.packageProgressCompleted', '已完成');
    case 'failed':
      return t('platformLayout.packageProgressFailed', '处理失败');
    default:
      return t('platformLayout.packageProgressWorking', '正在处理平台包');
  }
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function compactErrorDetail(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function isRetryablePackageError(message: string): boolean {
  const normalized = message.toLowerCase();
  return RETRYABLE_PACKAGE_ERROR_TOKENS.some((token) => normalized.includes(token));
}

function isSourceMissingPackageError(message: string): boolean {
  const normalized = message.toLowerCase();
  return SOURCE_MISSING_ERROR_TOKENS.some((token) => normalized.includes(token));
}

function isPackageVerifyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('sha256')
    || normalized.includes('hash mismatch')
    || normalized.includes('checksum')
    || normalized.includes('校验失败');
}

export function formatPlatformPackageOperationError(
  error: unknown,
  t: TFunction,
): PlatformPackageDisplayError {
  const raw = normalizeErrorMessage(error);
  const detail = compactErrorDetail(raw);
  const redactedDetail = detail.replace(ERROR_URL_PATTERN, '[URL]');
  const retryable = isRetryablePackageError(detail);
  let summary: string;

  if (retryable) {
    summary = t(
      'platformLayout.packageDownloadFailedRetryable',
      '平台包下载失败，可能是网络或代理暂时不可用。请检查网络后重试。',
    );
  } else if (isSourceMissingPackageError(detail)) {
    summary = t(
      'platformLayout.packageDownloadSourceMissing',
      '当前系统没有可用的平台包源，请稍后检查更新或切换到支持的安装包。',
    );
  } else if (isPackageVerifyError(detail)) {
    summary = t(
      'platformLayout.packageDownloadVerifyFailed',
      '平台包校验失败，请重新下载；如果持续失败，请等待平台包重新发布。',
    );
  } else {
    summary = t('platformLayout.packageOperationFailedFriendly', '平台包处理失败，请稍后重试。');
  }

  return {
    summary,
    detail: redactedDetail && redactedDetail !== summary ? redactedDetail : null,
    retryable,
  };
}

export function PlatformPackageOperationProgress({
  platformId,
  operation,
  fallbackTotalBytes,
}: {
  platformId: PlatformId;
  operation: PlatformPackageOperation;
  fallbackTotalBytes?: number | null;
}) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<PlatformPackageProgressPayload | null>(null);
  const [showErrorDetail, setShowErrorDetail] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    setProgress(null);

    const handleLocalProgress = (event: Event) => {
      const payload = (event as CustomEvent<PlatformPackageProgressPayload>).detail;
      if (!payload || payload.platformId !== platformId || payload.operation !== operation) {
        return;
      }
      setProgress(payload);
    };

    window.addEventListener(PLATFORM_PACKAGE_PROGRESS_LOCAL_EVENT, handleLocalProgress);

    void listen<PlatformPackageProgressPayload>(PLATFORM_PACKAGE_PROGRESS_EVENT, (event) => {
      const payload = event.payload;
      if (payload.platformId !== platformId || payload.operation !== operation) {
        return;
      }
      setProgress(payload);
    }).then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      disposed = true;
      window.removeEventListener(PLATFORM_PACKAGE_PROGRESS_LOCAL_EVENT, handleLocalProgress);
      if (unlisten) {
        unlisten();
      }
    };
  }, [operation, platformId]);

  useEffect(() => {
    if (progress?.phase !== 'failed') {
      setShowErrorDetail(false);
    }
  }, [progress?.phase, progress?.message]);

  const percent = typeof progress?.percent === 'number'
    ? Math.min(100, Math.max(0, Math.round(progress.percent)))
    : null;
  const phaseText = progress
    ? getProgressPhaseText(progress.phase, t)
    : t('platformLayout.packageProgressWaiting', '等待开始处理');
  const downloadedBytes = progress?.downloadedBytes ?? null;
  const totalBytes = progress?.totalBytes ?? fallbackTotalBytes ?? null;
  const showBytes = typeof downloadedBytes === 'number' && downloadedBytes > 0;
  const bytesText = showBytes
    ? typeof totalBytes === 'number' && totalBytes > 0
      ? t('platformLayout.packageProgressDownloaded', {
        downloaded: formatPlatformPackageSize(downloadedBytes),
        total: formatPlatformPackageSize(totalBytes),
        defaultValue: '已下载 {{downloaded}} / {{total}}',
      })
      : t('platformLayout.packageProgressDownloadedUnknown', {
        downloaded: formatPlatformPackageSize(downloadedBytes),
        defaultValue: '已下载 {{downloaded}}',
      })
    : null;
  const isFailed = progress?.phase === 'failed';
  const isIndeterminate = Boolean(progress && percent === null && !isFailed);
  const displayError = isFailed && progress?.message
    ? formatPlatformPackageOperationError(progress.message, t)
    : null;

  return (
    <div
      className={`platform-package-progress${isIndeterminate ? ' is-indeterminate' : ''}${isFailed ? ' is-failed' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="platform-package-progress-head">
        <span>{phaseText}</span>
        {percent !== null && <strong>{percent}%</strong>}
      </div>
      <div className="platform-package-progress-track" aria-hidden="true">
        <div
          className="platform-package-progress-bar"
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>
      {(bytesText || progress?.message) && (
        <div className="platform-package-progress-meta">
          {displayError ? (
            <div className="platform-package-progress-error">
              <div className="platform-package-progress-error-summary">
                {displayError.summary}
              </div>
              {displayError.retryable && (
                <div className="platform-package-progress-error-hint">
                  {t('platformLayout.packageOperationRetryHint', '可以点击下方按钮重试。')}
                </div>
              )}
              {displayError.detail && (
                <div className="platform-package-progress-error-detail">
                  <button
                    type="button"
                    className="platform-package-progress-error-detail-toggle"
                    onClick={() => setShowErrorDetail((value) => !value)}
                  >
                    {showErrorDetail
                      ? t('update_notification.hideErrorDetails', '收起详情')
                      : t('update_notification.showErrorDetails', '查看详情')}
                  </button>
                  {showErrorDetail && (
                    <pre>{displayError.detail}</pre>
                  )}
                </div>
              )}
            </div>
          ) : bytesText}
        </div>
      )}
    </div>
  );
}

export function PlatformPackageToolbar({
  platformId,
  className,
  fallbackState,
}: PlatformPackageToolbarProps) {
  const { t, i18n } = useTranslation();
  const { showModal } = useGlobalModal();
  const packages = usePlatformPackageStore((state) => state.packages);
  const loading = usePlatformPackageStore((state) => state.loading);
  const checkUpdate = usePlatformPackageStore((state) => state.checkUpdate);
  const installPackage = usePlatformPackageStore((state) => state.installPackage);
  const updatePackage = usePlatformPackageStore((state) => state.updatePackage);
  const reloadPackage = usePlatformPackageStore((state) => state.reloadPackage);
  const uninstallPackage = usePlatformPackageStore((state) => state.uninstallPackage);
  const refreshPackages = usePlatformPackageStore((state) => state.refresh);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [localReloadEnabled, setLocalReloadEnabled] = useState(false);
  const actionPromisesRef = useRef<Map<string, Promise<PlatformPackageState>>>(new Map());
  const rootRef = useRef<HTMLDivElement | null>(null);

  const platformPackage = useMemo(
    () => getPlatformPackageFromPackages(packages, platformId) ?? fallbackState ?? null,
    [fallbackState, packages, platformId],
  );

  const platformName = getPlatformLabel(platformId, t);

  const runAction = useCallback(async (
    action: PackageAction,
    options?: { requireRuntimeReady?: boolean; totalBytes?: number | null },
  ): Promise<PlatformPackageState> => {
    const key = `${platformId}:${action}`;
    const existing = actionPromisesRef.current.get(key);
    if (existing) {
      return await existing;
    }

    const promise = (async () => {
      setActionKey(key);
      setOperationError(null);
      dispatchPlatformPackageProgress({
        platformId,
        operation: action,
        phase: action === 'uninstall' ? 'uninstalling' : 'resolving',
        percent: 0,
        downloadedBytes: null,
        totalBytes: options?.totalBytes ?? null,
        message: null,
      });
      let nextState = action === 'install'
        ? await installPackage(platformId)
        : action === 'update'
          ? await updatePackage(platformId)
          : await uninstallPackage(platformId);
      dispatchPlatformPackageChanged(nextState);
      if (options?.requireRuntimeReady && !nextState.runtimeReady) {
        try {
          const refreshedPackages = await refreshPackages();
          const refreshedState = getPlatformPackageFromPackages(refreshedPackages, platformId);
          if (refreshedState) {
            nextState = refreshedState;
            dispatchPlatformPackageChanged(nextState);
          }
        } catch {
          // Keep the original action result; the operation error below will surface it.
        }
      }
      if (options?.requireRuntimeReady && !nextState.runtimeReady) {
        throw new Error(
          nextState.errorMessage || t('platformLayout.packageInstallNotReady', '平台包已处理，但运行组件尚未就绪'),
        );
      }
      dispatchPlatformPackageProgress({
        platformId,
        operation: action,
        phase: 'completed',
        percent: 100,
        downloadedBytes: null,
        totalBytes: options?.totalBytes ?? null,
        message: null,
      });
      return nextState;
    })()
      .catch((error) => {
        const message = normalizeErrorMessage(error);
        const displayError = formatPlatformPackageOperationError(message, t);
        setOperationError(displayError.summary);
        dispatchPlatformPackageProgress({
          platformId,
          operation: action,
          phase: 'failed',
          percent: null,
          downloadedBytes: null,
          totalBytes: options?.totalBytes ?? null,
          message,
        });
        throw new Error(displayError.summary);
      })
      .finally(() => {
        actionPromisesRef.current.delete(key);
        setActionKey((current) => (current === key ? null : current));
      });

    actionPromisesRef.current.set(key, promise);
    return await promise;
  }, [installPackage, platformId, refreshPackages, t, uninstallPackage, updatePackage]);

  const confirmAction = useCallback((action: PackageAction) => {
    if (!platformPackage) {
      return;
    }
    setMenuOpen(false);

    const version = action === 'update'
      ? platformPackage.latestVersion || '--'
      : platformPackage.latestVersion || platformPackage.installedVersion || '--';
    const size = action === 'uninstall'
      ? formatPlatformPackageSize(platformPackage.installedSizeBytes)
      : formatPlatformPackageSize(platformPackage.downloadSizeBytes);
    const isRepair = action === 'install' && platformPackage.installStatus === 'error';

    const title = action === 'uninstall'
      ? t('platformLayout.packageUninstallConfirmTitle', {
          platform: platformName,
          defaultValue: '卸载 {{platform}} 平台包',
        })
      : action === 'update'
        ? t('platformLayout.packageUpdateConfirmTitle', {
            platform: platformName,
            defaultValue: '更新 {{platform}} 平台包',
          })
        : isRepair
          ? t('platformLayout.packageRepairConfirmTitle', {
              platform: platformName,
              defaultValue: '修复 {{platform}} 平台包',
            })
          : t('platformLayout.packageInstallConfirmTitle', {
              platform: platformName,
              defaultValue: '安装 {{platform}} 平台包',
            });
    const description = action === 'uninstall'
      ? t('platformLayout.packageUninstallConfirmDesc', {
          platform: platformName,
          size,
          defaultValue: '将移除 {{platform}} 的平台包和运行组件，占用 {{size}}；已保存账号数据不会删除。',
        })
      : action === 'update'
        ? t('platformLayout.packageUpdateConfirmDesc', {
            platform: platformName,
            version,
            size,
            defaultValue: '将下载并切换到 {{platform}} 平台包 {{version}}，大小 {{size}}。',
          })
        : isRepair
          ? t('platformLayout.packageRepairConfirmDesc', {
              platform: platformName,
              version,
              size,
              defaultValue: '将重新下载并校验 {{platform}} 平台包 {{version}}，大小 {{size}}。',
            })
          : t('platformLayout.packageInstallConfirmDesc', {
              platform: platformName,
              version,
              size,
              defaultValue: '{{platform}} 需要先下载平台包。版本 {{version}}，大小 {{size}}。',
            });
    const actionLabel = action === 'uninstall'
      ? t('platformLayout.packageUninstall', '卸载')
      : action === 'update'
        ? t('platformLayout.packageUpdate', '更新')
        : isRepair
          ? t('platformLayout.packageRepair', '修复')
          : t('platformLayout.packageDownload', '下载');

    showModal({
      title,
      description,
      content: (
        <PlatformPackageOperationProgress
          platformId={platformId}
          operation={action}
          fallbackTotalBytes={action === 'uninstall' ? null : platformPackage.downloadSizeBytes}
        />
      ),
      width: 'sm',
      actions: [
        {
          id: 'cancel',
          label: t('common.cancel', '取消'),
          variant: 'secondary',
        },
          {
            id: `platform-package-${action}`,
            label: actionLabel,
            variant: action === 'uninstall' ? 'danger' : 'primary',
            suppressError: true,
            onClick: async () => {
              await runAction(action, {
                requireRuntimeReady: action !== 'uninstall',
              totalBytes: action === 'uninstall' ? null : platformPackage.downloadSizeBytes,
            });
          },
        },
      ],
    });
  }, [platformId, platformName, platformPackage, runAction, showModal, t]);

  const handleCheckUpdate = useCallback(async () => {
    if (!platformPackage || actionKey) {
      return;
    }
    const key = `${platformId}:check`;
    setActionKey(key);
    setOperationError(null);
    try {
      const nextState = await checkUpdate(platformId);
      dispatchPlatformPackageChanged(nextState);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionKey((current) => (current === key ? null : current));
    }
  }, [actionKey, checkUpdate, platformId, platformPackage]);

  const runLocalReload = useCallback(async (): Promise<PlatformPackageState> => {
    const key = `${platformId}:reload`;
    const existing = actionPromisesRef.current.get(key);
    if (existing) {
      return await existing;
    }

    const promise = (async () => {
      setActionKey(key);
      setOperationError(null);
      dispatchPlatformPackageProgress({
        platformId,
        operation: 'update',
        phase: 'resolving',
        percent: 0,
        downloadedBytes: null,
        totalBytes: null,
        message: t('platformLayout.packageReloadProgressRebuilding', '正在重建本地平台包'),
      });
      let nextState = await reloadPackage(platformId);
      dispatchPlatformPackageChanged(nextState);
      if (!nextState.runtimeReady) {
        try {
          const refreshedPackages = await refreshPackages();
          const refreshedState = getPlatformPackageFromPackages(refreshedPackages, platformId);
          if (refreshedState) {
            nextState = refreshedState;
            dispatchPlatformPackageChanged(nextState);
          }
        } catch {
          // Keep the reload result; the runtime-ready check below will surface the error.
        }
      }
      if (!nextState.runtimeReady) {
        throw new Error(
          nextState.errorMessage || t('platformLayout.packageInstallNotReady', '平台包已处理，但运行组件尚未就绪'),
        );
      }
      dispatchPlatformPackageProgress({
        platformId,
        operation: 'update',
        phase: 'completed',
        percent: 100,
        downloadedBytes: null,
        totalBytes: null,
        message: null,
      });
      return nextState;
    })()
      .catch((error) => {
        const message = normalizeErrorMessage(error);
        const displayError = formatPlatformPackageOperationError(message, t);
        setOperationError(displayError.summary);
        dispatchPlatformPackageProgress({
          platformId,
          operation: 'update',
          phase: 'failed',
          percent: null,
          downloadedBytes: null,
          totalBytes: null,
          message,
        });
        throw new Error(displayError.summary);
      })
      .finally(() => {
        actionPromisesRef.current.delete(key);
        setActionKey((current) => (current === key ? null : current));
      });

    actionPromisesRef.current.set(key, promise);
    return await promise;
  }, [platformId, refreshPackages, reloadPackage, t]);

  const confirmLocalReload = useCallback(() => {
    if (!platformPackage) {
      return;
    }
    setMenuOpen(false);
    showModal({
      title: t('platformLayout.packageReloadConfirmTitle', {
        platform: platformName,
        defaultValue: '重载 {{platform}} 平台包',
      }),
      description: t('platformLayout.packageReloadConfirmDesc', {
        platform: platformName,
        defaultValue: '将重新构建本地 {{platform}} 平台包并切换到最新开发包；已保存账号数据不会删除。',
      }),
      content: (
        <PlatformPackageOperationProgress
          platformId={platformId}
          operation="update"
          fallbackTotalBytes={platformPackage.downloadSizeBytes}
        />
      ),
      width: 'sm',
      actions: [
        {
          id: 'cancel',
          label: t('common.cancel', '取消'),
          variant: 'secondary',
        },
          {
            id: 'platform-package-reload',
            label: t('platformLayout.packageReload', '重载'),
            variant: 'primary',
            suppressError: true,
            onClick: async () => {
              await runLocalReload();
            },
        },
      ],
    });
  }, [platformId, platformName, platformPackage, runLocalReload, showModal, t]);

  const showChangelog = useCallback(() => {
    if (!platformPackage) {
      return;
    }
    setMenuOpen(false);
    const entries = platformPackage.changelog || [];
    showModal({
      title: t('platformLayout.packageChangelogTitle', {
        platform: platformName,
        defaultValue: '{{platform}} 更新日志',
      }),
      width: 'md',
      content: (
        <ChangelogEntryList
          entries={entries}
          language={i18n.language}
          t={t}
        />
      ),
      actions: [
        {
          id: 'close',
          label: t('common.close', '关闭'),
          variant: 'primary',
        },
      ],
    });
  }, [i18n.language, platformName, platformPackage, showModal, t]);

  const showUpdateDialog = useCallback(() => {
    if (!platformPackage || platformPackage.installStatus !== 'updateAvailable') {
      return;
    }

    setMenuOpen(false);
    const latestVersion = platformPackage.latestVersion || '--';
    const currentVersion = platformPackage.installedVersion || '--';
    const downloadSize = formatPlatformPackageSize(platformPackage.downloadSizeBytes);
    const entries = getRelevantChangelogEntries(platformPackage);

    showModal({
      title: t('update_notification.title', '发现新版本'),
      width: 'md',
      content: (
        <div className="platform-package-update-dialog">
          <div className="platform-package-update-version">v{latestVersion}</div>
          <p className="platform-package-update-message">
            {t('update_notification.message', {
              current: currentVersion,
              defaultValue: '当前版本 v{{current}}，新版本已可用。',
            })}
          </p>
          <div className="platform-package-update-meta">
            <span>
              {t('platformLayout.packageUpdateAvailable', {
                version: latestVersion,
                size: downloadSize,
                defaultValue: '可更新 {{version}} · {{size}}',
              })}
            </span>
          </div>
          <PlatformPackageOperationProgress
            platformId={platformId}
            operation="update"
            fallbackTotalBytes={platformPackage.downloadSizeBytes}
          />
          <div className="platform-package-update-notes">
            <h3>{t('update_notification.whatsNew', '更新内容')}</h3>
            <ChangelogEntryList
              entries={entries}
              language={i18n.language}
              t={t}
            />
          </div>
        </div>
      ),
      actions: [
        {
          id: 'platform-package-skip-update',
          label: t('update_notification.skipThisVersion', '跳过此版本'),
          variant: 'secondary',
        },
          {
            id: 'platform-package-update-now',
            label: t('update_notification.updateNow', '立即更新'),
            variant: 'primary',
            suppressError: true,
            onClick: async () => {
              await runAction('update', {
              requireRuntimeReady: true,
              totalBytes: platformPackage.downloadSizeBytes,
            });
          },
        },
      ],
    });
  }, [i18n.language, platformId, platformPackage, runAction, showModal, t]);

  useEffect(() => {
    setOperationError(null);
  }, [platformPackage?.installStatus, platformPackage?.installedVersion, platformPackage?.latestVersion]);

  useEffect(() => {
    let cancelled = false;
    void getPlatformUiDevConfig()
      .then((config) => {
        if (!cancelled) {
          setLocalReloadEnabled(Boolean(config.packageReloadUrl));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalReloadEnabled(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  if (!platformPackage) {
    return null;
  }

  const isHotUpdate = platformPackage.packageMode === 'hotUpdate';
  const operating = loading || Boolean(actionKey);
  const statusText = getPlatformPackageStatusText(platformPackage, t);
  const canInstall = isHotUpdate && (platformPackage.installStatus === 'notInstalled'
    || platformPackage.installStatus === 'error'
    || (!platformPackage.runtimeReady && platformPackage.installStatus !== 'incompatible'));
  const canUpdate = isHotUpdate && platformPackage.installStatus === 'updateAvailable';
  const shouldShowRepairAction = isHotUpdate && (
    platformPackage.installStatus === 'error'
    || (!platformPackage.runtimeReady && platformPackage.installStatus !== 'notInstalled')
  );
  const hasInstalledPackage = isHotUpdate && Boolean(
    platformPackage.runtimeReady
    || platformPackage.installedVersion
    || platformPackage.installedSizeBytes,
  );
  const canReloadLocalPackage = isHotUpdate && hasInstalledPackage && localReloadEnabled;
  const currentVersion = platformPackage.installedVersion || '--';
  const latestVersion = platformPackage.latestVersion || '--';
  const topActionKey = canUpdate
    ? `${platformId}:update`
    : canInstall
      ? `${platformId}:install`
      : `${platformId}:check`;
  const topActionLabel = canUpdate
    ? t('platformLayout.packageUpdate', '更新')
    : canInstall
      ? shouldShowRepairAction
        ? t('platformLayout.packageRepair', '修复')
        : t('platformLayout.packageDownload', '下载')
      : t('platformLayout.packageCheckUpdate', '检查更新');
  const topActionTitle = canUpdate
    ? t('platformLayout.packageUpdate', '更新')
    : canInstall
      ? shouldShowRepairAction
        ? t('platformLayout.packageRepair', '修复')
        : t('platformLayout.packageDownload', '下载')
      : t('platformLayout.packageCheckUpdate', '检查更新');
  const renderTopActionIcon = () => {
    if (actionKey === topActionKey) {
      return <RefreshCw size={15} className="loading-spinner" />;
    }
    if (canInstall) {
      return <Download size={15} />;
    }
    return <RotateCw size={15} />;
  };
  const handleTopAction = () => {
    if (operating || !isHotUpdate) {
      return;
    }
    if (canUpdate) {
      showUpdateDialog();
      return;
    }
    if (canInstall) {
      confirmAction('install');
      return;
    }
    void handleCheckUpdate();
  };

  return (
    <div className={`platform-package-toolbar ${className || ''}`.trim()} ref={rootRef}>
      {isHotUpdate && (
        <button
          type="button"
          className={`platform-package-inline-action${canUpdate ? ' is-primary' : ''}`}
          title={topActionTitle}
          onClick={handleTopAction}
          disabled={operating}
        >
          {renderTopActionIcon()}
          <span>{topActionLabel}</span>
        </button>
      )}

      {canReloadLocalPackage && (
        <button
          type="button"
          className="platform-package-inline-action"
          title={t('platformLayout.packageReload', '重载')}
          onClick={confirmLocalReload}
          disabled={operating}
        >
          {actionKey === `${platformId}:reload`
            ? <RefreshCw size={15} className="loading-spinner" />
            : <RefreshCw size={15} />}
          <span>{t('platformLayout.packageReload', '重载')}</span>
        </button>
      )}

      {hasInstalledPackage && (
        <button
          type="button"
          className="platform-package-inline-action is-danger"
          title={t('platformLayout.packageUninstall', '卸载')}
          onClick={() => confirmAction('uninstall')}
          disabled={operating}
        >
          {actionKey === `${platformId}:uninstall`
            ? <RefreshCw size={15} className="loading-spinner" />
            : <Trash2 size={15} />}
          <span>{t('platformLayout.packageUninstall', '卸载')}</span>
        </button>
      )}

      <button
        type="button"
        className={`platform-package-menu-trigger${menuOpen ? ' is-open' : ''}`}
        title={t('common.more', '更多')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreHorizontal size={18} />
      </button>

      {menuOpen && (
        <div className="platform-package-menu" role="menu">
          <div className="platform-package-menu-head">
            <div className="platform-package-menu-status" title={statusText}>{statusText}</div>
            <div className="platform-package-menu-meta">
              {isHotUpdate ? (
                <span>
                  {t('platformLayout.packageCurrentVersion', {
                    version: currentVersion,
                    defaultValue: '当前 {{version}}',
                  })}
                </span>
              ) : (
                <span>{t('platformLayout.packageBundledShort', '内置')}</span>
              )}
              {isHotUpdate && platformPackage.installStatus === 'updateAvailable' && (
                <span>
                  {t('platformLayout.packageLatestVersion', {
                    version: latestVersion,
                    defaultValue: '最新 {{version}}',
                  })}
                </span>
              )}
            </div>
          </div>

          {operationError && (
            <div className="platform-package-menu-error" role="alert">
              {operationError}
            </div>
          )}

          {isHotUpdate ? (
            <div className="platform-package-menu-actions">
              <button
                type="button"
                className="platform-package-menu-action"
                onClick={handleCheckUpdate}
                disabled={operating}
                role="menuitem"
                title={t('platformLayout.packageCheckUpdate', '检查更新')}
              >
                <RotateCw size={14} className={actionKey === `${platformId}:check` ? 'loading-spinner' : ''} />
                <span>{t('platformLayout.packageCheckUpdateShort', '检查')}</span>
              </button>
              <button
                type="button"
                className="platform-package-menu-action"
                onClick={showChangelog}
                disabled={operating}
                role="menuitem"
                title={t('platformLayout.packageChangelog', '更新日志')}
              >
                <BookOpenText size={14} />
                <span>{t('platformLayout.packageChangelogShort', '日志')}</span>
              </button>
              {canInstall && (
                <button
                  type="button"
                  className="platform-package-menu-action is-primary"
                  onClick={() => confirmAction('install')}
                  disabled={operating}
                  role="menuitem"
                  title={shouldShowRepairAction
                    ? t('platformLayout.packageRepair', '修复')
                    : t('platformLayout.packageDownload', '下载')}
                >
                  {actionKey === `${platformId}:install`
                    ? <RefreshCw size={14} className="loading-spinner" />
                    : <Download size={14} />}
                  <span>
                    {shouldShowRepairAction
                      ? t('platformLayout.packageRepair', '修复')
                      : t('platformLayout.packageDownload', '下载')}
                  </span>
                </button>
              )}
              {canUpdate && (
                <button
                  type="button"
                  className="platform-package-menu-action is-primary"
                  onClick={showUpdateDialog}
                  disabled={operating}
                  role="menuitem"
                  title={t('platformLayout.packageUpdate', '更新')}
                >
                  <RefreshCw size={14} className={actionKey === `${platformId}:update` ? 'loading-spinner' : ''} />
                  <span>{t('platformLayout.packageUpdate', '更新')}</span>
                </button>
              )}
              {hasInstalledPackage && (
                <button
                  type="button"
                  className="platform-package-menu-action is-danger"
                  onClick={() => confirmAction('uninstall')}
                  disabled={operating}
                  role="menuitem"
                  title={t('platformLayout.packageUninstall', '卸载')}
                >
                  {actionKey === `${platformId}:uninstall`
                    ? <RefreshCw size={14} className="loading-spinner" />
                    : <Trash2 size={14} />}
                  <span>{t('platformLayout.packageUninstall', '卸载')}</span>
                </button>
              )}
            </div>
          ) : (
            <div className="platform-package-menu-note">
              {t(
                'platformLayout.packageBundledDesc',
                '此平台随主应用提供，安装和更新跟随主应用版本。',
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
