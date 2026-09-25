import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { getData, useData } from '@/data/store';
import { TooltipProvider } from '@/ui/primitives';
import { CommandPalette } from '@/features/palette/CommandPalette';
import { QuickCapture } from '@/features/capture/QuickCapture';
import { TaskDetailDialog } from '@/features/task/TaskDetail';
import { FocusOverlay } from '@/features/focus/FocusView';
import { RitualOverlay } from '@/features/rituals/RitualOverlay';
import { GapDialog, ZoneChangeBanner } from '@/features/system/SystemPrompts';
import { ShortcutsDialog } from '@/features/system/ShortcutsDialog';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { ViewRouter } from './ViewRouter';
import { Sidebar } from './Sidebar';
import { runCommand } from './commands';
import { createMatcher, keysFor, COMMANDS } from './shortcuts';
import { useUi } from './ui';
import { startIntegrationScheduler } from '@/integrations/manager';
import { isPaletteId } from '@/domain/palettes';
import { startFocusBarController } from './focusBar';
import { startGlobalShortcuts } from './globalShortcuts';

function useTheme() {
  const theme = useData((s) => s.settings.theme);
  const density = useData((s) => s.settings.density);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
  const palette = useData((s) => s.settings.palette);
  useEffect(() => {
    document.documentElement.dataset.palette = isPaletteId(palette) ? palette : 'teal';
  }, [palette]);
}

function useGlobalShortcuts() {
  useEffect(() => {
    const handler = createMatcher(
      () => {
        const overrides = getData().settings.shortcuts;
        return Object.fromEntries(COMMANDS.map((c) => [c.id, keysFor(c.id, overrides)]));
      },
      (id) => runCommand(id),
    );
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

/** The floating focus bar and its system-wide shortcuts (desktop only). */
function useFocusBar(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const stopBar = startFocusBarController();
    const stopShortcuts = startGlobalShortcuts();
    return () => {
      stopShortcuts();
      stopBar();
    };
  }, [active]);
}

/** Optional integrations sync in the background only once the app is ready (desktop only). */
function useIntegrationSync(active: boolean) {
  useEffect(() => {
    if (!active) return;
    return startIntegrationScheduler();
  }, [active]);
}

function Splash() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted">
        <img src="/keel.svg" alt="" className="h-12 w-12 animate-soft-pulse" />
        <span className="text-[13px]">Opening your planner…</span>
      </div>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md rounded-2xl border border-line bg-surface p-6 shadow-md">
        <div className="mb-2 flex items-center gap-2 text-danger">
          <AlertTriangle size={18} />
          <span className="font-semibold">Keel couldn’t open your data</span>
        </div>
        <p className="selectable text-[13px] text-muted">{message}</p>
        <p className="mt-3 text-[12.5px] text-muted">
          Your database file has not been modified. Automatic backups are kept in the{' '}
          <code>backups</code> folder next to it (see README → “Where your data lives”).
        </p>
      </div>
    </div>
  );
}

export function App() {
  const status = useData((s) => s.status);
  const error = useData((s) => s.error);
  const onboarded = useData((s) => s.settings.onboarded);
  const sidebar = useUi((s) => s.sidebar);
  useTheme();
  useGlobalShortcuts();
  useIntegrationSync(status === 'ready' && onboarded);
  useFocusBar(status === 'ready' && onboarded);

  if (status === 'loading') return <Splash />;
  if (status === 'error') return <ErrorScreen message={error ?? 'Unknown error'} />;

  return (
    <TooltipProvider>
      <div className="flex h-full">
        {sidebar && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col">
          <ZoneChangeBanner />
          <ViewRouter />
        </main>
      </div>
      <TaskDetailDialog />
      <QuickCapture />
      <CommandPalette />
      <ShortcutsDialog />
      <FocusOverlay />
      <RitualOverlay />
      <GapDialog />
      {!onboarded && <Onboarding />}
      <Toaster
        position="bottom-center"
        toastOptions={{
          className: '!bg-fg !text-bg !border-0 !rounded-xl !shadow-lg !text-[13px]',
          actionButtonStyle: { background: 'var(--accent)', color: 'var(--accent-fg)' },
        }}
      />
    </TooltipProvider>
  );
}
