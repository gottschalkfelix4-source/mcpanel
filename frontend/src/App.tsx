import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, NETWORK_ERROR_MESSAGE } from './lib/api';
import { useAuth } from './lib/auth';
import { Button, InfoNote, LoadErrorBlock, LoadingBlock } from './components/ui';
import Layout from './components/Layout';
import TotpPanel from './components/TotpPanel';

import LoginPage from './pages/Login';
import SetupPage from './pages/Setup';
import ServersPage from './pages/Servers';
import CreateServerPage from './pages/CreateServer';
import ImportServerPage from './pages/ImportServer';
import ServerLayout from './pages/server/ServerLayout';
import OverviewTab from './pages/server/OverviewTab';
import ConsoleTab from './pages/server/ConsoleTab';
import ModpackTab from './pages/server/ModpackTab';
import ContentTab from './pages/server/ContentTab';
import FilesTab from './pages/server/FilesTab';
import ConfigTab from './pages/server/ConfigTab';
import BackupsTab from './pages/server/BackupsTab';
import WorldsTab from './pages/server/WorldsTab';
import PlayersTab from './pages/server/PlayersTab';
import AccessTab from './pages/server/AccessTab';
import AutomationTab from './pages/server/AutomationTab';
import SettingsTab from './pages/server/SettingsTab';
import ReinstallTab from './pages/server/ReinstallTab';
import UsersPage from './pages/admin/Users';
import PanelSettingsPage from './pages/admin/PanelSettings';
import ProxyPage from './pages/admin/Proxy';
import ProfilePage from './pages/Profile';

/**
 * Der Administrator hat den zweiten Faktor vorgeschrieben: Bis er
 * eingerichtet ist, lehnt das Backend fast alles ab. Statt einer Oberfläche
 * voller Fehlermeldungen gibt es nur diese eine Seite.
 */
function TotpRequired() {
  const { user, logout } = useAuth();
  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-5 p-4 animate-fade-in">
      <h1 className="heading-pixel text-base">Zwei-Faktor-Anmeldung einrichten</h1>
      <InfoNote>
        Für {user?.role === 'ADMIN' ? 'Administratorkonten' : 'alle Konten'} ist auf diesem Panel ein zweiter
        Faktor vorgeschrieben. Richte ihn ein, um weiterzumachen – danach geht es ganz normal ins Panel.
      </InfoNote>
      <TotpPanel />
      <div>
        <Button variant="ghost" onClick={() => logout()}>Abmelden</Button>
      </div>
    </div>
  );
}

export default function App() {
  const { user, loading, offline, refresh } = useAuth();

  // Nur fragen, solange niemand angemeldet ist – im laufenden Betrieb waere
  // das ein ueberfluessiger Aufruf bei jedem Seitenaufbau.
  const setup = useQuery({
    queryKey: ['setup-needed'],
    queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status'),
    enabled: !loading && !user,
    staleTime: 60_000,
  });

  if (loading || (!user && setup.isLoading)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="Panel wird geladen …" />
      </div>
    );
  }

  // Die Sitzung besteht, nur das Backend antwortet nicht – etwa waehrend eines
  // Container-Updates. Die Anmeldemaske waere hier die falsche Auskunft: das
  // Passwort ist in Ordnung, der Server ist es gerade nicht.
  if (!user && offline) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <LoadErrorBlock
          error={new Error(NETWORK_ERROR_MESSAGE)}
          onRetry={() => void refresh()}
        />
      </div>
    );
  }

  // Frisches Panel ohne Konto: erst durch die Einrichtung fuehren, nicht
  // vor eine Anmeldung stellen, bei der es nichts anzumelden gibt.
  if (!user && setup.data?.needsSetup) {
    return (
      <Routes>
        <Route path="*" element={<SetupPage />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (user.totpRequired) {
    return (
      <Routes>
        <Route path="*" element={<TotpRequired />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route path="/" element={<ServersPage />} />
        {/* Server anlegen ist Administratorensache – ohne Adminrecht wuerde
            die Seite ohnehin nur in einer Absage der Schnittstelle enden. */}
        {user.role === 'ADMIN' && (
          <Route path="/servers/new" element={<CreateServerPage />} />
        )}
        {user.role === 'ADMIN' && <Route path="/servers/import" element={<ImportServerPage />} />}
        <Route path="/servers/:id" element={<ServerLayout />}>
          <Route index element={<OverviewTab />} />
          <Route path="console" element={<ConsoleTab />} />
          <Route path="modpack" element={<ModpackTab />} />
          <Route path="content" element={<ContentTab />} />
          <Route path="files" element={<FilesTab />} />
          <Route path="config" element={<ConfigTab />} />
          <Route path="backups" element={<BackupsTab />} />
          <Route path="worlds" element={<WorldsTab />} />
          <Route path="players" element={<PlayersTab />} />
          <Route path="automation" element={<AutomationTab />} />
          <Route path="access" element={<AccessTab />} />
          <Route path="settings" element={<SettingsTab />} />
          <Route path="reinstall" element={<ReinstallTab />} />
        </Route>
        <Route path="/profile" element={<ProfilePage />} />
        {user.role === 'ADMIN' && (
          <>
            <Route path="/admin/users" element={<UsersPage />} />
            <Route path="/admin/settings" element={<PanelSettingsPage />} />
            <Route path="/admin/proxy" element={<ProxyPage />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
