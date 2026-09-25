/**
 * Trello. Auth: API key + token (trello.com/power-ups/admin). Reads open cards assigned to
 * you. Trello has no "done" state for cards, so completing in Keel marks the card's due
 * date complete (dueComplete) when write-back is enabled.
 */
import { expectOk, getJson, qs } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';

const API = 'https://api.trello.com/1';

export interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  due?: string | null;
  dueComplete?: boolean;
  url?: string;
  idBoard?: string;
  dateLastActivity?: string;
}

export function mapTrelloCard(c: TrelloCard, boards: Map<string, string>): RemoteTask {
  return {
    externalId: c.id,
    title: c.name,
    notes: c.desc ?? '',
    url: c.url ?? null,
    dueDate: c.due ? c.due.slice(0, 10) : null,
    completed: !!c.dueComplete,
    priority: 0,
    estimateMin: null,
    container: c.idBoard ? (boards.get(c.idBoard) ?? null) : null,
    version: c.dateLastActivity ?? `${c.name}|${c.due}`,
  };
}

export const trello: TaskAdapter = {
  async fetchOpenTasks(http: Http) {
    const boards: { id: string; name: string }[] = await getJson(
      http,
      `${API}/members/me/boards${qs({ fields: 'name', filter: 'open' })}`,
      'List Trello boards',
    );
    const names = new Map(boards.map((b) => [b.id, b.name]));
    const cards: TrelloCard[] = await getJson(
      http,
      `${API}/members/me/cards${qs({ filter: 'open', fields: 'name,desc,due,dueComplete,url,idBoard,dateLastActivity' })}`,
      'List Trello cards',
    );
    return cards.filter((c) => !c.dueComplete).map((c) => mapTrelloCard(c, names));
  },
  async setCompleted(http, _config, externalId, done) {
    expectOk(
      await http({
        method: 'PUT',
        url: `${API}/cards/${encodeURIComponent(externalId)}${qs({ dueComplete: done })}`,
      }),
      'Update Trello card',
    );
  },
};
