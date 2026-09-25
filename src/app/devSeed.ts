/**
 * Dev-only sample data for the browser preview (`npm run dev:web` then open `/?demo`).
 * Never bundled into the desktop app's data path.
 */
import { perform } from '@/data/actions';
import * as rec from '@/data/recurrenceRepo';
import * as repo from '@/data/repo';
import { getData } from '@/data/store';
import { addDays, addMinutes, wallTimeToInstant } from '@/domain/dates';

export async function seedDemo() {
  const { today, zone, settings } = getData();
  const at = (date: string, h: number, m = 0) => wallTimeToInstant(date, h * 60 + m, zone);
  await perform({ label: null, quiet: true }, async (ctx) => {
    const work = await repo.createArea(ctx, 'Work', '#2F8F83');
    const home = await repo.createArea(ctx, 'Personal', '#C0587E');
    const launch = await repo.createProject(ctx, {
      name: 'Q4 Launch',
      color: '#3E7CB1',
      areaId: work,
    });
    const site = await repo.createProject(ctx, {
      name: 'Website refresh',
      color: '#7A5EA8',
      areaId: work,
    });
    const deep = await repo.createTag(ctx, 'deep-work', '#D1703C');
    const calls = await repo.createTag(ctx, 'calls', '#5E8C3A');

    const t1 = await repo.createTask(ctx, {
      title: 'Draft launch announcement',
      projectId: launch,
      estimateMin: 60,
      planDate: today,
      priority: 3,
      tagIds: [deep],
      dueDate: addDays(today, 2),
      subtasks: ['Outline key messages', 'Write first draft', 'Get feedback from Sam'],
      notes: 'Focus on the three customer stories from the beta.',
    });
    await repo.createBlock(ctx, t1, at(today, 9, 30), at(today, 10, 30));
    await repo.createTask(ctx, {
      title: 'Review pricing page copy',
      projectId: site,
      estimateMin: 30,
      planDate: today,
    });
    const t3 = await repo.createTask(ctx, {
      title: 'Reply to vendor emails',
      areaId: work,
      estimateMin: 20,
      planDate: today,
      tagIds: [calls],
    });
    await repo.completeTask(ctx, t3);
    await repo.createTask(ctx, {
      title: 'Book dentist appointment',
      areaId: home,
      estimateMin: 10,
      planDate: today,
    });
    await repo.createTask(ctx, {
      title: 'Prepare board slides',
      projectId: launch,
      estimateMin: 90,
      planDate: addDays(today, 1),
      priority: 2,
    });
    await repo.createTask(ctx, {
      title: 'Plan team offsite agenda',
      areaId: work,
      estimateMin: 45,
      planDate: addDays(today, 2),
    });
    await repo.createTask(ctx, {
      title: 'Research analytics vendors',
      projectId: site,
      estimateMin: 60,
    });
    await repo.createTask(ctx, {
      title: 'Renew passport',
      areaId: home,
      dueDate: addDays(today, 20),
    });
    await repo.createTask(ctx, { title: 'Try the new espresso grinder settings' });

    const series = await rec.createSeries(ctx, {
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      dtstart: today,
      title: 'Inbox zero',
      areaId: work,
      estimateMin: 15,
    });
    await rec.materializeDue(ctx, today);
    void series;

    const cal = settings.defaultCalendarId ?? (await repo.loadCalendars(ctx.tx))[0]!.id;
    await repo.createEvent(ctx, {
      calendarId: cal,
      title: 'Team standup',
      allDay: false,
      startUtc: at(today, 9),
      endUtc: at(today, 9, 15),
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      tz: zone,
    });
    await repo.createEvent(ctx, {
      calendarId: cal,
      title: 'Design review',
      allDay: false,
      startUtc: at(today, 11),
      endUtc: at(today, 12),
      location: 'Room 4',
    });
    await repo.createEvent(ctx, {
      calendarId: cal,
      title: 'Lunch with Priya',
      allDay: false,
      startUtc: at(today, 12, 30),
      endUtc: addMinutes(at(today, 12, 30), 60),
    });
    await repo.createEvent(ctx, {
      calendarId: cal,
      title: '1:1 with Alex',
      allDay: false,
      startUtc: at(today, 15),
      endUtc: at(today, 15, 30),
    });
    await repo.createEvent(ctx, {
      calendarId: cal,
      title: 'Company holiday',
      allDay: true,
      startDate: addDays(today, 4),
      endDate: addDays(today, 5),
    });
    await repo.saveSettings(ctx, { onboarded: true });
  });
}
