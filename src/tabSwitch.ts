/**
 * Tab switches answer out of order: click B, then C, and B's slow answer
 * can land last. Each switch takes a ticket; only the newest ticket may
 * show its tab or end the busy state. Older answers are dropped.
 */

export type SwitchTicket = {
  /** True until a newer switch begins. */
  isCurrent: () => boolean;
};

export type SwitchTickets = {
  /** Start a switch. Every earlier ticket stops being current. */
  begin: () => SwitchTicket;
  /** Watch for a switch without starting one: false once any switch begins. */
  watch: () => SwitchTicket;
};

export function createSwitchTickets(): SwitchTickets {
  let latest = 0;
  const ticket = (id: number): SwitchTicket => ({ isCurrent: () => id === latest });
  return {
    begin: () => ticket(++latest),
    watch: () => ticket(latest),
  };
}
