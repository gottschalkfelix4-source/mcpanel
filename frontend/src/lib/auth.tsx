import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, NetworkError, TOTP_REQUIRED_EVENT, tokenStore } from './api';
import type { Me } from './types';
import { useQueryClient } from '@tanstack/react-query';
import { resetSocket } from './socket';

interface AuthContextValue {
  user: Me | null;
  loading: boolean;
  /** Token vorhanden, aber das Backend antwortet nicht – kein Abmeldegrund. */
  offline: boolean;
  /** Liefert ein Zwischen-Token, wenn noch der Einmalcode fehlt. */
  login: (login: string, password: string) => Promise<{ mfaToken: string } | null>;
  /** Zweiter Schritt der Anmeldung: Einmalcode oder Wiederherstellungscode. */
  loginTotp: (mfaToken: string, code: string) => Promise<{ usedRecoveryCode?: boolean; recoveryCodesLeft?: number }>;
  /** Neues Token nach Passwortwechsel, „Überall abmelden“ oder 2FA-Aktivierung. */
  adoptToken: (token: string) => void;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
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
        resetSocket();
        queryClient.clear();
      }
      setOffline(err instanceof NetworkError);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onRequired = () => { if (!user?.totpRequired) void refresh(); };
    window.addEventListener(TOTP_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(TOTP_REQUIRED_EVENT, onRequired);
  }, [refresh, user?.totpRequired]);

  const startSession = useCallback(async (token: string) => {
    tokenStore.set(token);
    resetSocket();
    queryClient.clear();
    setUser(await api.get<Me>('/auth/me'));
  }, [queryClient]);

  const login = useCallback(async (loginName: string, password: string) => {
    const res = await api.post<{ token?: string; mfaRequired?: boolean; mfaToken?: string }>('/auth/login', {
      login: loginName,
      password,
    });
    if (res.mfaRequired && res.mfaToken) return { mfaToken: res.mfaToken };
    await startSession(res.token!);
    return null;
  }, [startSession]);

  const loginTotp = useCallback(async (mfaToken: string, code: string) => {
    const res = await api.post<{ token: string; usedRecoveryCode?: boolean; recoveryCodesLeft?: number }>(
      '/auth/login/totp',
      { mfaToken, code: code.replace(/\s/g, '') },
    );
    await startSession(res.token);
    return { usedRecoveryCode: res.usedRecoveryCode, recoveryCodesLeft: res.recoveryCodesLeft };
  }, [startSession]);

  // Alte Tokens sind danach ungültig – auch das der offenen Socket-Verbindung.
  const adoptToken = useCallback((token: string) => {
    tokenStore.set(token);
    resetSocket();
  }, []);

  const logout = useCallback(() => {
    // Die Sitzung auch auf dem Server beenden – sonst bliebe ein kopiertes
    // Token bis zum Ablauf gültig. Scheitert das (offline), wird trotzdem
    // lokal abgemeldet.
    if (tokenStore.get()) void api.post('/auth/logout').catch(() => {});
    resetSocket();
    queryClient.clear();
    tokenStore.clear();
    setUser(null);
    setOffline(false);
  }, [queryClient]);

  const value = useMemo(
    () => ({ user, loading, offline, login, loginTotp, adoptToken, logout, refresh }),
    [user, loading, offline, login, loginTotp, adoptToken, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth muss innerhalb von <AuthProvider> benutzt werden');
  return ctx;
}
