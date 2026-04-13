import type { Db } from '../db/index.js';
import { generateId } from '../db/index.js';
import type { EventRecord, EventType } from '../types/index.js';

// --------------- Row helper ----------------------------------

function rowToEvent(r: Record<string, unknown>): EventRecord {
  return {
    id: r['id'] as string,
    type: r['type'] as EventType,
    payload: JSON.parse(r['payload_json'] as string) as Record<string, unknown>,
    createdAt: r['created_at'] as number,
  };
}

// --------------- EventLogService ----------------------------

export class EventLogService {
  constructor(private db: Db) {}

  log(type: EventType, payload: Record<string, unknown>): void {
    this.db
      .prepare<[string, string, string, number], void>(
        'INSERT INTO events (id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(generateId(), type, JSON.stringify(payload), Date.now());
  }

  recent(limit = 50): EventRecord[] {
    return this.db
      .prepare<[number], Record<string, unknown>>(
        'SELECT * FROM events ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit)
      .map(rowToEvent);
  }

  recentByType(type: EventType, limit = 20): EventRecord[] {
    return this.db
      .prepare<[string, number], Record<string, unknown>>(
        'SELECT * FROM events WHERE type = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(type, limit)
      .map(rowToEvent);
  }

  since(timestamp: number): EventRecord[] {
    return this.db
      .prepare<[number], Record<string, unknown>>(
        'SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC',
      )
      .all(timestamp)
      .map(rowToEvent);
  }
}
