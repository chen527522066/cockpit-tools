import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAccountStore } from '../stores/useAccountStore';
import { useCodexAccountStore } from '../stores/useCodexAccountStore';
import { useGitHubCopilotAccountStore } from '../stores/useGitHubCopilotAccountStore';

interface GeneralConfig {
  language: string;
  theme: string;
  auto_refresh_minutes: number;
  codex_auto_refresh_minutes: number;
  ghcp_auto_refresh_minutes: number;
  auto_switch_enabled: boolean;
  close_behavior: string;
  opencode_app_path?: string;
  antigravity_app_path?: string;
  codex_app_path?: string;
  vscode_app_path?: string;
  opencode_sync_on_switch?: boolean;
}

export function useAutoRefresh() {
  const { refreshAllQuotas, syncCurrentFromClient, fetchAccounts, fetchCurrentAccount } = useAccountStore();
  const { refreshAllQuotas: refreshAllCodexQuotas } = useCodexAccountStore();
  const { refreshAllTokens: refreshAllGhcpTokens } = useGitHubCopilotAccountStore();
  const agIntervalRef = useRef<number | null>(null);
  const autoSwitchIntervalRef = useRef<number | null>(null);
  const codexIntervalRef = useRef<number | null>(null);
  const ghcpIntervalRef = useRef<number | null>(null);
  const autoSwitchRefreshingRef = useRef(false);

  const setupAutoRefresh = async () => {
    try {
      const config = await invoke<GeneralConfig>('get_general_config');
      
      // 检测配额重置任务状态及唤醒总开关
      const wakeupEnabled = localStorage.getItem('agtools.wakeup.enabled') === 'true';
      if (wakeupEnabled) {
        const tasksJson = localStorage.getItem('agtools.wakeup.tasks');
        if (tasksJson) {
          try {
            const tasks = JSON.parse(tasksJson);
            const hasActiveResetTask = Array.isArray(tasks) && tasks.some(
              (t: any) => t.enabled && t.schedule?.wakeOnReset
            );
            
            // 如果有活跃的重置任务，且刷新间隔为禁用(-1)或大于2分钟，则强制修正为2分钟
            if (hasActiveResetTask && (config.auto_refresh_minutes === -1 || config.auto_refresh_minutes > 2)) {
              console.log(`[AutoRefresh] 检测到活跃的配额重置任务，自动修正刷新间隔: ${config.auto_refresh_minutes} -> 2`);
              await invoke('save_general_config', {
                language: config.language,
                theme: config.theme,
                autoRefreshMinutes: 2,
                codexAutoRefreshMinutes: config.codex_auto_refresh_minutes,
                closeBehavior: config.close_behavior || 'ask',
                opencodeAppPath: config.opencode_app_path ?? '',
                antigravityAppPath: config.antigravity_app_path ?? '',
                codexAppPath: config.codex_app_path ?? '',
                vscodeAppPath: config.vscode_app_path ?? '',
                opencodeSyncOnSwitch: config.opencode_sync_on_switch ?? true,
              });
              config.auto_refresh_minutes = 2;
            }
          } catch (e) {
            console.error('[AutoRefresh] 解析任务列表失败:', e);
          }
        }
      }
      
      if (agIntervalRef.current) {
        window.clearInterval(agIntervalRef.current);
        agIntervalRef.current = null;
      }
      if (codexIntervalRef.current) {
        window.clearInterval(codexIntervalRef.current);
        codexIntervalRef.current = null;
      }
      if (ghcpIntervalRef.current) {
        window.clearInterval(ghcpIntervalRef.current);
        ghcpIntervalRef.current = null;
      }
      if (autoSwitchIntervalRef.current) {
        window.clearInterval(autoSwitchIntervalRef.current);
        autoSwitchIntervalRef.current = null;
      }

      if (config.auto_refresh_minutes > 0) {
        console.log(`[AutoRefresh] Antigravity 已启用: 每 ${config.auto_refresh_minutes} 分钟`);
        
        const ms = config.auto_refresh_minutes * 60 * 1000;
        
        agIntervalRef.current = window.setInterval(async () => {
          console.log('[AutoRefresh] 触发定时配额刷新...');
          try {
            // 先尝试同步本地客户端的当前账号
            await syncCurrentFromClient();
            
            // 然后刷新配额
            await refreshAllQuotas();
          } catch (e) {
            console.error('[AutoRefresh] 刷新失败:', e);
          }
        }, ms);
      } else {
        console.log('[AutoRefresh] Antigravity 已禁用');
      }

      if (config.codex_auto_refresh_minutes > 0) {
        console.log(`[AutoRefresh] Codex 已启用: 每 ${config.codex_auto_refresh_minutes} 分钟`);
        const codexMs = config.codex_auto_refresh_minutes * 60 * 1000;
        codexIntervalRef.current = window.setInterval(async () => {
          console.log('[AutoRefresh] 触发 Codex 配额刷新...');
          try {
            await refreshAllCodexQuotas();
          } catch (e) {
            console.error('[AutoRefresh] Codex 刷新失败:', e);
          }
        }, codexMs);
      } else {
        console.log('[AutoRefresh] Codex 已禁用');
      }

      if (config.ghcp_auto_refresh_minutes > 0) {
        console.log(`[AutoRefresh] GitHub Copilot 已启用: 每 ${config.ghcp_auto_refresh_minutes} 分钟`);
        const ghcpMs = config.ghcp_auto_refresh_minutes * 60 * 1000;
        ghcpIntervalRef.current = window.setInterval(async () => {
          console.log('[AutoRefresh] 触发 GitHub Copilot Token 刷新...');
          try {
            await refreshAllGhcpTokens();
          } catch (e) {
            console.error('[AutoRefresh] GitHub Copilot 刷新失败:', e);
          }
        }, ghcpMs);
      } else {
        console.log('[AutoRefresh] GitHub Copilot 已禁用');
      }

      // 自动切号开启时，额外每 60 秒刷新当前账号（不影响原有配额自动刷新规则）
      if (config.auto_switch_enabled) {
        console.log('[AutoRefresh] 自动切号已启用: 每 60 秒刷新当前账号');
        autoSwitchIntervalRef.current = window.setInterval(async () => {
          if (autoSwitchRefreshingRef.current) {
            return;
          }
          autoSwitchRefreshingRef.current = true;
          try {
            await syncCurrentFromClient();
            await invoke('refresh_current_quota');
            await fetchAccounts();
            await fetchCurrentAccount();
          } catch (e) {
            console.error('[AutoRefresh] 自动切号-当前账号刷新失败:', e);
          } finally {
            autoSwitchRefreshingRef.current = false;
          }
        }, 60 * 1000);
      } else {
        console.log('[AutoRefresh] 自动切号未启用，跳过 60 秒当前账号刷新');
      }
    } catch (err) {
      console.error('[AutoRefresh] 加载配置失败:', err);
    }
  };

  useEffect(() => {
    // 初始设置
    setupAutoRefresh();

    // 监听配置变更事件
    const handleConfigUpdate = () => {
      console.log('[AutoRefresh] 检测到配置变更，重新设置定时器');
      setupAutoRefresh();
    };

    window.addEventListener('config-updated', handleConfigUpdate);

    return () => {
      if (agIntervalRef.current) {
        window.clearInterval(agIntervalRef.current);
      }
      if (codexIntervalRef.current) {
        window.clearInterval(codexIntervalRef.current);
      }
      if (ghcpIntervalRef.current) {
        window.clearInterval(ghcpIntervalRef.current);
      }
      if (autoSwitchIntervalRef.current) {
        window.clearInterval(autoSwitchIntervalRef.current);
      }
      window.removeEventListener('config-updated', handleConfigUpdate);
    };
  }, [
    fetchAccounts,
    fetchCurrentAccount,
    refreshAllCodexQuotas,
    refreshAllQuotas,
    refreshAllGhcpTokens,
    syncCurrentFromClient,
  ]);
}
