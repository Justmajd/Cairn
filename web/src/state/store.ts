/** Minimal observable store: `set` merges a patch and notifies subscribers with the changed keys. */
export class Store<T extends object> {
  private listeners = new Set<(state: T, changed: Set<keyof T>) => void>();
  constructor(private state: T) {}

  get(): T {
    return this.state;
  }

  set(patch: Partial<T>): void {
    const changed = new Set<keyof T>();
    for (const key of Object.keys(patch) as (keyof T)[]) {
      if (this.state[key] !== patch[key]) changed.add(key);
    }
    if (changed.size === 0) return;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state, changed);
  }

  subscribe(fn: (state: T, changed: Set<keyof T>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
