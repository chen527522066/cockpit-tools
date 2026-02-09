import { useTranslation } from 'react-i18next';
import { InstancesManager } from '../components/InstancesManager';
import { OverviewTabsHeader } from '../components/OverviewTabsHeader';
import { useAccountStore } from '../stores/useAccountStore';
import { useInstanceStore } from '../stores/useInstanceStore';
import { getDisplayModels, getModelShortName, getQuotaClass } from '../utils/account';
import type { Account } from '../types/account';
import { Page } from '../types/navigation';

interface InstancesPageProps {
  onNavigate?: (page: Page) => void;
}

export function InstancesPage({ onNavigate }: InstancesPageProps) {
  const { t } = useTranslation();
  const instanceStore = useInstanceStore();
  const { accounts, fetchAccounts } = useAccountStore();

  const renderAccountQuotaPreview = (account: Account) => {
    if (!account.quota || !account.quota.models?.length) {
      return <span className="account-quota-empty">{t('instances.quota.empty', '暂无配额缓存')}</span>;
    }
    const models = getDisplayModels(account.quota);
    const visible = (models.length ? models : account.quota.models).slice(0, 3);
    return (
      <div className="account-quota-preview">
        {visible.map((model) => (
          <span className="account-quota-item" key={`${account.id}-${model.name}`}>
            <span className={`quota-dot ${getQuotaClass(model.percentage)}`} />
            <span className={`quota-text ${getQuotaClass(model.percentage)}`}>
              {getModelShortName(model.name)} {model.percentage}%
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
        getAccountSearchText={(account) => `${account.email} ${account.name ?? ''}`}
        appType="antigravity"
      />
    </div>
  );
}
