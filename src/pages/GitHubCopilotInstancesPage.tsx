import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { InstancesManager } from '../components/InstancesManager';
import { useGitHubCopilotInstanceStore } from '../stores/useGitHubCopilotInstanceStore';
import { useGitHubCopilotAccountStore } from '../stores/useGitHubCopilotAccountStore';
import type { GitHubCopilotAccount } from '../types/githubCopilot';
import { getGitHubCopilotAccountDisplayEmail, getGitHubCopilotQuotaClass, getGitHubCopilotUsage } from '../types/githubCopilot';

/**
 * GitHub Copilot 多开实例内容组件（不包含 header）
 * 用于嵌入到 GitHubCopilotAccountsPage 中
 */
export function GitHubCopilotInstancesContent() {
  const { t } = useTranslation();
  const instanceStore = useGitHubCopilotInstanceStore();
  const { accounts, fetchAccounts } = useGitHubCopilotAccountStore();
  type AccountForSelect = GitHubCopilotAccount & { email: string };
  const accountsForSelect = useMemo(
    () =>
      accounts.map((acc) => ({
        ...acc,
        email: acc.email || getGitHubCopilotAccountDisplayEmail(acc),
      })) as AccountForSelect[],
    [accounts],
  );
  const isSupportedPlatform = useMemo(() => {
    if (typeof navigator === 'undefined') return false;
    const platform = navigator.platform || '';
    const ua = navigator.userAgent || '';
    const isMac = /mac/i.test(platform) || /mac/i.test(ua);
    const isWindows = /win/i.test(platform) || /windows/i.test(ua);
    const isLinux = /linux/i.test(platform) || /linux/i.test(ua);
    return isMac || isWindows || isLinux;
  }, []);

  const resolveQuotaClass = (percentage: number) => getGitHubCopilotQuotaClass(percentage);

  const renderGitHubCopilotQuotaPreview = (account: AccountForSelect) => {
    const usage = getGitHubCopilotUsage(account);
    const inlinePct = usage.inlineSuggestionsUsedPercent;
    const chatPct = usage.chatMessagesUsedPercent;
    if (inlinePct == null && chatPct == null) {
      return <span className="account-quota-empty">{t('instances.quota.empty', '暂无配额缓存')}</span>;
    }
    return (
      <div className="account-quota-preview">
        <span className="account-quota-item">
          <span className={`quota-dot ${resolveQuotaClass(inlinePct ?? 0)}`} />
          <span className={`quota-text ${resolveQuotaClass(inlinePct ?? 0)}`}>
            {t('githubCopilot.instances.quota.inline', 'Inline Suggestions')} {inlinePct ?? '-'}%
          </span>
        </span>
        <span className="account-quota-item">
          <span className={`quota-dot ${resolveQuotaClass(chatPct ?? 0)}`} />
          <span className={`quota-text ${resolveQuotaClass(chatPct ?? 0)}`}>
            {t('githubCopilot.instances.quota.chat', 'Chat messages')} {chatPct ?? '-'}%
          </span>
        </span>
      </div>
    );
  };

  if (!isSupportedPlatform) {
    return (
      <div className="instances-page">
        <div className="empty-state">
          <h3>{t('githubCopilot.instances.unsupported.title', '暂不支持当前系统')}</h3>
          <p>{t('githubCopilot.instances.unsupported.descPlatform', 'GitHub Copilot 多开实例仅支持 macOS、Windows 和 Linux。')}</p>
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
      <InstancesManager<AccountForSelect>
        instanceStore={instanceStore}
        accounts={accountsForSelect}
        fetchAccounts={fetchAccounts}
        renderAccountQuotaPreview={renderGitHubCopilotQuotaPreview}
        getAccountSearchText={(account) => account.email}
        appType="vscode"
      />
    </div>
  );
}
