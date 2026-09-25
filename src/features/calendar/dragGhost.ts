import { create } from 'zustand';
import type { ISODate } from '@/domain/dates';

/** Preview of where a task dragged from a list would be timeboxed. */
export interface DragGhost {
  date: ISODate;
  startMin: number;
  durationMin: number;
  title: string;
}

export const useDragGhost = create<{ ghost: DragGhost | null }>(() => ({ ghost: null }));
