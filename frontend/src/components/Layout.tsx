import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Boxes, ChevronDown, LogOut, Server, Settings, Shield, User, Users } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { BlockIcon, GrassStrip } from './pixel';

function Logo() {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2.5 sm:gap-[13px]">
      <BlockIcon size={40} grass icon={<Boxes size={18} />} />
      {/* Auf schmalen Screens nur der Schriftzug – der Untertitel ist breiter
          als er und würde die Kopfzeile über den Viewport schieben. */}
      <span className="min-w-0 leading-none">
        <span className="block font-pixel text-[11px] text-white text-shadow-pixel sm:text-[13px]">
          MCPanel
        </span>
        <span className="mt-[5px] hidden text-[10px] uppercase tracking-[0.24em] text-stone-450 sm:block">
          Server Hosting
        </span>
      </span>
    </Link>
  );
}

function NavItem({
  to,
  icon,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-2 border px-2.5 py-[7px] text-sm font-semibold transition sm:px-[13px]',
          isActive
            ? 'border-grass-dark bg-grass/[0.22] text-white shadow-[inset_1px_1px_0_rgba(255,255,255,.12),0_0_18px_-6px_rgba(127,178,56,.6)]'
            : 'border-transparent text-stone-400 hover:border-stone-700 hover:bg-stone-800/70 hover:text-stone-50',
        )
      }
    >
      {icon}
      <span className="hidden sm:inline">{children}</span>
    </NavLink>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!user) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex shrink-0 items-center gap-1.5 border border-stone-700 bg-stone-800/80 px-2 py-1.5 text-sm transition hover:border-stone-500 hover:bg-stone-700/90 sm:gap-[9px] sm:px-[11px]"
      >
        <span
          className="grid h-[26px] w-[26px] place-items-center border border-stone-950 bg-dirt text-[11px] font-bold text-white"
          style={{ boxShadow: 'inset 1px 1px 0 rgba(255,255,255,.2)' }}
        >
          {user.username.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden font-semibold text-stone-100 sm:inline">{user.username}</span>
        <ChevronDown size={14} className="text-stone-450" />
      </button>

      {open && (
        <div className="mc-frame absolute right-0 z-40 mt-2 w-56 animate-pop-in !p-1">
          <div className="mc-frame-inner p-1">
            <div className="border-b border-stone-890 px-3 py-2">
              <p className="truncate text-sm font-semibold text-stone-50">{user.username}</p>
              <p className="truncate text-xs text-stone-450">{user.email}</p>
              {user.role === 'ADMIN' && (
                <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gold">
                  <Shield size={11} /> Administrator
                </span>
              )}
            </div>
            <button
              onClick={() => {
                setOpen(false);
                navigate('/profile');
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-stone-100 transition hover:bg-stone-600/50 hover:text-white"
            >
              <User size={15} /> Mein Konto
            </button>
            <button
              onClick={logout}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-redstone transition hover:bg-redstone/15"
            >
              <LogOut size={15} /> Abmelden
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user } = useAuth();

  return (
    <div className="relative z-10 flex min-h-screen flex-col">
      {/*
       * Grasstreifen INNERHALB des sticky Headers: so füllt der Header-
       * Hintergrund im Standalone-Modus auch die transparente Statusleiste
       * (env(safe-area-inset-top)), statt dass die Uhr auf dem Logo liegt.
       */}
      <header
        className="sticky top-0 z-30 border-b border-stone-950 bg-[#121215]/[0.92] shadow-[0_10px_26px_-18px_rgba(0,0,0,.9)] backdrop-blur-[10px]"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <GrassStrip />
        <div className="mx-auto flex max-w-[1320px] items-center justify-between gap-2 px-3 py-3 sm:gap-4 sm:px-5">
          <Logo />

          <nav className="flex items-center gap-1.5">
            <NavItem to="/" icon={<Server size={15} />}>
              Server
            </NavItem>
            {user?.role === 'ADMIN' && (
              <>
                <NavItem to="/admin/users" icon={<Users size={15} />}>
                  Benutzer
                </NavItem>
                <NavItem to="/admin/settings" icon={<Settings size={15} />}>
                  Panel
                </NavItem>
              </>
            )}
          </nav>

          <UserMenu />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1320px] flex-1 px-5 pb-10 pt-[26px]">
        <Outlet />
      </main>

      <footer className="border-t border-stone-875 p-[18px] text-center text-xs text-stone-550">
        MCPanel · selbstgehostet · Modpacks von{' '}
        <a href="https://modrinth.com" target="_blank" rel="noreferrer">
          Modrinth
        </a>{' '}
        &{' '}
        <a href="https://curseforge.com" target="_blank" rel="noreferrer" className="!text-gold">
          CurseForge
        </a>
      </footer>
    </div>
  );
}
