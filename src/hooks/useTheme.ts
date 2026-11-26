import { useCallback, useEffect, useState } from 'react';

export type AppTheme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'ancora_theme';

export function getInitialTheme(): AppTheme {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

export function applyThemeToDocument(theme: AppTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', theme === 'dark' ? '#0f172a' : '#ffffff');
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<AppTheme>(getInitialTheme);

  useEffect(() => {
    applyThemeToDocument(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // ignore storage failure
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, setTheme, toggleTheme };
}
