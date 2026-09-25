import { BoardView } from '@/features/board/BoardView';
import { CalendarsView } from '@/features/calendar/CalendarsView';
import { EventDialog } from '@/features/calendar/EventDialog';
import { WeekView } from '@/features/calendar/WeekView';
import { IntegrationsView } from '@/features/integrations/IntegrationsView';
import {
  AreaView,
  BacklogView,
  CompletedView,
  InboxView,
  ProjectView,
  TagView,
} from '@/features/lists/ListViews';
import { SearchView } from '@/features/lists/SearchView';
import { ReviewView } from '@/features/review/ReviewView';
import { SettingsView } from '@/features/settings/SettingsView';
import { useUi } from './ui';

export function ViewRouter() {
  const view = useUi((s) => s.view);
  let content;
  switch (view.name) {
    case 'today':
      content = <BoardView />;
      break;
    case 'week':
      content = <WeekView />;
      break;
    case 'inbox':
      content = <InboxView />;
      break;
    case 'backlog':
      content = <BacklogView />;
      break;
    case 'project':
      content = <ProjectView key={view.id} id={view.id} />;
      break;
    case 'area':
      content = <AreaView key={view.id} id={view.id} />;
      break;
    case 'tag':
      content = <TagView key={view.id} id={view.id} />;
      break;
    case 'search':
      content = <SearchView initialQuery={view.query} />;
      break;
    case 'completed':
      content = <CompletedView />;
      break;
    case 'review':
      content = <ReviewView />;
      break;
    case 'calendars':
      content = <CalendarsView />;
      break;
    case 'integrations':
      content = <IntegrationsView />;
      break;
    case 'settings':
      content = <SettingsView section={view.section} />;
      break;
  }
  return (
    <>
      <div className="min-h-0 flex-1">{content}</div>
      <EventDialog />
    </>
  );
}
