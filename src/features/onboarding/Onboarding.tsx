import { useState } from 'react';
import { Bell, HardDrive, ShieldCheck, WifiOff } from 'lucide-react';
import { createArea, run, saveSettings } from '@/data/actions';
import { useData } from '@/data/store';
import { formatDuration, parseClock } from '@/domain/dates';
import { requestNotificationPermission } from '@/app/notify';
import { Button, Dialog, Input, Label, Segmented, cn } from '@/ui/primitives';

const DAYS = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [7, 'Sun'],
] as const;

const SUGGESTED_AREAS = ['Work', 'Personal', 'Health', 'Learning', 'Home'];

export function WorkingDaysPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (v: number[]) => void;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label="Working days">
      {DAYS.map(([d, label]) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}
            className={cn(
              'h-8 w-11 rounded-lg text-[12.5px] font-medium transition-colors',
              on ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function Onboarding() {
  const settings = useData((s) => s.settings);
  const areas = useData((s) => s.areas);
  const [step, setStep] = useState(0);
  const [workingDays, setWorkingDays] = useState(settings.workingDays);
  const [start, setStart] = useState(settings.workdayStart);
  const [end, setEnd] = useState(settings.workdayEnd);
  const [capacityH, setCapacityH] = useState(String(settings.dailyCapacityMin / 60));
  const [hour12, setHour12] = useState(settings.hour12);
  const [weekStartsOn, setWeekStartsOn] = useState(settings.weekStartsOn);
  const [picked, setPicked] = useState<Set<string>>(new Set(['Work', 'Personal']));
  const [notify, setNotify] = useState<'idle' | 'granted' | 'denied'>('idle');

  const workdayMin = (() => {
    try {
      return parseClock(end) - parseClock(start);
    } catch {
      return 0;
    }
  })();

  const finish = async () => {
    const capacity = Math.max(0.5, Math.min(16, Number(capacityH) || 6));
    // Areas first, so onboarding only counts as finished once everything it set up exists.
    const existing = new Set(Object.values(areas).map((a) => a.name.toLowerCase()));
    for (const name of picked) if (!existing.has(name.toLowerCase())) await createArea(name);
    await saveSettings({
      workingDays,
      workdayStart: start,
      workdayEnd: end,
      dailyCapacityMin: Math.round(capacity * 60),
      hour12,
      weekStartsOn,
      notificationsEnabled: notify === 'granted',
      onboarded: true,
    });
  };

  const steps = [
    <div key="welcome" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <img src="/keel.svg" alt="" className="h-12 w-12" />
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">Welcome to Keel</h2>
          <p className="text-[13px] text-muted">A calm planner for realistic days.</p>
        </div>
      </div>
      <p className="text-[13.5px] text-fg">
        Each morning, choose a realistic amount of work and give it a place on your calendar. During
        the day, focus on one thing at a time. In the evening, close the day and decide what carries
        over.
      </p>
      <ul className="flex flex-col gap-2.5 text-[13px] text-muted">
        <li className="flex gap-2.5">
          <HardDrive size={16} className="mt-0.5 shrink-0 text-accent-text" /> Your data lives in a
          database file on this computer. There is no account and no sign-in.
        </li>
        <li className="flex gap-2.5">
          <WifiOff size={16} className="mt-0.5 shrink-0 text-accent-text" /> Keel works fully
          offline and sends no analytics or telemetry.
        </li>
        <li className="flex gap-2.5">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-accent-text" /> Calendar and task
          integrations are optional. Keel only connects to them if you turn them on.
        </li>
      </ul>
    </div>,
    <div key="workday" className="flex flex-col gap-4">
      <div>
        <h2 className="text-[18px] font-semibold">Your workday</h2>
        <p className="text-[13px] text-muted">
          Keel uses this to spot overcommitted days and to find free time. You can change it later
          in Settings.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Working days</Label>
        <WorkingDaysPicker value={workingDays} onChange={setWorkingDays} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ob-start">Starts</Label>
          <Input
            id="ob-start"
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ob-end">Ends</Label>
          <Input id="ob-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ob-cap">Focus hours / day</Label>
          <Input
            id="ob-cap"
            type="number"
            min={0.5}
            max={16}
            step={0.5}
            value={capacityH}
            onChange={(e) => setCapacityH(e.target.value)}
          />
        </div>
      </div>
      <p className="-mt-2 text-[12px] text-subtle">
        {workdayMin > 0
          ? `Workday is ${formatDuration(workdayMin)}.`
          : 'The end time should be after the start time.'}{' '}
        “Focus hours” is how much planned work (tasks plus meetings) fits in a day before Keel warns
        you.
      </p>
      <div className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-1.5">
          <Label>Week starts on</Label>
          <Segmented<number>
            label="Week starts on"
            size="xs"
            value={weekStartsOn}
            onChange={setWeekStartsOn}
            options={[
              { value: 1, label: 'Monday' },
              { value: 7, label: 'Sunday' },
              { value: 6, label: 'Saturday' },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Time format</Label>
          <Segmented<string>
            label="Time format"
            size="xs"
            value={hour12 ? '12' : '24'}
            onChange={(v) => setHour12(v === '12')}
            options={[
              { value: '24', label: '13:00' },
              { value: '12', label: '1:00 pm' },
            ]}
          />
        </div>
      </div>
    </div>,
    <div key="areas" className="flex flex-col gap-4">
      <div>
        <h2 className="text-[18px] font-semibold">Areas of your life</h2>
        <p className="text-[13px] text-muted">
          Areas group projects and tasks. Pick a few to start with, or skip — you can add them
          anytime.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {SUGGESTED_AREAS.map((name) => {
          const on = picked.has(name);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = new Set(picked);
                if (on) next.delete(name);
                else next.add(name);
                setPicked(next);
              }}
              className={cn(
                'h-8 rounded-full px-3.5 text-[13px] font-medium transition-colors',
                on ? 'bg-accent text-accent-fg' : 'bg-sunken text-muted hover:text-fg',
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
    </div>,
    <div key="notify" className="flex flex-col gap-4">
      <div>
        <h2 className="text-[18px] font-semibold">Reminders</h2>
        <p className="text-[13px] text-muted">
          Keel can send desktop notifications when a time block starts or you reach a task’s
          estimate. Windows will ask you to allow them. You can turn them off anytime.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button
          variant={notify === 'granted' ? 'secondary' : 'primary'}
          onClick={async () => {
            const p = await requestNotificationPermission();
            setNotify(p === 'granted' ? 'granted' : 'denied');
          }}
          disabled={notify === 'granted'}
        >
          <Bell size={15} />{' '}
          {notify === 'granted' ? 'Notifications allowed' : 'Allow notifications'}
        </Button>
        {notify === 'denied' && (
          <span className="text-[12.5px] text-muted">
            Not allowed. You can enable them later in your system settings.
          </span>
        )}
      </div>
      <p className="text-[12.5px] text-subtle">
        Skip this if you prefer a quiet app — everything else works without notifications.
      </p>
    </div>,
  ];

  const last = step === steps.length - 1;
  return (
    <Dialog open onOpenChange={() => undefined} title="Set up Keel" hideTitle width={560}>
      <div className="px-7 pt-7 pb-6">
        {steps[step]}
        <div className="mt-7 flex items-center gap-2">
          <div className="flex gap-1.5" aria-hidden>
            {steps.map((_, i) => (
              <span
                key={i}
                className={cn('h-1.5 w-6 rounded-full', i <= step ? 'bg-accent' : 'bg-line')}
              />
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button
              variant="primary"
              disabled={step === 1 && (workingDays.length === 0 || workdayMin <= 0)}
              onClick={() => (last ? run(finish()) : setStep(step + 1))}
            >
              {last ? 'Start planning' : 'Continue'}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
