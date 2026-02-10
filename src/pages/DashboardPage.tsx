import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountStore } from '../stores/useAccountStore';
import { useCodexAccountStore } from '../stores/useCodexAccountStore';
import { useGitHubCopilotAccountStore } from '../stores/useGitHubCopilotAccountStore';
import { Page } from '../types/navigation';
import { Users, CheckCircle2, Sparkles, RotateCw, Play, Github } from 'lucide-react';
import { getSubscriptionTier, getDisplayModels, getModelShortName, formatResetTimeDisplay } from '../utils/account';
import { getCodexPlanDisplayName, getCodexQuotaClass, formatCodexResetTime } from '../types/codex';
import { Account } from '../types/account';
import { CodexAccount } from '../types/codex';
import {
  GitHubCopilotAccount,
  getGitHubCopilotPlanDisplayName,
  getGitHubCopilotQuotaClass,
  formatGitHubCopilotResetTime,
} from '../types/githubCopilot';
import './DashboardPage.css';
import { RobotIcon } from '../components/icons/RobotIcon';
import { CodexIcon } from '../components/icons/CodexIcon';

interface DashboardPageProps {
  onNavigate: (page: Page) => void;
}

const GHCP_CURRENT_ACCOUNT_ID_KEY = 'agtools.github_copilot.current_account_id';

export function DashboardPage({ onNavigate }: DashboardPageProps) {
  const { t } = useTranslation();

  
  // Antigravity Data
  const { 
    accounts: agAccounts, 
    currentAccount: agCurrent,
    switchAccount: switchAgAccount,
    fetchAccounts: fetchAgAccounts,
    fetchCurrentAccount: fetchAgCurrent
  } = useAccountStore();

  // Codex Data
  const { 
    accounts: codexAccounts, 
    currentAccount: codexCurrent,
    switchAccount: switchCodexAccount,
    fetchAccounts: fetchCodexAccounts,
    fetchCurrentAccount: fetchCodexCurrent
  } = useCodexAccountStore();

  // GitHub Copilot Data
  const {
    accounts: githubCopilotAccounts,
    fetchAccounts: fetchGitHubCopilotAccounts,
    switchAccount: switchGitHubCopilotAccount,
  } = useGitHubCopilotAccountStore();

  const agCurrentId = agCurrent?.id;
  const codexCurrentId = codexCurrent?.id;

  const agCurrentAccount = useMemo(() => {
    if (!agCurrentId) return null;
    return agAccounts.find((account) => account.id === agCurrentId) ?? agCurrent ?? null;
  }, [agAccounts, agCurrent, agCurrentId]);

  const codexCurrentAccount = useMemo(() => {
    if (!codexCurrentId) return null;
    return codexAccounts.find((account) => account.id === codexCurrentId) ?? codexCurrent ?? null;
  }, [codexAccounts, codexCurrent, codexCurrentId]);

  React.useEffect(() => {
    fetchAgAccounts();
    fetchAgCurrent();
    fetchCodexAccounts();
    fetchCodexCurrent();
    fetchGitHubCopilotAccounts();
  }, []);

  // Statistics
  const stats = useMemo(() => {
    return {
      total: agAccounts.length + codexAccounts.length + githubCopilotAccounts.length,
      antigravity: agAccounts.length,
      codex: codexAccounts.length,
      githubCopilot: githubCopilotAccounts.length,
    };
  }, [agAccounts, codexAccounts, githubCopilotAccounts]);

  // Refresh States
  const [refreshing, setRefreshing] = React.useState<Set<string>>(new Set());
  const [switching, setSwitching] = React.useState<Set<string>>(new Set());
  const [githubCopilotCurrentId, setGitHubCopilotCurrentId] = React.useState<string | null>(() => {
    try {
      return localStorage.getItem(GHCP_CURRENT_ACCOUNT_ID_KEY);
    } catch {
      return null;
    }
  });
  const [cardRefreshing, setCardRefreshing] = React.useState<{ag: boolean, codex: boolean, githubCopilot: boolean}>({
    ag: false,
    codex: false,
    githubCopilot: false,
  });

  // Refresh Handlers
  const handleRefreshAg = async (accountId: string) => {
    if (refreshing.has(accountId)) return;
    setRefreshing(prev => new Set(prev).add(accountId));
    try {
      await useAccountStore.getState().refreshQuota(accountId);
    } catch (error) {
      console.error('Refresh failed:', error);
    } finally {
      setRefreshing(prev => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  const handleRefreshCodex = async (accountId: string) => {
    if (refreshing.has(accountId)) return;
    setRefreshing(prev => new Set(prev).add(accountId));
    try {
      await useCodexAccountStore.getState().refreshQuota(accountId);
    } catch (error) {
      console.error('Refresh failed:', error);
    } finally {
      setRefreshing(prev => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  const handleRefreshGitHubCopilot = async (accountId: string) => {
    if (refreshing.has(accountId)) return;
    setRefreshing(prev => new Set(prev).add(accountId));
    try {
      await useGitHubCopilotAccountStore.getState().refreshToken(accountId);
    } catch (error) {
      console.error('Refresh failed:', error);
    } finally {
      setRefreshing(prev => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  const handleRefreshAgCard = async () => {
    if (cardRefreshing.ag) return;
    setCardRefreshing(prev => ({ ...prev, ag: true }));
    const idsToRefresh = [agCurrentId, agRecommended?.id].filter(Boolean) as string[];
    try {
      for (const id of idsToRefresh) {
        await useAccountStore.getState().refreshQuota(id);
      }
    } catch (error) {
      console.error('Card refresh failed:', error);
    } finally {
      setCardRefreshing(prev => ({ ...prev, ag: false }));
    }
  };

  const handleRefreshCodexCard = async () => {
    if (cardRefreshing.codex) return;
    setCardRefreshing(prev => ({ ...prev, codex: true }));
    const idsToRefresh = [codexCurrentId, codexRecommended?.id].filter(Boolean) as string[];
    try {
      for (const id of idsToRefresh) {
        await useCodexAccountStore.getState().refreshQuota(id);
      }
    } catch (error) {
      console.error('Card refresh failed:', error);
    } finally {
      setCardRefreshing(prev => ({ ...prev, codex: false }));
    }
  };

  const handleRefreshGitHubCopilotCard = async () => {
    if (cardRefreshing.githubCopilot) return;
    setCardRefreshing(prev => ({ ...prev, githubCopilot: true }));
    const idsToRefresh = [githubCopilotCurrent?.id, githubCopilotRecommended?.id].filter(Boolean) as string[];
    try {
      for (const id of idsToRefresh) {
        await useGitHubCopilotAccountStore.getState().refreshToken(id);
      }
    } catch (error) {
      console.error('Card refresh failed:', error);
    } finally {
      setCardRefreshing(prev => ({ ...prev, githubCopilot: false }));
    }
  };

  const handleSwitchGitHubCopilot = async (accountId: string) => {
    if (switching.has(accountId)) return;
    setSwitching((prev) => new Set(prev).add(accountId));
    try {
      await switchGitHubCopilotAccount(accountId);
      setGitHubCopilotCurrentId(accountId);
      localStorage.setItem(GHCP_CURRENT_ACCOUNT_ID_KEY, accountId);
    } catch (error) {
      console.error('Switch failed:', error);
    } finally {
      setSwitching((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  };

  // Antigravity Recommendation Logic
  const agRecommended = useMemo(() => {
    if (agAccounts.length <= 1) return null;
    
    // Simple logic: find account with highest overall quota that isn't current
    const others = agAccounts.filter((a) => {
      if (a.id === agCurrentId) return false;
      if (a.disabled) return false;
      if (a.quota?.is_forbidden) return false;
      if (!a.quota?.models || a.quota.models.length === 0) return false;
      return true;
    });
    if (others.length === 0) return null;

    return others.reduce((prev, curr) => {
      // Calculate a score based on quotas
      const getScore = (acc: Account) => {
        if (!acc.quota?.models) return -1;
        // Average percentage of all models
        const total = acc.quota.models.reduce((sum, m) => sum + m.percentage, 0);
        return total / acc.quota.models.length;
      };
      
      return getScore(curr) > getScore(prev) ? curr : prev;
    });
  }, [agAccounts, agCurrentId]);

  // Codex Recommendation Logic
  const codexRecommended = useMemo(() => {
    if (codexAccounts.length <= 1) return null;

    const others = codexAccounts.filter((a) => {
      if (a.id === codexCurrentId) return false;
      if (!a.quota) return false;
      return true;
    });
    if (others.length === 0) return null;

    return others.reduce((prev, curr) => {
      const getScore = (acc: CodexAccount) => {
        if (!acc.quota) return -1;
        return (acc.quota.hourly_percentage + acc.quota.weekly_percentage) / 2;
      };
      return getScore(curr) > getScore(prev) ? curr : prev;
    });
  }, [codexAccounts, codexCurrentId]);

  const githubCopilotCurrent = useMemo(() => {
    if (githubCopilotAccounts.length === 0) return null;
    if (githubCopilotCurrentId) {
      const current = githubCopilotAccounts.find((account) => account.id === githubCopilotCurrentId);
      if (current) return current;
    }
    return githubCopilotAccounts.reduce((prev, curr) => {
      const prevScore = prev.last_used || prev.created_at || 0;
      const currScore = curr.last_used || curr.created_at || 0;
      return currScore > prevScore ? curr : prev;
    });
  }, [githubCopilotAccounts, githubCopilotCurrentId]);

  React.useEffect(() => {
    if (!githubCopilotCurrentId) return;
    const exists = githubCopilotAccounts.some((account) => account.id === githubCopilotCurrentId);
    if (exists) return;
    setGitHubCopilotCurrentId(null);
    localStorage.removeItem(GHCP_CURRENT_ACCOUNT_ID_KEY);
  }, [githubCopilotAccounts, githubCopilotCurrentId]);

  const githubCopilotRecommended = useMemo(() => {
    if (githubCopilotAccounts.length <= 1) return null;
    const currentId = githubCopilotCurrent?.id;
    const others = githubCopilotAccounts.filter((a) => a.id !== currentId);
    if (others.length === 0) return null;

    const getScore = (acc: GitHubCopilotAccount) => {
      const scores = [acc.quota?.hourly_percentage, acc.quota?.weekly_percentage].filter(
        (value): value is number => typeof value === 'number',
      );
      if (scores.length === 0) return 101;
      return scores.reduce((sum, value) => sum + value, 0) / scores.length;
    };

    return others.reduce((prev, curr) => (getScore(curr) < getScore(prev) ? curr : prev));
  }, [githubCopilotAccounts, githubCopilotCurrent?.id]);

  // Render Helpers
  const renderAgAccountContent = (account: Account | null) => {
    if (!account) return <div className="empty-slot">{t('dashboard.noAccount', '无账号')}</div>;

    const tier = getSubscriptionTier(account.quota);
    const tierLabel = t(`accounts.tier.${tier.toLowerCase()}`, tier);
    const displayModels = getDisplayModels(account.quota).slice(0, 4); // Show top 4 models

    return (
      <div className="account-mini-card">
        <div className="account-mini-header">
           <div className="account-info-row">
             <span className="account-email" title={account.email}>{account.email}</span>
             <span className={`tier-tag ${tier.toLowerCase()}`}>{tierLabel}</span>
           </div>
        </div>
        
        <div className="account-mini-quotas">
          {displayModels.map(model => (
            <div key={model.name} className="mini-quota-row-stacked">
              <div className="mini-quota-header">
                <span className="model-name">{getModelShortName(model.name)}</span>
                <span className={`model-pct ${getQuotaClass(model.percentage)}`}>{model.percentage}%</span>
              </div>
              <div className="mini-progress-track">
                <div 
                  className={`mini-progress-bar ${getQuotaClass(model.percentage)}`}
                  style={{ width: `${model.percentage}%` }}
                />
              </div>
              {model.reset_time && (
                <div className="mini-reset-time">
                  {formatResetTimeDisplay(model.reset_time, t)}
                </div>
              )}
            </div>
          ))}
          {displayModels.length === 0 && <span className="no-data-text">{t('dashboard.noData', '暂无数据')}</span>}
        </div>

        <div className="account-mini-actions icon-only-row">
           <button 
             className="mini-icon-btn" 
             onClick={() => handleRefreshAg(account.id)}
             title={t('common.refresh', '刷新')}
             disabled={refreshing.has(account.id)}
           >
             <RotateCw size={14} className={refreshing.has(account.id) ? 'loading-spinner' : ''} />
           </button>
           <button 
             className="mini-icon-btn"
             onClick={() => switchAgAccount(account.id)}
             title={t('dashboard.switch', '切换')}
           >
             <Play size={14} />
           </button>
        </div>
      </div>
    );
  };

  const renderCodexAccountContent = (account: CodexAccount | null) => {
    if (!account) return <div className="empty-slot">{t('dashboard.noAccount', '无账号')}</div>;

    const planName = getCodexPlanDisplayName(account.plan_type);
    const planLabel = t(`codex.plan.${planName.toLowerCase()}`, planName);
    
    return (
      <div className="account-mini-card">
        <div className="account-mini-header">
           <div className="account-info-row">
             <span className="account-email" title={account.email}>{account.email}</span>
             <span className={`tier-tag ${planName.toLowerCase()}`}>{planLabel}</span>
           </div>
        </div>
        
        <div className="account-mini-quotas">
          <div className="mini-quota-row-stacked">
            <div className="mini-quota-header">
              <span className="model-name">{t('codex.quota.hourly', '5H')}</span>
              <span className={`model-pct ${getCodexQuotaClass(account.quota?.hourly_percentage ?? 100)}`}>
                {account.quota?.hourly_percentage ?? 100}%
              </span>
            </div>
            <div className="mini-progress-track">
              <div 
                className={`mini-progress-bar ${getCodexQuotaClass(account.quota?.hourly_percentage ?? 100)}`}
                style={{ width: `${account.quota?.hourly_percentage ?? 100}%` }}
              />
            </div>
            {account.quota?.hourly_reset_time && (
              <div className="mini-reset-time">
                {formatCodexResetTime(account.quota.hourly_reset_time, t)}
              </div>
            )}
          </div>

          <div className="mini-quota-row-stacked">
            <div className="mini-quota-header">
              <span className="model-name">{t('codex.quota.weekly', 'Week')}</span>
              <span className={`model-pct ${getCodexQuotaClass(account.quota?.weekly_percentage ?? 100)}`}>
                {account.quota?.weekly_percentage ?? 100}%
              </span>
            </div>
            <div className="mini-progress-track">
              <div 
                className={`mini-progress-bar ${getCodexQuotaClass(account.quota?.weekly_percentage ?? 100)}`}
                style={{ width: `${account.quota?.weekly_percentage ?? 100}%` }}
              />
            </div>
            {account.quota?.weekly_reset_time && (
              <div className="mini-reset-time">
                {formatCodexResetTime(account.quota.weekly_reset_time, t)}
              </div>
            )}
          </div>
        </div>

        <div className="account-mini-actions icon-only-row">
           <button 
             className="mini-icon-btn" 
             onClick={() => handleRefreshCodex(account.id)}
             title={t('common.refresh', '刷新')}
             disabled={refreshing.has(account.id)}
           >
             <RotateCw size={14} className={refreshing.has(account.id) ? 'loading-spinner' : ''} />
           </button>
           <button 
             className="mini-icon-btn"
             onClick={() => switchCodexAccount(account.id)}
             title={t('dashboard.switch', '切换')}
           >
             <Play size={14} />
           </button>
        </div>
      </div>
    );
  };

  const renderGitHubCopilotAccountContent = (account: GitHubCopilotAccount | null) => {
    if (!account) return <div className="empty-slot">{t('dashboard.noAccount', '无账号')}</div>;

    const planName = getGitHubCopilotPlanDisplayName(account.plan_type);
    const planLabel = t(`githubCopilot.plan.${planName.toLowerCase()}`, planName);
    const hourly = account.quota?.hourly_percentage ?? null;
    const weekly = account.quota?.weekly_percentage ?? null;
    const hasQuota = hourly != null || weekly != null;
    const isRefreshing = refreshing.has(account.id);
    const isSwitching = switching.has(account.id);

    return (
      <div className="account-mini-card">
        <div className="account-mini-header">
          <div className="account-info-row">
            <span className="account-email" title={account.email ?? account.github_email ?? account.github_login}>
              {account.email ?? account.github_email ?? account.github_login}
            </span>
            <span className={`tier-tag ${planName.toLowerCase()}`}>{planLabel}</span>
          </div>
        </div>

        <div className="account-mini-quotas">
          {!hasQuota && <span className="no-data-text">{t('dashboard.noData', '暂无数据')}</span>}
          {hasQuota && (
            <>
              <div className="mini-quota-row-stacked">
                <div className="mini-quota-header">
                  <span className="model-name">{t('githubCopilot.quota.hourly', 'Inline Suggestions')}</span>
                  <span className={`model-pct ${getGitHubCopilotQuotaClass(hourly ?? 0)}`}>
                    {hourly ?? 0}%
                  </span>
                </div>
                <div className="mini-progress-track">
                  <div
                    className={`mini-progress-bar ${getGitHubCopilotQuotaClass(hourly ?? 0)}`}
                    style={{ width: `${hourly ?? 0}%` }}
                  />
                </div>
                {account.quota?.hourly_reset_time && (
                  <div className="mini-reset-time">
                    {formatGitHubCopilotResetTime(account.quota.hourly_reset_time, t)}
                  </div>
                )}
              </div>

              <div className="mini-quota-row-stacked">
                <div className="mini-quota-header">
                  <span className="model-name">{t('githubCopilot.quota.weekly', 'Chat messages')}</span>
                  <span className={`model-pct ${getGitHubCopilotQuotaClass(weekly ?? 0)}`}>
                    {weekly ?? 0}%
                  </span>
                </div>
                <div className="mini-progress-track">
                  <div
                    className={`mini-progress-bar ${getGitHubCopilotQuotaClass(weekly ?? 0)}`}
                    style={{ width: `${weekly ?? 0}%` }}
                  />
                </div>
                {account.quota?.weekly_reset_time && (
                  <div className="mini-reset-time">
                    {formatGitHubCopilotResetTime(account.quota.weekly_reset_time, t)}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="account-mini-actions icon-only-row">
          <button
            className="mini-icon-btn"
            onClick={() => handleRefreshGitHubCopilot(account.id)}
            title={t('common.refresh', '刷新')}
            disabled={isRefreshing || isSwitching}
          >
            <RotateCw size={14} className={isRefreshing ? 'loading-spinner' : ''} />
          </button>
          <button
            className="mini-icon-btn"
            onClick={() => handleSwitchGitHubCopilot(account.id)}
            title={t('dashboard.switch', '切换')}
            disabled={isSwitching}
          >
            {isSwitching ? <RotateCw size={14} className="loading-spinner" /> : <Play size={14} />}
          </button>
        </div>
      </div>
    );
  };

  // Helper for Quota Class (duplicated from Account utils roughly)
  function getQuotaClass(percentage: number): string {
    if (percentage > 80) return 'high';
    if (percentage > 20) return 'medium';
    return 'low';
  }

  return (
    <main className="main-content dashboard-page fade-in">
      <div className="page-tabs-row" style={{ minHeight: '60px' }}>
         <div className="page-tabs-label">{t('nav.dashboard', '仪表盘')}</div>
         <span className="date-display" style={{ position: 'absolute', right: 0 }}>{new Date().toLocaleDateString()}</span>
      </div>

      {/* Top Stats */}
      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-icon-bg primary"><Users size={24} /></div>
          <div className="stat-info">
            <span className="stat-label">{t('dashboard.totalAccounts', '账号总数')}</span>
            <span className="stat-value">{stats.total}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon-bg success">
            <RobotIcon className="" style={{ width: 24, height: 24 }} />
          </div>
          <div className="stat-info">
             <span className="stat-label">{t('dashboard.panels.antigravity', 'Antigravity')}</span>
             <span className="stat-value">{stats.antigravity}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon-bg info">
            <CodexIcon size={24} />
          </div>
          <div className="stat-info">
             <span className="stat-label">{t('dashboard.panels.codex', 'Codex')}</span>
             <span className="stat-value">{stats.codex}</span>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon-bg github">
            <Github size={24} />
          </div>
          <div className="stat-info">
             <span className="stat-label">{t('dashboard.panels.githubCopilot', 'GitHub Copilot')}</span>
             <span className="stat-value">{stats.githubCopilot}</span>
          </div>
        </div>
      </div>

      {/* Main Comparison Section */}
      <div className="cards-section">
        <div className="cards-split-row">
          {/* Antigravity Card */}
          <div className="main-card antigravity-card">
           <div className="main-card-header">
              <div className="header-title">
                <RobotIcon className="" style={{ width: 18, height: 18 }} />
                <h3>{t('dashboard.panels.antigravity', 'Antigravity')}</h3>
              </div>
              <button 
                className="header-action-btn"
                onClick={handleRefreshAgCard}
                disabled={cardRefreshing.ag}
                title={t('common.refresh', '刷新')}
              >
                <RotateCw size={14} className={cardRefreshing.ag ? 'loading-spinner' : ''} />
                <span>{t('common.refresh', '刷新')}</span>
              </button>
           </div>
           
           <div className="split-content">
              {/* Left: Current */}
              <div className="split-half current-half">
                <span className="half-label"><CheckCircle2 size={12}/> {t('dashboard.current', '当前账户')}</span>
                {renderAgAccountContent(agCurrentAccount)}
              </div>
              
              <div className="split-divider"></div>

              {/* Right: Recommended */}
              <div className="split-half recommend-half">
                 <span className="half-label"><Sparkles size={12}/> {t('dashboard.recommended', '推荐账号')}</span>
                 {agRecommended ? (
                    renderAgAccountContent(agRecommended)
                 ) : (
                    <div className="empty-slot-text">{t('dashboard.noRecommendation', '暂无更好推荐')}</div>
                 )}
              </div>
           </div>
           
           <button className="card-footer-action" onClick={() => onNavigate('overview')}>
              {t('dashboard.viewAllAccounts', '查看所有账号')}
           </button>
        </div>

          {/* Codex Card */}
          <div className="main-card codex-card">
           <div className="main-card-header">
              <div className="header-title">
                <CodexIcon size={18} />
                <h3>{t('dashboard.panels.codex', 'Codex')}</h3>
              </div>
              <button 
                className="header-action-btn"
                onClick={handleRefreshCodexCard}
                disabled={cardRefreshing.codex}
                title={t('common.refresh', '刷新')}
              >
                <RotateCw size={14} className={cardRefreshing.codex ? 'loading-spinner' : ''} />
                <span>{t('common.refresh', '刷新')}</span>
              </button>
           </div>

           <div className="split-content">
              {/* Left: Current */}
              <div className="split-half current-half">
                 <span className="half-label"><CheckCircle2 size={12}/> {t('dashboard.current', '当前账户')}</span>
                 {renderCodexAccountContent(codexCurrentAccount)}
              </div>

               <div className="split-divider"></div>

              {/* Right: Recommended */}
               <div className="split-half recommend-half">
                 <span className="half-label"><Sparkles size={12}/> {t('dashboard.recommended', '推荐账号')}</span>
                  {codexRecommended ? (
                    renderCodexAccountContent(codexRecommended)
                 ) : (
                    <div className="empty-slot-text">{t('dashboard.noRecommendation', '暂无更好推荐')}</div>
                 )}
              </div>
           </div>
           
           <button className="card-footer-action" onClick={() => onNavigate('codex')}>
              {t('dashboard.viewAllAccounts', '查看所有账号')}
           </button>
        </div>
        </div>

        <div className="cards-split-row">
          {/* GitHub Copilot Card */}
          <div className="main-card github-copilot-card">
          <div className="main-card-header">
            <div className="header-title">
              <Github size={18} />
              <h3>{t('dashboard.panels.githubCopilot', 'GitHub Copilot')}</h3>
            </div>
            <button
              className="header-action-btn"
              onClick={handleRefreshGitHubCopilotCard}
              disabled={cardRefreshing.githubCopilot}
              title={t('common.refresh', '刷新')}
            >
              <RotateCw size={14} className={cardRefreshing.githubCopilot ? 'loading-spinner' : ''} />
              <span>{t('common.refresh', '刷新')}</span>
            </button>
          </div>

          <div className="split-content">
            <div className="split-half current-half">
              <span className="half-label"><CheckCircle2 size={12}/> {t('dashboard.current', '当前账户')}</span>
              {renderGitHubCopilotAccountContent(githubCopilotCurrent)}
            </div>

            <div className="split-divider"></div>

            <div className="split-half recommend-half">
              <span className="half-label"><Sparkles size={12}/> {t('dashboard.recommended', '推荐账号')}</span>
              {githubCopilotRecommended ? (
                renderGitHubCopilotAccountContent(githubCopilotRecommended)
              ) : (
                <div className="empty-slot-text">{t('dashboard.noRecommendation', '暂无更好推荐')}</div>
              )}
            </div>
          </div>

          <button className="card-footer-action" onClick={() => onNavigate('github-copilot')}>
            {t('dashboard.viewAllAccounts', '查看所有账号')}
          </button>
        </div>

        </div>
      </div>

    </main>
  );
}
