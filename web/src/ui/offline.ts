/**
 * Offline use: a service worker (built from sw.template.js) keeps the app and mission data on the
 * device, and "Use offline" downloads everything for the current site up front, then offers to install
 * CAIRN as an app.
 */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}

let installPrompt: InstallPrompt | null = null;

export function initOffline(): void {
  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault(); // offer it from About → Use offline instead of at a random moment
    installPrompt = ev as InstallPrompt;
  });
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Offline mode unavailable", err));
  }
}

/** True once a service worker controls the page (published builds only). */
async function controlled(timeoutMs = 6000): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return false;
  if (navigator.serviceWorker.controller) return true;
  await Promise.race([
    new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return !!navigator.serviceWorker.controller;
}

/** Fetch every file of a site through the service worker, which keeps a copy of each. */
export async function saveForOffline(
  siteId: string,
  progress: (doneFiles: number, totalFiles: number, doneBytes: number, totalBytes: number) => void,
): Promise<{ files: number; bytes: number }> {
  if (!(await controlled())) throw new Error("Offline mode works on the published site, not in development.");
  const root = `${import.meta.env.BASE_URL}data/`;
  const list = (await (await fetch(`${root}${siteId}/files.json`, { cache: "no-store" })).json()) as { files: { path: string; bytes: number }[]; totalBytes: number };
  const queue = list.files.slice();
  let doneFiles = 0;
  let doneBytes = 0;
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const res = await fetch(`${root}${siteId}/${f.path}`);
      if (!res.ok) throw new Error(`Could not save ${f.path} (${res.status})`);
      await res.arrayBuffer();
      doneFiles++;
      doneBytes += f.bytes;
      progress(doneFiles, list.files.length, doneBytes, list.totalBytes);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { files: doneFiles, bytes: doneBytes };
}

/** Offer "install as an app" if the browser allows it right now. */
export async function promptInstall(): Promise<boolean> {
  if (!installPrompt) return false;
  const p = installPrompt;
  installPrompt = null;
  await p.prompt();
  return true;
}
