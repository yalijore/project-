/**
 * Trello. Auth: API key + token (trello.com/power-ups/admin). Reads open cards you are a
 * member of. Trello cards have no single "done" state, so completing in Keel (opt-in) does
 * what your board means by done, per account:
 *   - 'due'     tick the card's due date complete (default)
 *   - 'list'    move the card to a list with the name you give (e.g. “Done”) on its board;
 *               cards already in that list count as done
 *   - 'archive' archive (close) the card
 */
import { expectOk, getJson, qs } from '../http';
import type { Http, RemoteTask, TaskAdapter } from '../types';
import { IntegrationError } from '../types';

const API = 'https://api.trello.com/1';

export type TrelloDoneMode = 'due' | 'list' | 'archive';

export interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  due?: string | null;
  dueComplete?: boolean;
  url?: string;
  idBoard?: string;
  idList?: string;
  dateLastActivity?: string;
}

interface TrelloBoard {
  id: string;
  name: string;
  lists?: { id: string; name: string }[];
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

function doneMode(config: Record<string, unknown>): { mode: TrelloDoneMode; list: string } {
  const mode = (['due', 'list', 'archive'] as const).find((m) => m === config.trelloDone) ?? 'due';
  return { mode, list: String(config.trelloDoneList ?? 'Done').trim() || 'Done' };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function update(http: Http, cardId: string, params: Record<string, string | boolean>) {
  expectOk(
    await http({ method: 'PUT', url: `${API}/cards/${encodeURIComponent(cardId)}${qs(params)}` }),
    'Update Trello card',
  );
}

export const trello: TaskAdapter = {
  async fetchOpenTasks(http: Http, config) {
    const { mode, list } = doneMode(config);
    const boards: TrelloBoard[] = await getJson(
      http,
      `${API}/members/me/boards${qs({ fields: 'name', filter: 'open', lists: 'open', list_fields: 'name' })}`,
      'List Trello boards',
    );
    const names = new Map(boards.map((b) => [b.id, b.name]));
    const doneLists = new Set(
      mode === 'list'
        ? boards.flatMap((b) =>
            (b.lists ?? []).filter((l) => sameName(l.name, list)).map((l) => l.id),
          )
        : [],
    );
    const cards: TrelloCard[] = await getJson(
      http,
      `${API}/members/me/cards${qs({ filter: 'open', fields: 'name,desc,due,dueComplete,url,idBoard,idList,dateLastActivity' })}`,
      'List Trello cards',
    );
    return cards
      .filter((c) => !c.dueComplete && !(c.idList && doneLists.has(c.idList)))
      .map((c) => mapTrelloCard(c, names));
  },

  async setCompleted(http, config, externalId, done) {
    const { mode, list } = doneMode(config);
    if (mode === 'due') return update(http, externalId, { dueComplete: done });
    if (mode === 'archive') return update(http, externalId, { closed: done });
    if (!done)
      throw new IntegrationError(
        'Keel moved this card to a done list; move it back to the right list in Trello.',
        'provider',
      );
    const card: TrelloCard = await getJson(
      http,
      `${API}/cards/${encodeURIComponent(externalId)}${qs({ fields: 'idBoard,idList' })}`,
      'Read Trello card',
    );
    const lists: { id: string; name: string }[] = await getJson(
      http,
      `${API}/boards/${encodeURIComponent(card.idBoard ?? '')}/lists${qs({ filter: 'open', fields: 'name' })}`,
      'List Trello lists',
    );
    const target = lists.find((l) => sameName(l.name, list));
    if (!target)
      throw new IntegrationError(
        `This card's board has no list named “${list}”. Add one, or choose another way to complete cards.`,
        'config',
      );
    if (card.idList !== target.id) await update(http, externalId, { idList: target.id });
  },
};
