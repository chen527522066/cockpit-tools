import { create } from 'zustand';
import { CodexAccount, CodexQuota } from '../types/codex';
import * as codexService from '../services/codexService';

const CODEX_ACCOUNTS_CACHE_KEY = 'agtools.codex.accounts.cache';
const CODEX_CURRENT_ACCOUNT_CACHE_KEY = 'agtools.codex.accounts.current';

const loadCachedCodexAccounts = () => {
  try {
    const raw = localStorage.getItem(CODEX_ACCOUNTS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const loadCachedCodexCurrentAccount = () => {
  try {
    const raw = localStorage.getItem(CODEX_CURRENT_ACCOUNT_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CodexAccount;
  } catch {
    return null;
  }
};

const persistCodexAccountsCache = (accounts: CodexAccount[]) => {
  try {
    localStorage.setItem(CODEX_ACCOUNTS_CACHE_KEY, JSON.stringify(accounts));
  } catch {
    // ignore cache write failures
  }
};

const persistCodexCurrentAccountCache = (account: CodexAccount | null) => {
  try {
    if (!account) {
      localStorage.removeItem(CODEX_CURRENT_ACCOUNT_CACHE_KEY);
      return;
    }
    localStorage.setItem(CODEX_CURRENT_ACCOUNT_CACHE_KEY, JSON.stringify(account));
  } catch {
    // ignore cache write failures
  }
};

interface CodexAccountState {
  accounts: CodexAccount[];
  currentAccount: CodexAccount | null;
  loading: boolean;
  error: string | null;
  
  // Actions
  fetchAccounts: () => Promise<void>;
  fetchCurrentAccount: () => Promise<void>;
  switchAccount: (accountId: string) => Promise<CodexAccount>;
  deleteAccount: (accountId: string) => Promise<void>;
  deleteAccounts: (accountIds: string[]) => Promise<void>;
  refreshQuota: (accountId: string) => Promise<CodexQuota>;
  refreshAllQuotas: () => Promise<number>;
  importFromLocal: () => Promise<CodexAccount>;
  importFromJson: (jsonContent: string) => Promise<CodexAccount[]>;
  updateAccountTags: (accountId: string, tags: string[]) => Promise<CodexAccount>;
}

export const useCodexAccountStore = create<CodexAccountState>((set, get) => ({
  accounts: loadCachedCodexAccounts(),
  currentAccount: loadCachedCodexCurrentAccount(),
  loading: false,
  error: null,
  
  fetchAccounts: async () => {
    set({ loading: true, error: null });
    try {
      const accounts = await codexService.listCodexAccounts();
      set({ accounts, loading: false });
      persistCodexAccountsCache(accounts);
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
  
  fetchCurrentAccount: async () => {
    try {
      const currentAccount = await codexService.getCurrentCodexAccount();
      set({ currentAccount });
      persistCodexCurrentAccountCache(currentAccount);
    } catch (e) {
      console.error('获取当前 Codex 账号失败:', e);
    }
  },
  
  switchAccount: async (accountId: string) => {
    const account = await codexService.switchCodexAccount(accountId);
    set({ currentAccount: account });
    await get().fetchAccounts();
    return account;
  },
  
  deleteAccount: async (accountId: string) => {
    await codexService.deleteCodexAccount(accountId);
    await get().fetchAccounts();
    await get().fetchCurrentAccount();
  },
  
  deleteAccounts: async (accountIds: string[]) => {
    await codexService.deleteCodexAccounts(accountIds);
    await get().fetchAccounts();
    await get().fetchCurrentAccount();
  },
  
  refreshQuota: async (accountId: string) => {
    const quota = await codexService.refreshCodexQuota(accountId);
    await get().fetchAccounts();
    return quota;
  },
  
  refreshAllQuotas: async () => {
    const successCount = await codexService.refreshAllCodexQuotas();
    await get().fetchAccounts();
    return successCount;
  },
  
  importFromLocal: async () => {
    const account = await codexService.importCodexFromLocal();
    await get().fetchAccounts();
    return account;
  },
  
  importFromJson: async (jsonContent: string) => {
    const accounts = await codexService.importCodexFromJson(jsonContent);
    await get().fetchAccounts();
    return accounts;
  },

  updateAccountTags: async (accountId: string, tags: string[]) => {
    const account = await codexService.updateCodexAccountTags(accountId, tags);
    await get().fetchAccounts();
    return account;
  },
}));
