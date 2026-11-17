import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

export type FactoryQuery = Record<string, unknown>;
export type Page = { limit: number; offset: number };

export function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) throw new BadRequestException('Invalid ' + name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new BadRequestException('Invalid ' + name);
  return parsed;
}

export function page(query: FactoryQuery): Page {
  return { limit: integer(query.limit, 25, 1, 100, 'limit'),
    offset: integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset') };
}

export function filter(query: FactoryQuery, key: string): string | undefined {
  const value = query[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001F]/.test(value)) throw new BadRequestException('Invalid ' + key);
  return value;
}

/** SQL fragments are constants owned by callers. Request data is only ever passed as a parameter. */
export class Conditions {
  readonly terms: string[] = [];
  readonly values: string[] = [];

  bind(value: string): string { this.values.push(value); return '$' + this.values.length; }

  equals(column: string, value: string | undefined): void {
    if (value !== undefined) this.terms.push(column + ' = ' + this.bind(value));
  }

  sql(): string { return this.terms.length ? ' WHERE ' + this.terms.join(' AND ') : ''; }
}

export async function readPage<Row>(db: EntityManager, columns: string, from: string, orderBy: string, conditions: Conditions, paging: Page) {
  const matching = from + conditions.sql();
  const [{ total }] = await db.query<Array<{ total: string }>>('SELECT count(*) AS total ' + matching, conditions.values);
  const selected = `SELECT ${columns} ${matching} ORDER BY ${orderBy} LIMIT $${conditions.values.length + 1} OFFSET $${conditions.values.length + 2}`;
  const items = await db.query<Row[]>(selected, [...conditions.values, paging.limit, paging.offset]);
  return { items, total: Number(total), ...paging, observedAt: new Date().toISOString() };
}
