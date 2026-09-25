import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Database,
  Download,
  HardDrive,
  RotateCcw,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import type { BackupInfo, DbInfo } from '@/app/native';
import { native } from '@/app/native';
import { updates } from '@/app/updates';
import { resetBarPosition, toggleBar } from '@/app/focusBar';
import { acceleratorFromEvent, formatAccelerator } from '@/app/globalShortcutRules';
import type { GlobalShortcutKey } from '@/app/globalShortcuts';
import { GLOBAL_SHORTCUTS, problemFor, useGlobalShortcutStatus } from '@/app/globalShortcuts';
import { formatShortcut, platform } from '@/app/platform';
import { COMMANDS, eventToChord, keysFor } from '@/app/shortcuts';
import { useUi } from '@/app/ui';
import {
  notificationPermission,
  requestNotificationPermission,
  sendNotification,
} from '@/app/notify';
import type { Permission } from '@/app/notify';
import { errorMessage, run, saveSettings } from '@/data/actions';
import {
  buildCalendarIcs,
  buildJsonExport,
  buildTasksCsv,
  exportFileName,
} from '@/data/importExport';
import { isTauri } from '@/data/runtime';
import { useData } from '@/data/store';
import {
  formatDateTime,
  formatDuration,
  isValidZone,
  parseClock,
  systemZone,
} from '@/domain/dates';
import type { Density, RolloverMode, Settings, ThemePref } from '@/domain/types';
import { DEFAULT_SETTINGS } from '@/domain/types';
import type { PaletteId } from '@/domain/palettes';
import { PALETTES } from '@/domain/palettes';
import { LATEST_SCHEMA_VERSION } from '@/db/migrate';
import { Button, Dialog, Input, Kbd, Label, Segmented, Switch, cn } from '@/ui/primitives';
import { ViewHeader } from '../common/ViewHeader';
import { WorkingDaysPicker } from '../onboarding/Onboarding';
import { shortcutLabel } from '../system/ShortcutsDialog';

const SECTIONS = [
  ['general', 'General'],
  ['planning', 'Planning'],
  ['notifications', 'Notifications'],
  ['shortcuts', 'Shortcuts'],
  ['focusbar', 'Focus bar'],
  ['data', 'Data & privacy'],
  ['about', 'About'],
] as const;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[220px_1fr] items-start gap-4 border-b border-line/70 py-3.5 last:border-b-0">
      <div>
        <div className="text-[13px] font-medium text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface px-5 py-2 shadow-sm">
      <h2 className="pt-3 pb-1 text-[14px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function useSetting<K extends keyof Settings>(key: K): [Settings[K], (v: Settings[K]) => void] {
  const value = useData((s) => s.settings[key]);
  return [value, (v) => run(saveSettings({ [key]: v } as Partial<Settings>))];
}

function ZoneSelect({
  value,
  onChange,
  allowSystem,
  allowNone,
  label,
}: {
  value: string | null;
  onChange: (z: string | null) => void;
  allowSystem?: boolean;
  allowNone?: boolean;
  label: string;
}) {
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
        'timeZone',
      );
    } catch {
      return [systemZone()];
    }
  }, []);
  return (
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-8 max-w-[320px] rounded-lg border border-line bg-surface px-2 text-[13px] text-fg"
    >
      {allowNone && <option value="">None</option>}
      {allowSystem && <option value="system">Follow system ({systemZone()})</option>}
      {zones.map((z) => (
        <option key={z} value={z}>
          {z.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}

/** Color theme swatches: the accent color of each theme, in the current light/dark mode. */
function PalettePicker({
  value,
  onChange,
}: {
  value: PaletteId;
  onChange: (v: PaletteId) => void;
}) {
  const dark = useIsDark();
  return (
    <div role="radiogroup" aria-label="Color theme" className="flex flex-wrap gap-2">
      {PALETTES.map((p) => {
        const selected = p.id === value;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(p.id)}
            className={cn(
              'flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[12.5px] transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              selected
                ? 'border-accent bg-accent-soft font-medium text-accent-text'
                : 'border-line bg-surface text-fg hover:bg-surface-hover',
            )}
          >
            <span
              aria-hidden
              className="h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
              style={{ background: dark ? p.swatch.dark : p.swatch.light }}
            />
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.dataset.theme === 'dark'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function General() {
  const [theme, setTheme] = useSetting('theme');
  const [palette, setPalette] = useSetting('palette');
  const [density, setDensity] = useSetting('density');
  const [hour12, setHour12] = useSetting('hour12');
  const [weekStartsOn, setWeekStartsOn] = useSetting('weekStartsOn');
  const [timeZone, setTimeZone] = useSetting('timeZone');
  const [secondary, setSecondary] = useSetting('secondaryTimeZone');
  return (
    <Card title="General">
      <Field label="Theme">
        <Segmented<ThemePref>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Field>
      <Field label="Color theme" hint="Accent color and background tint, in light and dark.">
        <PalettePicker value={palette} onChange={setPalette} />
      </Field>
      <Field label="Density" hint="Compact fits more tasks on screen.">
        <Segmented<Density>
          label="Density"
          value={density}
          onChange={setDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </Field>
      <Field label="Time format">
        <Segmented<string>
          label="Time format"
          value={hour12 ? '12' : '24'}
          onChange={(v) => setHour12(v === '12')}
          options={[
            { value: '24', label: '24-hour (13:00)' },
            { value: '12', label: '12-hour (1:00 pm)' },
          ]}
        />
      </Field>
      <Field label="Week starts on">
        <Segmented<number>
          label="Week starts on"
          value={weekStartsOn}
          onChange={setWeekStartsOn}
          options={[
            { value: 1, label: 'Monday' },
            { value: 7, label: 'Sunday' },
            { value: 6, label: 'Saturday' },
          ]}
        />
      </Field>
      <Field
        label="Time zone"
        hint="Time blocks keep their absolute time when the zone changes; you’ll be asked whether to shift them. Planned days and deadlines never move."
      >
        <ZoneSelect
          label="Time zone"
          value={timeZone}
          allowSystem
          onChange={(z) => z && (z === 'system' || isValidZone(z)) && setTimeZone(z)}
        />
      </Field>
      <Field label="Second time zone" hint="Shown next to the calendar hours.">
        <ZoneSelect
          label="Second time zone"
          value={secondary}
          allowNone
          onChange={(z) => setSecondary(z)}
        />
      </Field>
    </Card>
  );
}

function Planning() {
  const s = useData((st) => st.settings);
  const [capacity, setCapacity] = useState(String(s.dailyCapacityMin / 60));
  useEffect(() => setCapacity(String(s.dailyCapacityMin / 60)), [s.dailyCapacityMin]);
  const workday = (() => {
    try {
      return parseClock(s.workdayEnd) - parseClock(s.workdayStart);
    } catch {
      return 0;
    }
  })();
  const save = (patch: Partial<Settings>) => run(saveSettings(patch));
  return (
    <Card title="Planning">
      <Field label="Working days">
        <WorkingDaysPicker
          value={s.workingDays}
          onChange={(v) => v.length && save({ workingDays: v })}
        />
      </Field>
      <Field
        label="Working hours"
        hint={workday > 0 ? `${formatDuration(workday)} per day` : 'End must be after start'}
      >
        <Input
          type="time"
          aria-label="Workday start"
          value={s.workdayStart}
          onChange={(e) => e.target.value && save({ workdayStart: e.target.value })}
          className="w-32"
        />
        <span className="text-muted">to</span>
        <Input
          type="time"
          aria-label="Workday end"
          value={s.workdayEnd}
          onChange={(e) => e.target.value && save({ workdayEnd: e.target.value })}
          className="w-32"
        />
      </Field>
      <Field
        label="Daily capacity"
        hint="Tasks plus meetings above this marks a day as overcommitted."
      >
        <Input
          type="number"
          aria-label="Daily capacity in hours"
          min={0.5}
          max={16}
          step={0.5}
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          onBlur={() => {
            const h = Number(capacity);
            if (h >= 0.5 && h <= 16) save({ dailyCapacityMin: Math.round(h * 60) });
            else setCapacity(String(s.dailyCapacityMin / 60));
          }}
          className="w-24"
        />
        <span className="text-muted">hours</span>
      </Field>
      <Field
        label="Break buffer"
        hint="Free time kept around meetings when Keel places tasks for you."
      >
        <Segmented<number>
          label="Buffer"
          value={s.bufferMin}
          onChange={(v) => save({ bufferMin: v })}
          options={[0, 5, 10, 15].map((m) => ({ value: m, label: `${m}m` }))}
        />
      </Field>
      <Field label="Default estimate" hint="Used for tasks without an estimate when timeboxing.">
        <Segmented<number>
          label="Default estimate"
          value={s.defaultEstimateMin}
          onChange={(v) => save({ defaultEstimateMin: v })}
          options={[15, 30, 45, 60].map((m) => ({ value: m, label: formatDuration(m) }))}
        />
      </Field>
      <Field label="Unfinished tasks" hint="What happens to open tasks from previous days.">
        <Segmented<RolloverMode>
          label="Rollover"
          value={s.rolloverMode}
          onChange={(v) => save({ rolloverMode: v })}
          options={[
            { value: 'auto', label: 'Carry to today automatically' },
            { value: 'manual', label: 'Leave them; I’ll decide' },
          ]}
        />
      </Field>
      <Field label="Days on the board">
        <Segmented<number>
          label="Visible days"
          value={s.visibleDays}
          onChange={(v) => save({ visibleDays: v })}
          options={[1, 3, 5, 7].map((n) => ({ value: n, label: String(n) }))}
        />
      </Field>
      <Field label="Calendar">
        <Segmented<number>
          label="Snap"
          value={s.calendarSnapMin}
          onChange={(v) => save({ calendarSnapMin: v })}
          options={[5, 10, 15, 30].map((m) => ({ value: m, label: `${m}m snap` }))}
        />
        <Segmented<number>
          label="Zoom"
          value={s.calendarHourHeight}
          onChange={(v) => save({ calendarHourHeight: v })}
          options={[
            { value: 40, label: 'S' },
            { value: 56, label: 'M' },
            { value: 80, label: 'L' },
          ]}
        />
      </Field>
    </Card>
  );
}

function Notifications() {
  const s = useData((st) => st.settings);
  const [perm, setPerm] = useState<Permission>('default');
  useEffect(() => {
    void notificationPermission().then(setPerm);
  }, []);
  const save = (patch: Partial<Settings>) => run(saveSettings(patch));
  return (
    <Card title="Notifications">
      <Field
        label="Desktop notifications"
        hint={
          perm === 'granted'
            ? 'Allowed by the system.'
            : perm === 'denied'
              ? 'Blocked in system settings.'
              : 'The system will ask for permission.'
        }
      >
        <Switch
          label="Enable notifications"
          checked={s.notificationsEnabled}
          onCheckedChange={async (on) => {
            if (on && perm !== 'granted') {
              const p = await requestNotificationPermission();
              setPerm(p);
              if (p !== 'granted') {
                toast.error('Notifications are not allowed by the system.');
                return;
              }
            }
            save({ notificationsEnabled: on });
          }}
        />
        {s.notificationsEnabled && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void sendNotification('Keel notifications work', 'This is a test.')}
          >
            Send a test
          </Button>
        )}
      </Field>
      <Field label="When a time block starts">
        <Switch
          label="Notify at block start"
          checked={s.notifyBlockStart}
          disabled={!s.notificationsEnabled}
          onCheckedChange={(v) => save({ notifyBlockStart: v })}
        />
      </Field>
      <Field label="When you reach an estimate" hint="While a timer runs.">
        <Switch
          label="Notify at estimate"
          checked={s.notifyEstimateReached}
          disabled={!s.notificationsEnabled}
          onCheckedChange={(v) => save({ notifyEstimateReached: v })}
        />
      </Field>
      <Field label="Shutdown reminder" hint="On working days, if you haven’t shut down yet.">
        <Switch
          label="Shutdown reminder"
          checked={s.notifyShutdown}
          disabled={!s.notificationsEnabled}
          onCheckedChange={(v) => save({ notifyShutdown: v })}
        />
        <Input
          type="time"
          aria-label="Shutdown reminder time"
          value={s.shutdownReminderTime}
          disabled={!s.notifyShutdown || !s.notificationsEnabled}
          onChange={(e) => e.target.value && save({ shutdownReminderTime: e.target.value })}
          className="w-32"
        />
      </Field>
      <Field
        label="Idle timer check"
        hint="If a timer runs through a gap this long (sleep, app closed), Keel asks before counting it."
      >
        <Segmented<number>
          label="Idle threshold"
          value={s.idleThresholdMin}
          onChange={(v) => save({ idleThresholdMin: v })}
          options={[10, 20, 30, 60].map((m) => ({ value: m, label: `${m}m` }))}
        />
      </Field>
    </Card>
  );
}

function Shortcuts() {
  const overrides = useData((s) => s.settings.shortcuts);
  const [recording, setRecording] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const chord = eventToChord(e);
      if (!chord) return;
      const clash = COMMANDS.find((c) => c.id !== recording && keysFor(c.id, overrides) === chord);
      if (clash) {
        toast.error(`${formatShortcut(chord)} is already used for “${clash.label}”.`);
        return;
      }
      run(saveSettings({ shortcuts: { ...overrides, [recording]: chord } }));
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, overrides]);
  return (
    <Card title="Keyboard shortcuts">
      <p className="pb-2 text-[12px] text-muted">
        Click a shortcut, then press the new key combination. Esc cancels.
      </p>
      {COMMANDS.map((c) => {
        const custom = c.id in overrides;
        return (
          <div
            key={c.id}
            className="flex h-10 items-center gap-3 border-b border-line/60 last:border-b-0"
          >
            <span className="flex-1 text-[13px]">{c.label}</span>
            <button
              type="button"
              onClick={() => setRecording(c.id)}
              className={cn(
                'min-w-[110px] rounded-md border px-2 py-1 text-[12px]',
                recording === c.id
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-line hover:border-line-strong',
              )}
            >
              {recording === c.id ? (
                'Press keys…'
              ) : (
                <Kbd className="border-0 shadow-none">
                  {shortcutLabel(keysFor(c.id, overrides))}
                </Kbd>
              )}
            </button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!custom}
              onClick={() => {
                const next = { ...overrides };
                delete next[c.id];
                run(saveSettings({ shortcuts: next }));
              }}
            >
              <RotateCcw size={12} /> Reset
            </Button>
          </div>
        );
      })}
    </Card>
  );
}

function GlobalShortcutRow({ k, label }: { k: GlobalShortcutKey; label: string }) {
  const settings = useData((s) => s.settings);
  const value = settings[k];
  const status = useGlobalShortcutStatus((s) => s[k]);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const acc = acceleratorFromEvent(e, platform);
      if (!acc) return; // a modifier on its own: keep listening
      const problem = problemFor(k, acc, settings);
      if (problem) {
        setError(`${formatAccelerator(acc, platform)}: ${problem}`);
        return;
      }
      setError(null);
      setRecording(false);
      run(saveSettings({ [k]: acc } as Partial<Settings>));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, k, settings]);

  const statusText =
    status.state === 'active' ? 'Active' : status.state === 'off' ? 'Off' : status.reason;
  return (
    <div className="border-b border-line/60 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[13px]">{label}</span>
        <button
          type="button"
          aria-label={`${label}: ${value ? formatAccelerator(value, platform) : 'off'}. Press to change`}
          onClick={() => {
            setError(null);
            setRecording(true);
          }}
          className={cn(
            'min-w-[150px] rounded-md border px-2 py-1 text-[12px]',
            recording
              ? 'border-accent bg-accent-soft text-accent-text'
              : 'border-line hover:border-line-strong',
          )}
        >
          {recording ? (
            'Press keys…'
          ) : value ? (
            <Kbd className="border-0 shadow-none">{formatAccelerator(value, platform)}</Kbd>
          ) : (
            'Off'
          )}
        </button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!value}
          onClick={() => run(saveSettings({ [k]: '' } as Partial<Settings>))}
        >
          Turn off
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={value === DEFAULT_SETTINGS[k]}
          onClick={() => run(saveSettings({ [k]: DEFAULT_SETTINGS[k] } as Partial<Settings>))}
        >
          <RotateCcw size={12} /> Default
        </Button>
      </div>
      <p
        role="status"
        className={cn(
          'mt-1 text-[12px]',
          status.state === 'active'
            ? 'text-muted'
            : status.state === 'off'
              ? 'text-subtle'
              : 'text-danger',
        )}
      >
        {error ?? statusText}
      </p>
    </div>
  );
}

function FocusBarSettings() {
  const [onTimer, setOnTimer] = useSetting('focusBarOnTimerStart');
  const [onFocus, setOnFocus] = useSetting('focusBarOnFocus');
  const visible = useUi((s) => s.barVisible);
  const desktop = isTauri();
  const [wayland, setWayland] = useState(false);
  useEffect(() => {
    void native.environment().then((env) => setWayland(env.wayland));
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <Card title="Focus bar">
        <p className="pb-2 text-[12px] text-muted">
          A small window that stays above your other apps and shows the task you are working on with
          its timer. Hiding it never stops the timer.
        </p>
        <Field
          label="Focus bar"
          hint="Drag it anywhere. Keel remembers the spot and keeps it on screen."
        >
          <Button
            size="sm"
            variant="secondary"
            disabled={!desktop}
            onClick={() => void toggleBar()}
          >
            {visible ? 'Hide focus bar' : 'Show focus bar'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!desktop}
            onClick={() => void resetBarPosition()}
          >
            <RotateCcw size={13} /> Reset position
          </Button>
        </Field>
        <Field label="Show automatically">
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-[13px]">
              <Switch
                checked={onTimer}
                onCheckedChange={setOnTimer}
                label="Show when a timer starts"
              />
              When a timer starts
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch
                checked={onFocus}
                onCheckedChange={setOnFocus}
                label="Show when Focus mode opens"
              />
              When I open Focus mode
            </label>
          </div>
        </Field>
        {wayland && (
          <p className="mb-3 rounded-lg bg-warn-soft px-3 py-2 text-[12.5px]">
            You are using a Wayland session. Wayland does not let apps keep a window above others or
            listen for system-wide shortcuts, so the bar may be covered by other windows and the
            shortcuts below will not fire. An X11 session supports both.
          </p>
        )}
      </Card>
      <Card title="System-wide shortcuts">
        <p className="pb-1 text-[12px] text-muted">
          These work while another app is in front. Click a shortcut, then press the new keys (Esc
          cancels). Keel checks them against its own shortcuts, each other and combinations the
          system reserves; if another app already owns one, it shows here as unavailable.
        </p>
        {GLOBAL_SHORTCUTS.map((g) => (
          <GlobalShortcutRow key={g.key} k={g.key} label={g.label} />
        ))}
      </Card>
    </div>
  );
}

function DeleteAllDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Delete all data" width={460}>
      <div className="flex flex-col gap-3 px-5 pt-2 pb-5 text-[13px]">
        <p className="flex gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-fg">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
          This permanently deletes every task, project, calendar event, time record, reflection and
          setting, all automatic backups, and any integration credentials stored in the system
          credential store. It cannot be undone. Backup files you exported elsewhere are not
          touched.
        </p>
        <Label htmlFor="del-confirm">Type DELETE to confirm</Label>
        <Input id="del-confirm" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={text !== 'DELETE' || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { deleteAllIntegrationSecrets } = await import('@/integrations/manager');
                await deleteAllIntegrationSecrets();
                await native.wipe();
                location.reload();
              } catch (e) {
                toast.error(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            Delete everything
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function DataPrivacy() {
  const [autoBackup, setAutoBackup] = useSetting('autoBackup');
  const lastAuto = useData((s) => s.settings.lastAutoBackupAt);
  const zone = useData((s) => s.zone);
  const hour12 = useData((s) => s.settings.hour12);
  const stamp = (ms: number) => formatDateTime(new Date(ms).toISOString(), zone, hour12);
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [confirmRestore, setConfirmRestore] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const desktop = isTauri();

  const reload = async () => {
    setInfo(await native.dbInfo());
    setBackups(await native.listBackups());
  };
  useEffect(() => {
    void reload();
  }, []);

  const save = async (
    name: string,
    filter: string,
    ext: string,
    contents: string | Promise<string>,
  ) => {
    try {
      const path = await native.saveText(name, filter, [ext], await contents);
      if (path) toast.success(`Saved ${path}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <Card title="Where your data lives">
        <Field
          label="Database"
          hint="A single SQLite file on this computer. Keel has no server and no account."
        >
          {desktop ? (
            <div className="selectable flex flex-col text-[12.5px]">
              <code className="rounded bg-sunken px-1.5 py-0.5">{info?.path ?? '…'}</code>
              <span className="mt-1 text-muted">
                {info
                  ? `${formatBytes(info.sizeBytes)} · SQLite ${info.sqliteVersion} · schema v${LATEST_SCHEMA_VERSION}`
                  : ''}
              </span>
            </div>
          ) : (
            <span className="text-[12.5px] text-warn">
              Browser preview: data is in memory only and is lost on reload.
            </span>
          )}
        </Field>
        <Field label="Encryption at rest" hint="How your data is protected on disk.">
          <p className="max-w-[480px] text-[12.5px] text-muted">
            <ShieldCheck size={14} className="mr-1 inline text-accent-text" />
            Keel relies on your operating system’s disk encryption. On Windows, turn on{' '}
            <strong>BitLocker</strong> or <strong>Device encryption</strong> (Settings → Privacy
            &amp; security → Device encryption). The database sits in your user profile, which other
            Windows accounts cannot read. Integration tokens are stored in Windows Credential
            Manager, never in the database.
          </p>
        </Field>
        <Field label="Network" hint="What leaves this computer.">
          <p className="max-w-[480px] text-[12.5px] text-muted">
            Nothing, unless you connect an integration. Integrations only talk to the provider you
            connected (listed on the Integrations page). No analytics, telemetry or crash reports
            are sent.
          </p>
        </Field>
      </Card>

      <Card title="Backups">
        <Field
          label="Automatic backups"
          hint={`Once a day, the last 14 are kept.${lastAuto ? ` Last: ${stamp(new Date(lastAuto).getTime())}.` : ''}`}
        >
          <Switch
            label="Automatic backups"
            checked={autoBackup}
            onCheckedChange={setAutoBackup}
            disabled={!desktop}
          />
        </Field>
        <Field label="Back up now">
          <Button
            size="sm"
            variant="secondary"
            disabled={!desktop}
            onClick={async () => {
              try {
                await native.createBackup('manual');
                toast.success('Backup created');
                await reload();
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            <Database size={14} /> Create backup
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!desktop}
            onClick={async () => {
              try {
                const p = await native.exportBackup(exportFileName('backup', 'sqlite3'));
                if (p) toast.success(`Backup saved to ${p}`);
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            <Download size={14} /> Save backup file…
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!desktop}
            onClick={async () => {
              try {
                const r = await native.importBackup(LATEST_SCHEMA_VERSION);
                if (r) {
                  toast.success('Restored. Reloading…');
                  setTimeout(() => location.reload(), 600);
                }
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            <Upload size={14} /> Restore from file…
          </Button>
        </Field>
        {backups.length > 0 && (
          <div className="max-h-64 overflow-y-auto border-t border-line/70 py-2">
            {backups.map((b) => (
              <div key={b.fileName} className="flex h-9 items-center gap-3 text-[12.5px]">
                <HardDrive size={14} className="text-subtle" />
                <span className="flex-1 tabular">{stamp(b.createdMs)}</span>
                <span className="text-muted">{b.reason}</span>
                <span className="w-16 text-right text-muted tabular">
                  {formatBytes(b.sizeBytes)}
                </span>
                <Button size="xs" variant="ghost" onClick={() => setConfirmRestore(b)}>
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="pb-3 text-[12px] text-subtle">
          Restoring first saves a safety backup of your current data, so a restore can itself be
          undone.
        </p>
      </Card>

      <Card title="Export">
        <Field
          label="Everything (JSON)"
          hint="Complete, documented format for moving your data elsewhere."
        >
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void save(exportFileName('export', 'json'), 'JSON', 'json', buildJsonExport())
            }
          >
            <Download size={14} /> Export JSON
          </Button>
        </Field>
        <Field label="Tasks (CSV)" hint="Opens in Excel or any spreadsheet.">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void save(exportFileName('tasks', 'csv'), 'CSV', 'csv', buildTasksCsv())}
          >
            <Download size={14} /> Export CSV
          </Button>
        </Field>
        <Field label="Calendar (.ics)" hint="Events from all calendars plus your time blocks.">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void save(
                exportFileName('calendar', 'ics'),
                'iCalendar',
                'ics',
                buildCalendarIcs(Object.keys(useData.getState().calendars), true, 'Keel'),
              )
            }
          >
            <Download size={14} /> Export .ics
          </Button>
        </Field>
      </Card>

      <Card title="Delete all data">
        <Field label="Start over" hint="Removes everything Keel stores on this computer.">
          <Button size="sm" variant="danger" onClick={() => setDeleting(true)} disabled={!desktop}>
            Delete all data…
          </Button>
        </Field>
      </Card>

      <DeleteAllDialog open={deleting} onClose={() => setDeleting(false)} />
      <Dialog
        open={!!confirmRestore}
        onOpenChange={(o) => !o && setConfirmRestore(null)}
        title="Restore this backup?"
        width={420}
      >
        <div className="flex flex-col gap-3 px-5 pt-2 pb-5 text-[13px]">
          <p>
            Your data will be replaced with the backup from{' '}
            <strong>{confirmRestore && stamp(confirmRestore.createdMs)}</strong>. A safety backup of
            the current data is saved first.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmRestore(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await native.restoreBackup(confirmRestore!.fileName, LATEST_SCHEMA_VERSION);
                  toast.success('Restored. Reloading…');
                  setTimeout(() => location.reload(), 600);
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              Restore
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function About() {
  const [env, setEnv] = useState<{ os: string; version: string } | null>(null);
  useEffect(() => {
    void native.environment().then(setEnv);
  }, []);
  return (
    <Card title="About Keel">
      <Field label="Version">
        <span className="text-[13px]">
          {env?.version ?? '…'} ({env?.os ?? ''})
        </span>
      </Field>
      <Field label="Privacy">
        <p className="max-w-[480px] text-[12.5px] text-muted">
          Keel is local-first: it needs no account, works offline, and collects no analytics. See
          the README for the full privacy model and integration data flows.
        </p>
      </Field>
      <Field label="Keyboard">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => useUi.setState({ shortcutsOpen: true })}
        >
          Show shortcuts
        </Button>
      </Field>
      <UpdatesField />
    </Card>
  );
}

function UpdatesField() {
  const desktop = isTauri();
  const open = useUi((s) => s.updatesOpen);
  const [hasToken, setHasToken] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    void updates
      .status()
      .then((s) => setHasToken(s.hasToken))
      .catch(() => undefined);
  }, [desktop, open]);
  return (
    <Field
      label="Updates"
      hint="Keel never checks by itself. Checking asks GitHub (api.github.com) with your read-only token."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!desktop}
          onClick={() => useUi.setState({ updatesOpen: true })}
        >
          Update Keel…
        </Button>
        {hasToken && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await updates.forgetToken();
                setHasToken(false);
                toast.success('GitHub token removed from the credential store');
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Remove GitHub token
          </Button>
        )}
      </div>
    </Field>
  );
}

export function SettingsView({ section }: { section?: string }) {
  const [active, setActive] = useState(section ?? 'general');
  useEffect(() => {
    if (section) setActive(section);
  }, [section]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Settings" />
      <div className="flex min-h-0 flex-1 gap-6 px-4">
        <nav aria-label="Settings sections" className="flex w-44 shrink-0 flex-col gap-px">
          {SECTIONS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActive(id)}
              aria-current={active === id ? 'page' : undefined}
              className={cn(
                'h-8 rounded-lg px-3 text-left text-[13px]',
                active === id
                  ? 'bg-surface font-medium text-fg shadow-sm'
                  : 'text-muted hover:bg-surface/60 hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto pb-10">
          <div className="flex max-w-[820px] flex-col gap-4">
            {active === 'general' && <General />}
            {active === 'planning' && <Planning />}
            {active === 'notifications' && <Notifications />}
            {active === 'shortcuts' && <Shortcuts />}
            {active === 'focusbar' && <FocusBarSettings />}
            {active === 'data' && <DataPrivacy />}
            {active === 'about' && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}
