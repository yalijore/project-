import { run, stopTimer, undo } from '@/data/actions';
import { runningSession } from '@/data/selectors';
import { getData } from '@/data/store';
import { addDays, startOfWeek } from '@/domain/dates';
import { ui, useUi } from './ui';

export function runCommand(id: string): boolean {
  const { today, settings } = getData();
  const state = useUi.getState();
  const overlayOpen =
    state.captureOpen ||
    state.paletteOpen ||
    !!state.openTaskId ||
    !!state.ritual ||
    !!state.focusTaskId;
  const shiftBoard = (delta: number) => {
    const start = state.boardStart ?? today;
    useUi.setState({
      boardStart: addDays(start, delta),
      panelDate: addDays(state.panelDate ?? today, delta),
    });
  };
  switch (id) {
    case 'capture':
      ui.capture();
      return true;
    case 'palette':
      useUi.setState({ paletteOpen: !state.paletteOpen });
      return true;
    case 'search':
      ui.navigate({ name: 'search' });
      return true;
    case 'undo':
      if (overlayOpen && !state.openTaskId) return false;
      run(undo());
      return true;
    case 'shortcuts':
      useUi.setState({ shortcutsOpen: true });
      return true;
    case 'toggleCalendar':
      useUi.setState({ calendarPanel: !state.calendarPanel });
      return true;
    case 'toggleSidebar':
      useUi.setState({ sidebar: !state.sidebar });
      return true;
    case 'go.today':
      ui.navigate({ name: 'today' });
      useUi.setState({ boardStart: today, panelDate: today });
      return true;
    case 'go.week':
      ui.navigate({ name: 'week' });
      return true;
    case 'go.inbox':
      ui.navigate({ name: 'inbox' });
      return true;
    case 'go.backlog':
      ui.navigate({ name: 'backlog' });
      return true;
    case 'go.completed':
      ui.navigate({ name: 'completed' });
      return true;
    case 'go.review':
      ui.navigate({ name: 'review' });
      return true;
    case 'go.settings':
      ui.navigate({ name: 'settings' });
      return true;
    case 'back':
      ui.back();
      return true;
    case 'day.prev':
    case 'day.next':
    case 'day.today': {
      if (overlayOpen) return false;
      if (state.view.name === 'week') {
        const ws = state.weekStart ?? startOfWeek(today, settings.weekStartsOn);
        const next =
          id === 'day.today'
            ? startOfWeek(today, settings.weekStartsOn)
            : addDays(ws, id === 'day.prev' ? -7 : 7);
        useUi.setState({ weekStart: next });
        return true;
      }
      if (state.view.name !== 'today') return false;
      if (id === 'day.today') useUi.setState({ boardStart: today, panelDate: today });
      else shiftBoard(id === 'day.prev' ? -1 : 1);
      return true;
    }
    case 'plan':
      ui.ritual({ kind: 'plan', date: today });
      return true;
    case 'shutdown':
      ui.ritual({ kind: 'shutdown', date: today });
      return true;
    case 'weekly':
      ui.ritual({ kind: 'weekly', date: startOfWeek(today, settings.weekStartsOn) });
      return true;
    case 'focus': {
      const running = runningSession(getData().sessions);
      if (!running) return false;
      ui.focus(running.taskId);
      return true;
    }
    case 'timer.stop':
      if (!runningSession(getData().sessions)) return false;
      run(stopTimer());
      return true;
  }
  return false;
}
