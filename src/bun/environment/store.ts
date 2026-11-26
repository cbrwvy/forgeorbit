/**
 * Persistence seam for environment profiles and the last runtime record.
 *
 * The memory implementation is what this core ships. A later task can store
 * the same JSON in SQLite without changing the manager. Records are cloned
 * on the way in and out so a caller cannot mutate the stored profile.
 */

import type { StoredEnvironment } from "../../shared/environment/types.ts";

export interface EnvironmentRepository {
  loadAll(): Promise<StoredEnvironment[]>;
  save(record: StoredEnvironment): Promise<void>;
  remove(profileId: string): Promise<void>;
}

export class MemoryEnvironmentStore implements EnvironmentRepository {
  private readonly records = new Map<string, StoredEnvironment>();

  async loadAll(): Promise<StoredEnvironment[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async save(record: StoredEnvironment): Promise<void> {
    this.records.set(record.profile.id, structuredClone(record));
  }

  async remove(profileId: string): Promise<void> {
    this.records.delete(profileId);
  }

  /** Test aid: how many rows are currently stored. */
  size(): number {
    return this.records.size;
  }
}
