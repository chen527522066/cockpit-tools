import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { InstancesManager } from '../components/InstancesManager';
import { useCodexInstanceStore } from '../stores/useCodexInstanceStore';
import { useCodexAccountStore } from '../stores/useCodexAccountStore';
import type { CodexAccount } from '../types/codex';
import { getCodexQuotaClass } from '../types/codex';

/**
 * Codex 多开实例内容组件（不包含 header）
 * 用于嵌入到 CodexAccountsPage 中
 */
export function CodexInstancesContent() {
  const { t } = useTranslation();
  const instanceStore = useCodexInstanceStore();
  const { accounts, fetchAccounts } = useCodexAccountStore();
  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const platform = navigator.platform || '';
    const ua = navigator.userAgent || '';
    return /mac/i.test(platform) || /mac/i.test(ua);
  }, []);

  const resolveQuotaClass = (percentage: number) => {
    const mapped = getCodexQuotaClass(percentage);
    return mapped === 'critical' ? 'low' : mapped;
  };

  const renderCodexQuotaPreview = (account: CodexAccount) => {
    if (!account.quota) {
      return <span className="account-quota-empty">{t('instances.quota.empty', '暂无配额缓存')}</span>;
    }
    const hourly = account.quota.hourly_percentage;
    const weekly = account.quota.weekly_percentage;
    return (
      <div className="account-quota-preview">
        <span className="account-quota-item">
          <span className={`quota-dot ${resolveQuotaClass(hourly)}`} />
          <span className={`quota-text ${resolveQuotaClass(hourly)}`}>
            {t('codex.instances.quota.hourly', '5h')} {hourly}%
          </span>
        </span>
        <span className="account-quota-item">
          <span className={`quota-dot ${resolveQuotaClass(weekly)}`} />
          <span className={`quota-text ${resolveQuotaClass(weekly)}`}>
            {t('codex.instances.quota.weekly', '周')} {weekly}%
          </span>
        </span>
      </div>
    );
  };

  if (!isMac) {
    return (
      <div className="instances-page">
        <div className="empty-state">
          <h3>{t('codex.instances.unsupported.title', '暂不支持当前系统')}</h3>
          <p>{t('codex.instances.unsupported.desc', 'Codex 多开实例仅支持 macOS。')}</p>
          <button className="btn btn-primary" disabled>
            <Plus size={16} />
            {t('instances.actions.create', '新建实例')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="instances-page">
      <InstancesManager
        instanceStore={instanceStore}
        accounts={accounts}
        fetchAccounts={fetchAccounts}
        renderAccountQuotaPreview={renderCodexQuotaPreview}
        getAccountSearchText={(account) => account.email}
        appType="codex"
      />
    </div>
  );
}
