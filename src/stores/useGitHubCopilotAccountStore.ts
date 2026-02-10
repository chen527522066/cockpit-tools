import { create } from 'zustand';
import {
  GitHubCopilotAccount,
  getGitHubCopilotAccountDisplayEmail,
  getGitHubCopilotPlanBadge,
  getGitHubCopilotUsage,
} from '../types/githubCopilot';
import * as githubCopilotService from '../services/githubCopilotService';

const GHCP_ACCOUNTS_CACHE_KEY = 'agtools.github_copilot.accounts.cache';

const loadCachedAccounts = (): GitHubCopilotAccount[] => {
  try {
    const raw = localStorage.getItem(GHCP_ACCOUNTS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GitHubCopilotAccount[]) : [];
  } catch {
    return [];
  }
};

const persistAccountsCache = (accounts: GitHubCopilotAccount[]) => {
  try {
    localStorage.setItem(GHCP_ACCOUNTS_CACHE_KEY, JSON.stringify(accounts));
  } catch {
    // ignore
  }
};

interface GitHubCopilotAccountState {
  accounts: GitHubCopilotAccount[];
  loading: boolean;
  error: string | null;

  fetchAccounts: () => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  deleteAccounts: (accountIds: string[]) => Promise<void>;
  refreshToken: (accountId: string) => Promise<void>;
  refreshAllTokens: () => Promise<void>;
  importFromJson: (jsonContent: string) => Promise<GitHubCopilotAccount[]>;
  exportAccounts: (accountIds: string[]) => Promise<string>;
  updateAccountTags: (accountId: string, tags: string[]) => Promise<GitHubCopilotAccount>;
}

export const useGitHubCopilotAccountStore = create<GitHubCopilotAccountState>((set, get) => ({
  accounts: loadCachedAccounts(),
  loading: false,
  error: null,

  fetchAccounts: async () => {
    set({ loading: true, error: null });
    try {
      const accounts = await githubCopilotService.listGitHubCopilotAccounts();
      // 兼容：为复用 Codex 的 UI/交互，补齐 email/plan_type/quota 等派生字段
      const mapped = accounts.map((acc) => {
        const email = getGitHubCopilotAccountDisplayEmail(acc);
        const usage = getGitHubCopilotUsage(acc);
        const hourlyPct = usage.inlineSuggestionsUsedPercent ?? usage.chatMessagesUsedPercent;
        const weeklyPct = usage.chatMessagesUsedPercent ?? usage.inlineSuggestionsUsedPercent;
        const quota =
          hourlyPct == null && weeklyPct == null
            ? undefined
            : {
                hourly_percentage: hourlyPct ?? 0,
                weekly_percentage: weeklyPct ?? 0,
                hourly_reset_time: usage.allowanceResetAt ?? null,
                weekly_reset_time: usage.allowanceResetAt ?? null,
                raw_data: {
                  remainingCompletions: usage.remainingCompletions,
                  remainingChat: usage.remainingChat,
                  totalCompletions: usage.totalCompletions,
                  totalChat: usage.totalChat,
                },
              };
        return {
          ...acc,
          email,
          plan_type: getGitHubCopilotPlanBadge(acc),
          quota,
        } as GitHubCopilotAccount;
      });
      set({ accounts: mapped, loading: false });
      persistAccountsCache(mapped);
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  deleteAccounts: async (accountIds: string[]) => {
    if (accountIds.length === 0) return;
    if (accountIds.length === 1) {
      await githubCopilotService.deleteGitHubCopilotAccount(accountIds[0]);
    } else {
      await githubCopilotService.deleteGitHubCopilotAccounts(accountIds);
    }
    await get().fetchAccounts();
  },

  switchAccount: async (accountId: string) => {
    await githubCopilotService.injectGitHubCopilotToVSCode(accountId);
    await get().fetchAccounts();
  },

  refreshToken: async (accountId: string) => {
    await githubCopilotService.refreshGitHubCopilotToken(accountId);
    await get().fetchAccounts();
  },

  refreshAllTokens: async () => {
    await githubCopilotService.refreshAllGitHubCopilotTokens();
    await get().fetchAccounts();
  },

  importFromJson: async (jsonContent: string) => {
    const accounts = await githubCopilotService.importGitHubCopilotFromJson(jsonContent);
    await get().fetchAccounts();
    return accounts;
  },

  exportAccounts: async (accountIds: string[]) => {
    return await githubCopilotService.exportGitHubCopilotAccounts(accountIds);
  },

  updateAccountTags: async (accountId: string, tags: string[]) => {
    const account = await githubCopilotService.updateGitHubCopilotAccountTags(accountId, tags);
    await get().fetchAccounts();
    return account;
  },
}));
