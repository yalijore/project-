import { useUi } from '@/app/ui';
import { PlanningRitual } from './PlanningRitual';
import { ShutdownRitual } from './ShutdownRitual';
import { WeeklyReview } from './WeeklyReview';

export function RitualOverlay() {
  const ritual = useUi((s) => s.ritual);
  if (!ritual) return null;
  if (ritual.kind === 'plan') return <PlanningRitual key={ritual.date} date={ritual.date} />;
  if (ritual.kind === 'shutdown') return <ShutdownRitual key={ritual.date} date={ritual.date} />;
  return <WeeklyReview key={ritual.date} weekStart={ritual.date} />;
}
