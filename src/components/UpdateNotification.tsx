import { useEffect, useState, useMemo, useCallback } from 'react';
import { X, Download, Sparkles, RefreshCw, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { openUrl } from '@tauri-apps/plugin-opener';
import './UpdateNotification.css';

interface UpdateInfo {
  has_update: boolean;
  latest_version: string;
  current_version: string;
  download_url: string;
  release_notes: string;
  release_notes_zh: string;
}

type UpdateCheckSource = 'auto' | 'manual';
type UpdateCheckStatus = 'has_update' | 'up_to_date' | 'failed';

export interface UpdateCheckResult {
  source: UpdateCheckSource;
  status: UpdateCheckStatus;
  currentVersion?: string;
  latestVersion?: string;
  error?: string;
}

interface UpdateNotificationProps {
  onClose: () => void;
  source?: UpdateCheckSource;
  onResult?: (result: UpdateCheckResult) => void;
}

type DownloadState = 'idle' | 'downloading' | 'downloaded' | 'installing' | 'error';

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
  onClose,
  source = 'auto',
  onResult,
}) => {
  const { t, i18n } = useTranslation();
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState('');

  useEffect(() => {
    checkForUpdates();
  }, []);

  const checkForUpdates = async () => {
    try {
      const info = await invoke<UpdateInfo>('check_for_updates');
      if (info.has_update) {
        onResult?.({
          source,
          status: 'has_update',
          currentVersion: info.current_version,
          latestVersion: info.latest_version,
        });
        setUpdateInfo(info);
      } else {
        onResult?.({
          source,
          status: 'up_to_date',
          currentVersion: info.current_version,
          latestVersion: info.latest_version,
        });
        onClose();
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
      onResult?.({
        source,
        status: 'failed',
        error: String(error),
      });
      onClose();
    }
  };

  const handleInAppUpdate = useCallback(async () => {
    if (downloadState === 'downloading' || downloadState === 'installing') return;
    
    setDownloadState('downloading');
    setDownloadProgress(0);
    setDownloadError('');

    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      
      if (!update) {
        setDownloadState('error');
        setDownloadError('No update available from updater plugin');
        return;
      }

      let downloaded = 0;
      let contentLength = 0;

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? 0;
            setDownloadState('downloading');
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (contentLength > 0) {
              setDownloadProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
            }
            break;
          case 'Finished':
            setDownloadState('downloaded');
            setDownloadProgress(100);
            break;
        }
      });

      setDownloadState('downloaded');
      
      // Auto relaunch after a short delay
      const { relaunch } = await import('@tauri-apps/plugin-process');
      setTimeout(() => {
        relaunch();
      }, 1500);
    } catch (error) {
      console.error('In-app update failed:', error);
      setDownloadState('error');
      setDownloadError(String(error));
    }
  }, [downloadState]);

  const handleFallbackDownload = async () => {
    if (updateInfo?.download_url) {
      try {
        await openUrl(updateInfo.download_url);
      } catch {
        window.open(updateInfo.download_url, '_blank');
      }
      handleClose();
    }
  };

  const handleClose = () => {
    if (downloadState === 'downloading' || downloadState === 'installing') return;
    onClose();
  };

  // 根据语言选择显示中文还是英文更新日志
  const releaseNotes = useMemo(() => {
    if (!updateInfo) return '';
    const isZh = i18n.language.startsWith('zh');
    return isZh && updateInfo.release_notes_zh 
      ? updateInfo.release_notes_zh 
      : updateInfo.release_notes;
  }, [updateInfo, i18n.language]);

  // 简单的 Markdown 渲染
  const formattedNotes = useMemo(() => {
    if (!releaseNotes) return null;
    
    const lines = releaseNotes.split('\n');
    const elements: React.ReactNode[] = [];
    let key = 0;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      if (trimmed.startsWith('### ')) {
        elements.push(
          <h4 key={key++} className="release-notes-heading">
            {trimmed.slice(4)}
          </h4>
        );
      } else if (trimmed.startsWith('## ')) {
        continue;
      } else if (trimmed.startsWith('- ')) {
        const content = trimmed.slice(2);
        const parts = content.split(/\*\*(.*?)\*\*/g);
        elements.push(
          <li key={key++} className="release-notes-item">
            {parts.map((part, i) => 
              i % 2 === 1 ? <strong key={i}>{part}</strong> : part
            )}
          </li>
        );
      }
    }
    
    return elements.length > 0 ? (
      <ul className="release-notes-list">{elements}</ul>
    ) : null;
  }, [releaseNotes]);

  if (!updateInfo) {
    return null;
  }

  const isDownloading = downloadState === 'downloading';
  const isDownloaded = downloadState === 'downloaded';
  const isError = downloadState === 'error';

  return (
    <div className="modal-overlay update-overlay" onClick={handleClose}>
      <div className="modal update-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2 className="update-modal-title">
            <span className="update-icon">
              <Sparkles size={18} />
            </span>
            {t('update_notification.title')}
          </h2>
          <button 
            className="modal-close" 
            onClick={handleClose} 
            aria-label={t('common.cancel')}
            disabled={isDownloading}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body update-modal-body">
          <div className="update-version">v{updateInfo.latest_version}</div>
          <p className="update-message">
            {t('update_notification.message', { current: updateInfo.current_version })}
          </p>
          
          {/* Download Progress */}
          {isDownloading && (
            <div className="update-progress-container">
              <div className="update-progress-bar">
                <div 
                  className="update-progress-fill" 
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
              <span className="update-progress-text">
                {t('update_notification.downloading', 'Downloading...')} {downloadProgress}%
              </span>
            </div>
          )}

          {/* Download Complete */}
          {isDownloaded && (
            <div className="update-status update-status-success">
              <Check size={16} />
              <span>{t('update_notification.installSuccess', 'Update installed! Restarting...')}</span>
            </div>
          )}

          {/* Error with fallback */}
          {isError && (
            <div className="update-status update-status-error">
              <span>{t('update_notification.autoUpdateFailed', 'Auto-update failed. You can download manually.')}</span>
              {downloadError && (
                <span className="update-error-detail">{downloadError}</span>
              )}
            </div>
          )}

          {formattedNotes && (
            <div className="release-notes">
              <h3 className="release-notes-title">{t('update_notification.whatsNew', "What's New")}</h3>
              <div className="release-notes-content">
                {formattedNotes}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button 
            className="btn btn-secondary" 
            onClick={handleClose}
            disabled={isDownloading}
          >
            {t('common.cancel')}
          </button>
          {isError ? (
            <button className="btn btn-primary" onClick={handleFallbackDownload}>
              <Download size={16} />
              {t('update_notification.action')}
            </button>
          ) : isDownloaded ? (
            <button className="btn btn-primary" disabled>
              <RefreshCw size={16} className="spin" />
              {t('update_notification.restarting', 'Restarting...')}
            </button>
          ) : (
            <button 
              className="btn btn-primary" 
              onClick={handleInAppUpdate}
              disabled={isDownloading}
            >
              {isDownloading ? (
                <>
                  <RefreshCw size={16} className="spin" />
                  {t('update_notification.downloading', 'Downloading...')}
                </>
              ) : (
                <>
                  <Download size={16} />
                  {t('update_notification.updateNow', 'Update Now')}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
