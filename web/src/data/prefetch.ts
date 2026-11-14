/**
 * Warm the browser cache with another site's core data (terrain grids, images, stops: ~9 MB, not the
 * 8K panoramas or photos) once the user shows they may switch to it: opening the site menu, or pointing
 * at a site in the briefing.  The switch then loads mostly from cache.  Skipped with Data Saver.
 */
const started = new Set<string>();
const SKIP = /(_8k|panoramas\/|images\/|\.\.\/materials\/)/;

export function prefetchSite(id: string): void {
  if (started.has(id)) return;
  started.add(id);
  const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData) return;
  const base = `${import.meta.env.BASE_URL}data/${id}/`;
  const get = (url: string) => fetch(url, { priority: "low" } as RequestInit).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  void fetch(base + "files.json", { priority: "low" } as RequestInit)
    .then((r) => (r.ok ? r.json() : null))
    .then(async (list: { files: { path: string }[] } | null) => {
      if (!list) return;
      const queue = list.files.map((f) => f.path).filter((p) => !SKIP.test(p));
      // two at a time, at low priority: never competes with the site in use
      const worker = async () => {
        for (let p = queue.shift(); p; p = queue.shift()) await get(base + p);
      };
      await Promise.all([worker(), worker()]);
    })
    .catch(() => {});
}
