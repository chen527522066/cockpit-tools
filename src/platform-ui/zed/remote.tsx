import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { initI18n, syncLanguage } from '../../i18n';
import { ZedIcon } from '../../components/icons/ZedIcon';
import { ZedAccountsContent } from '../../pages/ZedAccountsContent';
import './style.css';

type ZedRemoteHostApi = {
  platformId: 'zed';
  packageVersion?: string | null;
  locale?: string | null;
  theme?: string | null;
  tabsSlotId?: string | null;
};

type MountedRoots = {
  contentRoot: Root;
  tabsRoot: Root | null;
  tabsContainer: HTMLElement | null;
};

const roots = new WeakMap<HTMLElement, MountedRoots>();

function normalizeTheme(theme: string | null | undefined): string {
  return theme && theme.trim() ? theme : document.documentElement.dataset.theme || 'dark';
}

function normalizeLocale(locale: string | null | undefined): string {
  return locale && locale.trim() ? locale : 'zh-CN';
}

function ZedRemoteTabs() {
  const { t } = useTranslation();

  return (
    <button type="button" className="filter-tab active" aria-current="page">
      <ZedIcon className="tab-icon" />
      <span>{t('overview.title', '账号总览')}</span>
    </button>
  );
}

export async function mount(container: HTMLElement, hostApi: ZedRemoteHostApi) {
  unmount(container);

  const theme = normalizeTheme(hostApi.theme);
  const locale = normalizeLocale(hostApi.locale);
  document.documentElement.dataset.theme = theme;
  document.documentElement.lang = locale;

  await initI18n();
  await syncLanguage(locale);

  const tabsContainer = hostApi.tabsSlotId
    ? document.getElementById(hostApi.tabsSlotId)
    : null;
  const tabsRoot = tabsContainer ? createRoot(tabsContainer) : null;
  const contentRoot = createRoot(container);

  roots.set(container, {
    contentRoot,
    tabsRoot,
    tabsContainer,
  });

  tabsRoot?.render(
    <React.StrictMode>
      <ZedRemoteTabs />
    </React.StrictMode>,
  );

  contentRoot.render(
    <React.StrictMode>
      <div className="zed-platform-ui-root">
        <div className="ghcp-accounts-page zed-accounts-page">
          <ZedAccountsContent />
        </div>
      </div>
    </React.StrictMode>,
  );

  return () => unmount(container);
}

export function unmount(container: HTMLElement) {
  const mounted = roots.get(container);
  if (!mounted) return;
  mounted.contentRoot.unmount();
  mounted.tabsRoot?.unmount();
  mounted.tabsContainer?.replaceChildren();
  roots.delete(container);
}
