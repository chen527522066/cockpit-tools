import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InstancesManager } from '../components/InstancesManager';
import { OverviewTabsHeader } from '../components/OverviewTabsHeader';
import { useAccountStore } from '../stores/useAccountStore';
import { useInstanceStore } from '../stores/useInstanceStore';
import type { Account } from '../types/account';
import { Page } from '../types/navigation';
import { DisplayGroup, getDisplayGroups } from '../services/groupService';
import {
  buildAntigravityAccountPresentation,
  buildQuotaPreviewLines,
} from '../presentation/platformAccountPresentation';

interface InstancesPageProps {
  onNavigate?: (page: Page) => void;
}

export function InstancesPage({ onNavigate }: InstancesPageProps) {
  const { t } = useTranslation();
  const instanceStore = useInstanceStore();
  const { accounts, fetchAccounts } = useAccountStore();
  const [displayGroups, setDisplayGroups] = useState<DisplayGroup[]>([]);

  useEffect(() => {
    getDisplayGroups()
      .then((groups) => {
        setDisplayGroups(groups);
      })
      .catch((error) => {
        console.error('Failed to load display groups:', error);
      });
  }, []);

  const renderAccountQuotaPreview = (account: Account) => {
    const presentation = buildAntigravityAccountPresentation(account, displayGroups, t);
    const lines = buildQuotaPreviewLines(presentation.quotaItems, 3);
    if (lines.length === 0) {
      return <span className="account-quota-empty">{t('instances.quota.empty', '暂无配额缓存')}</span>;
    }
    return (
      <div className="account-quota-preview">
        {lines.map((line) => (
          <span className="account-quota-item" key={`${account.id}-${line.key}`}>
            <span className={`quota-dot ${line.quotaClass}`} />
            <span className={`quota-text ${line.quotaClass}`}>
              {line.text}
            </span>
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="instances-page">
      <OverviewTabsHeader
        active="instances"
        onNavigate={onNavigate}
        subtitle={t('instances.subtitle', '多实例独立配置，多账号并行运行。')}
      />
      <InstancesManager
        instanceStore={instanceStore}
        accounts={accounts}
        fetchAccounts={fetchAccounts}
        renderAccountQuotaPreview={renderAccountQuotaPreview}
        renderAccountBadge={(account) => {
          const presentation = buildAntigravityAccountPresentation(account, displayGroups, t);
          return (
            <span className={`instance-plan-badge ${presentation.planClass}`}>{presentation.planLabel}</span>
          );
        }}
        getAccountSearchText={(account) => {
          const presentation = buildAntigravityAccountPresentation(account, displayGroups, t);
          return `${presentation.displayName} ${presentation.planLabel} ${account.name ?? ''}`;
        }}
        appType="antigravity"
      />
    </div>
  );
}
