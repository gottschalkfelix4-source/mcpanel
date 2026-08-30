import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, NetworkError, tokenStore } from './api';
import type { Me } from './types';

interface AuthContextValue {
  user: Me | null;
  loading: boolean;
  /** Token vorhanden, aber das Backend antwortet nicht – kein Abmeldegrund. */
  offline: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) {
      setUser(null);
      setOffline(false);
      setLoading(false);
      return;
    }
    try {
      setUser(await api.get<Me>('/auth/me'));
      setOffline(false);
    } catch (err) {
      // Nur eine tatsaechlich abgelehnte Sitzung wegwerfen. Antwortet das
      // Backend gerade gar nicht - Neustart nach einem Update -, ist das Token
      // deswegen nicht ungueltig und muss den Neustart ueberleben.
      if (err instanceof ApiError && err.status === 401) {
        tokenStore.clear();
      }
      setOffline(err instanceof NetworkError);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (loginName: string, password: string) => {
    const res = await api.post<{ token: string; user: Me }>('/auth/login', {
      login: loginName,
      password,
    });
    tokenStore.set(res.token);
    setUser(await api.get<Me>('/auth/me'));
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setOffline(false);
  }, []);

  const value = useMemo(
    () => ({ user, loading, offline, login, logout, refresh }),
    [user, loading, offline, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth muss innerhalb von <AuthProvider> benutzt werden');
  return ctx;
}
