import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { LoadingBlock } from './components/ui';
import Layout from './components/Layout';

import LoginPage from './pages/Login';
import ServersPage from './pages/Servers';
import CreateServerPage from './pages/CreateServer';
import ServerLayout from './pages/server/ServerLayout';
import OverviewTab from './pages/server/OverviewTab';
import ConsoleTab from './pages/server/ConsoleTab';
import ModpackTab from './pages/server/ModpackTab';
import ModsTab from './pages/server/ModsTab';
import FilesTab from './pages/server/FilesTab';
import ConfigTab from './pages/server/ConfigTab';
import BackupsTab from './pages/server/BackupsTab';
import PlayersTab from './pages/server/PlayersTab';
import AccessTab from './pages/server/AccessTab';
import AutomationTab from './pages/server/AutomationTab';
import SettingsTab from './pages/server/SettingsTab';
import UsersPage from './pages/admin/Users';
import PanelSettingsPage from './pages/admin/PanelSettings';
import ProfilePage from './pages/Profile';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingBlock label="Panel wird geladen …" />
      </div>
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
        <Route path="/servers/:id" element={<ServerLayout />}>
          <Route index element={<OverviewTab />} />
          <Route path="console" element={<ConsoleTab />} />
          <Route path="modpack" element={<ModpackTab />} />
          <Route path="mods" element={<ModsTab />} />
          <Route path="files" element={<FilesTab />} />
          <Route path="config" element={<ConfigTab />} />
          <Route path="backups" element={<BackupsTab />} />
          <Route path="players" element={<PlayersTab />} />
          <Route path="automation" element={<AutomationTab />} />
          <Route path="access" element={<AccessTab />} />
          <Route path="settings" element={<SettingsTab />} />
        </Route>
        <Route path="/profile" element={<ProfilePage />} />
        {user.role === 'ADMIN' && (
          <>
            <Route path="/admin/users" element={<UsersPage />} />
            <Route path="/admin/settings" element={<PanelSettingsPage />} />
          </>
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
