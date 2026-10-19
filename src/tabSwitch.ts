/**
 * Tab switches answer out of order: click B, then C, and B's slow answer
 * can land last. Each switch takes a ticket; only the newest ticket may
 * show its tab or end the busy state. Older answers are dropped.
 */

export type SwitchWatch = {
  /** True until a newer switch begins. */
  isCurrent: () => boolean;
};

export type SwitchTicket = SwitchWatch & {
  /** This switch is done. True when it was still the newest, so it ends the busy state. */
  finish: () => boolean;
};

export type SwitchTickets = {
  /** Start a switch to `target`. Every earlier ticket stops being current. */
  begin: (target: string) => SwitchTicket;
  /** Watch for a switch without starting one: false once any switch begins. */
  watch: () => SwitchWatch;
  /**
   * A click on `target`, the tab already shown. A switch to another tab that
   * is still loading is dropped; true when one was, so the caller ends busy.
   */
  stayOn: (target: string) => boolean;
};

export function createSwitchTickets(): SwitchTickets {
  let latest = 0;
  let pending: { id: number; target: string } | null = null;
  const watch = (id: number): SwitchWatch => ({ isCurrent: () => id === latest });
  return {
    begin: (target) => {
      const id = ++latest;
      pending = { id, target };
      return {
        ...watch(id),
        finish: () => {
          if (id !== latest) return false;
          pending = null;
          return true;
        },
      };
    },
    watch: () => watch(latest),
    stayOn: (target) => {
      if (!pending || pending.target === target) return false;
      latest += 1;
      pending = null;
      return true;
    },
  };
}
