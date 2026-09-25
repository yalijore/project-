import { useMemo } from 'react';
import { Globe2, MoonStar } from 'lucide-react';
import { useUi } from '@/app/ui';
import { perform, resolveGap, run } from '@/data/actions';
import { rebaseBlocksToZone, saveSettings } from '@/data/repo';
import { useData } from '@/data/store';
import { formatDuration, formatTime } from '@/domain/dates';
import { Button, Dialog } from '@/ui/primitives';

/** Asks what to do with time the timer ran while the computer slept or Keel was closed. */
export function GapDialog() {
  const gap = useUi((s) => s.gapPrompt);
  const task = useData((s) => (gap ? s.tasks[gap.taskId] : undefined));
  const zone = useData((s) => s.zone);
  const hour12 = useData((s) => s.settings.hour12);
  if (!gap) return null;
  const decide = (d: 'keep' | 'discard' | 'discard-stop') => {
    run(
      resolveGap(d, gap.gapStart, gap.sessionId).finally(() => useUi.setState({ gapPrompt: null })),
    );
  };
  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      title="Were you working the whole time?"
      description={`The timer for “${task?.title ?? 'a task'}” kept running while Keel was asleep or closed.`}
      width={460}
    >
      <div className="flex flex-col gap-4 px-5 pt-2 pb-5">
        <div className="flex items-center gap-3 rounded-xl bg-sunken px-3 py-2.5 text-[13px]">
          <MoonStar size={18} className="text-accent-text" />
          <span>
            No activity since <strong>{formatTime(gap.gapStart, zone, hour12)}</strong> — about{' '}
            <strong>{formatDuration(gap.gapMinutes)}</strong>.
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <Button variant="primary" onClick={() => decide('discard')}>
            Discard that time, keep timing from now
          </Button>
          <Button variant="secondary" onClick={() => decide('discard-stop')}>
            Discard that time and stop the timer
          </Button>
          <Button variant="ghost" onClick={() => decide('keep')}>
            Keep it — I was working
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Shown when the system time zone changed since Keel last ran. Time blocks keep their
 * absolute time until the user chooses; planned days and deadlines never move.
 */
export function ZoneChangeBanner() {
  const change = useUi((s) => s.zoneChange);
  const blocks = useData((s) => s.blocks);
  const tasks = useData((s) => s.tasks);
  const hour12 = useData((s) => s.settings.hour12);
  const upcoming = useMemo(() => {
    if (!change) return [];
    const now = Date.now();
    return Object.values(blocks).filter(
      (b) => Date.parse(b.startUtc) > now && b.tz === change.from && !tasks[b.taskId]?.completedAt,
    );
  }, [change, blocks, tasks]);
  if (!change) return null;

  const finish = (rebase: boolean) =>
    run(
      perform({ label: rebase ? 'Shift time blocks to new time zone' : null }, async (ctx) => {
        if (rebase)
          await rebaseBlocksToZone(
            ctx,
            change.from,
            upcoming.map((b) => b.id),
          );
        await saveSettings(ctx, { lastKnownZone: change.to });
      }).finally(() => useUi.setState({ zoneChange: null })),
    );

  const example = upcoming[0];
  return (
    <div
      role="alert"
      className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-[13px]"
    >
      <Globe2 size={18} className="text-accent-text" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          Your time zone changed from {change.from} to {change.to}.
        </div>
        <div className="text-[12.5px] text-muted">
          {upcoming.length === 0
            ? 'You have no upcoming time blocks, so nothing needs to change. Planned days and deadlines never move.'
            : `${upcoming.length} upcoming time block${upcoming.length === 1 ? '' : 's'} kept their absolute time${
                example
                  ? ` (e.g. ${formatTime(example.startUtc, change.from, hour12)} there is ${formatTime(example.startUtc, change.to, hour12)} here)`
                  : ''
              }. Planned days and deadlines don’t move.`}
        </div>
      </div>
      {upcoming.length > 0 ? (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => finish(false)}>
            Keep absolute times
          </Button>
          <Button size="sm" variant="primary" onClick={() => finish(true)}>
            Keep local clock times
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => finish(false)}>
          OK
        </Button>
      )}
    </div>
  );
}
