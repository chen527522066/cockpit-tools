import { invoke } from '@tauri-apps/api/core';
import { PlatformId } from '../types/platform';
import {
  PlatformPackageState,
  PlatformPackageUiEntry,
  PlatformUiDevConfig,
} from '../types/platformPackage';

const PLATFORM_PACKAGE_INVOKE_SLOW_MS = 500;

function platformPerfLogEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_COCKPIT_PLATFORM_PERF_LOG === '1';
}

async function invokePlatformPackage<T>(
  command: string,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    const elapsed = Math.round(performance.now() - startedAt);
    if (platformPerfLogEnabled() || elapsed >= PLATFORM_PACKAGE_INVOKE_SLOW_MS) {
      console.info(`[PlatformPackage][Perf] invoke completed: command=${command}, elapsed=${elapsed}ms`);
    }
    return result;
  } catch (error) {
    const elapsed = Math.round(performance.now() - startedAt);
    console.warn(
      `[PlatformPackage][Perf] invoke failed: command=${command}, elapsed=${elapsed}ms`,
      error,
    );
    throw error;
  }
}

export async function listPlatformPackages(): Promise<PlatformPackageState[]> {
  return await invokePlatformPackage('list_platform_packages', () =>
    invoke('list_platform_packages'),
  );
}

export async function checkPlatformPackageUpdate(platformId: PlatformId): Promise<PlatformPackageState> {
  return await invokePlatformPackage('check_platform_package_update', () =>
    invoke('check_platform_package_update', { platformId }),
  );
}

export async function preparePlatformPackageUpdates(): Promise<PlatformPackageState[]> {
  return await invokePlatformPackage('prepare_platform_package_updates', () =>
    invoke('prepare_platform_package_updates'),
  );
}

export async function installPlatformPackage(platformId: PlatformId): Promise<PlatformPackageState> {
  return await invokePlatformPackage('install_platform_package', () =>
    invoke('install_platform_package', { platformId }),
  );
}

export async function updatePlatformPackage(platformId: PlatformId): Promise<PlatformPackageState> {
  return await invokePlatformPackage('update_platform_package', () =>
    invoke('update_platform_package', { platformId }),
  );
}

export async function reloadPlatformPackage(platformId: PlatformId): Promise<PlatformPackageState> {
  return await invokePlatformPackage('reload_platform_package', () =>
    invoke('reload_platform_package', { platformId }),
  );
}

export async function uninstallPlatformPackage(platformId: PlatformId): Promise<PlatformPackageState> {
  return await invokePlatformPackage('uninstall_platform_package', () =>
    invoke('uninstall_platform_package', { platformId }),
  );
}

export async function getPlatformPackageUiEntry(
  platformId: PlatformId,
): Promise<PlatformPackageUiEntry> {
  return await invokePlatformPackage('get_platform_package_ui_entry', () =>
    invoke('get_platform_package_ui_entry', { platformId }),
  );
}

export async function getPlatformUiDevConfig(): Promise<PlatformUiDevConfig> {
  return await invokePlatformPackage('get_platform_ui_dev_config', () =>
    invoke('get_platform_ui_dev_config'),
  );
}
