import { ChangeEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { ExportJsonModal } from './ExportJsonModal';
import { useExportJsonModal } from '../hooks/useExportJsonModal';
import {
  AccountTransferImportProgress,
  AccountTransferImportProgressDetail,
  exportAllAccountsTransferJson,
  importAllAccountsFromTransferJson,
} from '../services/accountTransferService';
import { getPlatformLabel } from '../utils/platformMeta';

type TransferFeedbackTone = 'loading' | 'success' | 'error';

interface TransferFeedback {
  tone: TransferFeedbackTone;
  text: string;
}

function normalizeError(error: unknown): string {
  return String(error).replace(/^Error:\s*/, '');
}

function normalizeImportErrorMessage(rawError: string, fallbackMessage: string): string {
  if (rawError.startsWith('invalid_')) {
    return fallbackMessage;
  }
  return rawError;
}

function renderToBody(node: ReactNode) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  return createPortal(node, document.body);
}

export function SettingsAccountTransferSection() {
  const { t } = useTranslation();
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const modalBodyRef = useRef<HTMLDivElement | null>(null);
  const progressListRef = useRef<HTMLDivElement | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [feedback, setFeedback] = useState<TransferFeedback | null>(null);
  const [importProgress, setImportProgress] = useState<AccountTransferImportProgress | null>(null);

  const setExportFailed = useCallback(
    (error: unknown) => {
      setFeedback({
        tone: 'error',
        text: t('messages.exportFailed', {
          error: normalizeError(error),
        }),
      });
    },
    [t],
  );

  const setImportFailed = useCallback(
    (error: unknown) => {
      const rawError = normalizeError(error);
      setFeedback({
        tone: 'error',
        text: t('common.shared.import.failedMsg', {
          error: normalizeImportErrorMessage(rawError, t('messages.jsonRequired')),
        }),
      });
    },
    [t],
  );

  const exportModal = useExportJsonModal({
    exportFilePrefix: 'all_platform_accounts',
    exportJsonByIds: async () => exportAllAccountsTransferJson(),
    onError: setExportFailed,
  });

  const handleExport = useCallback(async () => {
    setFeedback(null);
    await exportModal.startExport(['all'], 'all_platform_accounts_transfer');
  }, [exportModal]);

  const closeImportModal = useCallback(() => {
    if (importing) return;
    setShowImportModal(false);
    setJsonInput('');
    setImportProgress(null);
    setFeedback(null);
  }, [importing]);

  const calcProgressPercent = useCallback((progress: AccountTransferImportProgress | null) => {
    if (!progress || progress.total_platforms <= 0) {
      return 0;
    }
    return Math.round((progress.completed_platforms / progress.total_platforms) * 100);
  }, []);

  const getDetailStatusText = useCallback(
    (detail: AccountTransferImportProgressDetail) => {
      if (detail.status === 'running') return t('common.shared.import.progress.statusRunning');
      if (detail.status === 'success') return t('common.success');
      if (detail.status === 'failed') return t('common.failed');
      if (detail.status === 'pending') return t('common.shared.import.progress.statusPending');
      if (detail.status === 'skipped') return t('common.shared.import.progress.statusSkipped');
      return '-';
    },
    [t],
  );

  const formatDetailLine = useCallback(
    (detail: AccountTransferImportProgressDetail) => {
      const platformLabel = getPlatformLabel(detail.platform, t);
      if (detail.status === 'running') {
        return `⏳ ${platformLabel} ${t('common.shared.import.progress.statusRunning')}`;
      }
      if (detail.status === 'failed') {
        const suffix = detail.error ? `（${detail.error}）` : '';
        return `❌ ${platformLabel} ${detail.imported_count}/${detail.expected_count}${suffix}`;
      }
      if (detail.status === 'success') {
        return `✅ ${platformLabel} ${detail.imported_count}/${detail.expected_count}`;
      }
      if (detail.status === 'pending') {
        return `🕒 ${platformLabel} ${t('common.shared.import.progress.statusPending')}`;
      }
      return `➖ ${platformLabel} ${t('common.shared.import.progress.statusSkipped')}`;
    },
    [t],
  );

  const handleImportContent = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) {
        setFeedback({
          tone: 'error',
          text: t('common.shared.token.empty'),
        });
        return;
      }

      setImporting(true);
      setImportProgress(null);
      setFeedback({
        tone: 'loading',
        text: t('common.shared.import.importing'),
      });

      try {
        const result = await importAllAccountsFromTransferJson(trimmed, {
          onProgress: (progress) => {
            setImportProgress(progress);
          },
        });

        if (result.imported_count <= 0 && result.platform_failed_count > 0) {
          const firstError = result.details.find((item) => item.error)?.error ?? t('common.failed');
          setFeedback({
            tone: 'error',
            text: t('common.shared.import.failedMsg', {
              error: firstError,
            }),
          });
          return;
        }

        if (result.imported_count <= 0) {
          setFeedback({
            tone: 'error',
            text: t('modals.import.noAccountsFound'),
          });
          return;
        }

        if (result.platform_failed_count > 0) {
          const firstError = result.details.find((item) => item.error)?.error ?? t('common.failed');
          setFeedback({
            tone: 'error',
            text: t('common.shared.import.failedMsg', {
              error: firstError,
            }),
          });
        } else {
          setFeedback(null);
        }

        setJsonInput('');
      } catch (error) {
        setImportFailed(error);
      } finally {
        setImporting(false);
      }
    },
    [setImportFailed, t],
  );

  const handlePickImportFile = useCallback(() => {
    importFileInputRef.current?.click();
  }, []);

  const handleImportFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const content = await file.text();
      await handleImportContent(content);
    },
    [handleImportContent],
  );

  const feedbackNode = feedback ? (
    <div className={`add-feedback ${feedback.tone}`}>{feedback.text}</div>
  ) : null;
  const progressPercent = calcProgressPercent(importProgress);
  const currentPlatformDetail =
    importProgress && importProgress.current_platform
      ? importProgress.details.find((item) => item.platform === importProgress.current_platform) ?? null
      : null;
  const visibleProgressDetails = importProgress
    ? importProgress.details.filter(
      (detail) =>
        detail.expected_count > 0 ||
          detail.imported_count > 0 ||
          detail.status === 'running' ||
          detail.status === 'failed',
    )
    : [];
  const currentImportPlatform = importProgress?.current_platform ?? null;

  useEffect(() => {
    if (!importProgress) return;
    const modalBody = modalBodyRef.current;
    if (!modalBody) return;
    modalBody.scrollTop = modalBody.scrollHeight;
  }, [importProgress]);

  useEffect(() => {
    if (!importProgress) return;
    if (!currentImportPlatform) return;
    const list = progressListRef.current;
    if (!list) return;
    const target = list.querySelector<HTMLElement>(`[data-platform="${currentImportPlatform}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'nearest' });
  }, [currentImportPlatform, importProgress]);

  return (
    <>
      <div className="group-title">{t('settings.general.accountManagement')}</div>
      <div className="settings-group">
        <div className="settings-row">
          <div className="row-label">
            <div className="row-title">{t('common.shared.export.title')}</div>
            <div className="row-desc">
              {t('manual.dataPrivacy.outcomes.1')}
            </div>
          </div>
          <div className="row-control">
            <button className="btn btn-secondary" onClick={() => void handleExport()} disabled={exportModal.preparing}>
              {exportModal.preparing ? <RefreshCw size={16} className="loading-spinner" /> : <Download size={16} />}
              {t('common.shared.export.title')}
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div className="row-label">
            <div className="row-title">{t('modals.import.title')}</div>
            <div className="row-desc">
              {t('manual.dataPrivacy.outcomes.0')}
            </div>
          </div>
          <div className="row-control">
            <button
              className="btn btn-secondary"
              onClick={() => {
                setFeedback(null);
                setShowImportModal(true);
              }}
              disabled={importing}
            >
              {importing ? <RefreshCw size={16} className="loading-spinner" /> : <FolderOpen size={16} />}
              {t('common.shared.import.label')}
            </button>
          </div>
        </div>

        {!showImportModal && feedbackNode && (
          <div className="settings-transfer-feedback-wrap">{feedbackNode}</div>
        )}
      </div>

      {showImportModal &&
        renderToBody(
          <div className="modal-overlay" onClick={closeImportModal}>
            <div className="modal settings-transfer-modal" onClick={(event) => event.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('modals.import.title')}</h2>
                <button className="modal-close" onClick={closeImportModal} aria-label={t('common.close')}>
                  <X />
                </button>
              </div>

              <div ref={modalBodyRef} className="modal-body settings-transfer-modal-body">
                <p className="settings-transfer-modal-desc">
                  {t('modals.import.desc')}
                </p>

                <div className="settings-transfer-import-block">
                  <div className="settings-transfer-import-title">
                    {t('modals.import.fromFiles')}
                  </div>
                  <div className="settings-transfer-import-desc">
                    {t('modals.import.fromFilesDesc')}
                  </div>
                  <button className="btn btn-secondary" onClick={handlePickImportFile} disabled={importing}>
                    {importing ? <RefreshCw size={16} className="loading-spinner" /> : <FolderOpen size={16} />}
                    {t('common.shared.import.pickFile')}
                  </button>
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      void handleImportFileChange(event);
                    }}
                  />
                </div>

                <div className="settings-transfer-json-title">
                  {t('modals.import.orJson')}
                </div>
                <textarea
                  className="export-json-textarea settings-transfer-json-input"
                  spellCheck={false}
                  value={jsonInput}
                  onChange={(event) => setJsonInput(event.target.value)}
                  placeholder={t('modals.import.jsonPlaceholder')}
                />

              <div className="settings-transfer-modal-actions">
                <button className="btn btn-secondary" onClick={closeImportModal} disabled={importing}>
                  {t('common.cancel')}
                </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      void handleImportContent(jsonInput);
                    }}
                    disabled={importing || !jsonInput.trim()}
                  >
                    {importing ? <RefreshCw size={16} className="loading-spinner" /> : <Download size={16} />}
                    {t('modals.import.importBtn')}
                </button>
              </div>

              {importProgress && (
                <div className="settings-transfer-progress-wrap">
                  <div className="settings-transfer-progress-bar">
                    <div
                      className="settings-transfer-progress-fill"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="settings-transfer-progress-main">
                    {t('common.shared.import.progress.overallLine', {
                      percent: progressPercent,
                      completedPlatforms: importProgress.completed_platforms,
                      totalPlatforms: importProgress.total_platforms,
                      processedAccounts: importProgress.processed_accounts,
                      totalAccounts: importProgress.total_accounts,
                    })}
                  </div>

                  {importProgress.current_platform && currentPlatformDetail && (
                    <div className="settings-transfer-current-platform">
                      <div className="settings-transfer-current-line">
                        {t('common.shared.import.progress.currentPlatformLine', {
                          platform: getPlatformLabel(importProgress.current_platform, t),
                          count: currentPlatformDetail.expected_count,
                        })}
                      </div>
                      <div className="settings-transfer-current-line">
                        {t('common.shared.import.progress.currentStatusLine', {
                          status:
                            currentPlatformDetail.status === 'running'
                              ? t('common.shared.import.progress.statusProcessing')
                              : getDetailStatusText(currentPlatformDetail),
                        })}
                      </div>
                    </div>
                  )}

                  <div className="settings-transfer-progress-title">
                    {t('common.shared.import.progress.platformDetailsTitle')}
                  </div>
                  <div ref={progressListRef} className="settings-transfer-progress-list">
                    {visibleProgressDetails.map((detail) => (
                      <div
                        key={detail.platform}
                        data-platform={detail.platform}
                        className={`settings-transfer-progress-item settings-transfer-progress-item--${detail.status}`}
                      >
                        <div className="settings-transfer-progress-item-line">
                          {formatDetailLine(detail)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {feedbackNode}
            </div>
          </div>
        </div>,
        )}

      {exportModal.showModal &&
        renderToBody(
          <ExportJsonModal
            isOpen={exportModal.showModal}
            title={`${t('common.shared.export.title')} JSON`}
            jsonContent={exportModal.jsonContent}
            hidden={exportModal.hidden}
            copied={exportModal.copied}
            saving={exportModal.saving}
            savedPath={exportModal.savedPath}
            canOpenSavedDirectory={exportModal.canOpenSavedDirectory}
            pathCopied={exportModal.pathCopied}
            onClose={exportModal.closeModal}
            onToggleHidden={exportModal.toggleHidden}
            onCopyJson={exportModal.copyJson}
            onSaveJson={exportModal.saveJson}
            onOpenSavedDirectory={exportModal.openSavedDirectory}
            onCopySavedPath={exportModal.copySavedPath}
          />,
        )}
    </>
  );
}
