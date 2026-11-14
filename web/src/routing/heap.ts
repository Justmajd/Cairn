/** Binary min-heap of (key, value) pairs stored in typed arrays.  Grows on demand. */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  private count = 0;

  constructor(capacity = 1 << 16) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
  }

  push(key: number, value: number): void {
    if (this.count === this.keys.length) {
      const k = new Float64Array(this.keys.length * 2);
      const v = new Int32Array(this.vals.length * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.count++;
    const keys = this.keys;
    const vals = this.vals;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      vals[i] = vals[parent];
      i = parent;
    }
    keys[i] = key;
    vals[i] = value;
  }

  /** Key of the smallest entry (undefined behaviour when empty). */
  peekKey(): number {
    return this.keys[0];
  }

  /** Remove and return the value with the smallest key. Call only when size > 0. */
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    const n = --this.count;
    if (n > 0) {
      const key = keys[n];
      const val = vals[n];
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        vals[i] = vals[child];
        i = child;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }
}
