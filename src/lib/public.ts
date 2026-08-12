/** Shared loader for public, event-themed surfaces. */
import { one } from './db';
import { parseTheme } from './theme';
import type { Event, Theme } from '../types';

export type PublicEvent = { event: Event; theme: Theme };

export async function loadPublicEvent(db: D1Database, slug: string): Promise<PublicEvent | null> {
  const event = await one<Event>(db, `SELECT * FROM events WHERE slug = ?`, slug);
  if (!event) return null;
  return { event, theme: parseTheme(event.theme_json) };
}
