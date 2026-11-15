import { dissolveTo } from "./dissolve";

/**
 * EV2's notice that EV1 has left the session (closed CAIRN, or lost their connection), with a way back
 * to the main menu.  The hab says when EV1 goes and comes back (protocol `ev1`); a reload brings EV1
 * back within a few seconds, so the notice waits a moment before it shows, and goes away when EV1 returns.
 * Used by the planner and free roam.
 */
export class Ev1Watch {
  private card: HTMLElement | null = null;
  private timer = 0;
  private gone = false;
  private dismissed = false;

  /** `onBack`: EV1 came back after the notice was shown (for a short "EV1 is back" message). */
  constructor(private readonly site: string, private readonly onBack: () => void = () => {}, private readonly graceMs = 6000) {}

  update(online: boolean): void {
    window.clearTimeout(this.timer);
    if (online) {
      const shown = !!this.card || this.dismissed;
      this.gone = false;
      this.dismissed = false;
      this.hide();
      if (shown) this.onBack();
      return;
    }
    if (this.gone) return;
    this.gone = true;
    this.timer = window.setTimeout(() => this.show(), this.graceMs);
  }

  private show(): void {
    if (!this.gone || this.dismissed || this.card) return;
    if (document.pointerLockElement) document.exitPointerLock();
    const card = document.createElement("div");
    card.className = "ev1-left";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-label", "EV1 left");
    card.innerHTML = `<p class="eyebrow">// Crew session</p>
      <b>EV1 has left the session.</b>
      <span>EV1 closed CAIRN or lost their connection. If they come back, this goes away and you carry on together; the session closes 2 minutes after everyone has gone.</span>
      <div class="ev1-left-acts"><button class="primary" data-menu>Main menu</button><button data-wait>Wait for EV1</button></div>`;
    document.body.append(card);
    this.card = card;
    card.querySelector<HTMLButtonElement>("[data-menu]")!.addEventListener("click", () => dissolveTo(`?site=${encodeURIComponent(this.site)}&menu=1`));
    card.querySelector<HTMLButtonElement>("[data-wait]")!.addEventListener("click", () => {
      this.dismissed = true;
      this.hide();
    });
    card.querySelector<HTMLButtonElement>("[data-menu]")!.focus();
  }

  private hide(): void {
    this.card?.remove();
    this.card = null;
  }
}
