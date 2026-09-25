import { useEffect, useState } from 'react';
import { Inbox, Sun } from 'lucide-react';
import { useUi } from '@/app/ui';
import { captureTask, run } from '@/data/actions';
import { useData } from '@/data/store';
import { Dialog, Kbd, Segmented } from '@/ui/primitives';
import { CaptureChips, useCaptureParse } from './CaptureChips';

type Destination = 'today' | 'inbox';

export function QuickCapture() {
  const open = useUi((s) => s.captureOpen);
  const defaults = useUi((s) => s.captureDefaults);
  const view = useUi((s) => s.view);
  const today = useData((s) => s.today);
  const [text, setText] = useState('');
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [dest, setDest] = useState<Destination>('today');
  const [added, setAdded] = useState(0);
  const parsed = useCaptureParse(text, disabled);

  useEffect(() => {
    if (!open) return;
    setText('');
    setDisabled(new Set());
    setAdded(0);
    setDest(
      defaults.planDate === undefined && ['today', 'week'].includes(view.name) ? 'today' : 'inbox',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => useUi.setState({ captureOpen: false });

  const submit = (keepOpen: boolean) => {
    if (!parsed.title) return;
    const planDate =
      defaults.planDate !== undefined ? defaults.planDate : dest === 'today' ? today : null;
    run(captureTask(parsed, { ...defaults, planDate }));
    setText('');
    setDisabled(new Set());
    setAdded((n) => n + 1);
    if (!keepOpen) close();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Add a task"
      hideTitle
      width={600}
      className="top-[18vh]"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
        className="p-4"
      >
        <input
          autoFocus
          aria-label="Task"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.shiftKey) {
              e.preventDefault();
              submit(true);
            }
          }}
          placeholder="What needs doing?"
          className="w-full bg-transparent text-[17px] text-fg outline-none placeholder:text-subtle"
        />
        <CaptureChips
          parsed={parsed}
          onDisable={(k) => setDisabled(new Set([...disabled, k]))}
          className="mt-2 min-h-5"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
          {defaults.planDate === undefined && parsed.planDate === undefined && (
            <Segmented<Destination>
              label="Add to"
              size="xs"
              value={dest}
              onChange={setDest}
              options={[
                {
                  value: 'today',
                  label: (
                    <span className="flex items-center gap-1">
                      <Sun size={12} /> Today
                    </span>
                  ),
                },
                {
                  value: 'inbox',
                  label: (
                    <span className="flex items-center gap-1">
                      <Inbox size={12} /> Inbox
                    </span>
                  ),
                },
              ]}
            />
          )}
          <span className="text-[11.5px] text-subtle">
            Try <code>45m</code> <code>tomorrow</code> <code>#project</code> <code>@tag</code>{' '}
            <code>!high</code> <code>due fri</code> <code>at 3pm</code> <code>every mon</code>
          </span>
          <span className="ml-auto flex items-center gap-1 text-[11.5px] text-subtle">
            {added > 0 && <span className="mr-2 text-accent-text">{added} added</span>}
            <Kbd>Enter</Kbd> add · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> add another
          </span>
        </div>
      </form>
    </Dialog>
  );
}
