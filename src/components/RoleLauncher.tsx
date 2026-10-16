import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { getRole, type RoleSummary } from "../bridge";
import { PROVIDERS } from "../provider/descriptor";
import { PROVIDER_IDS, type ProviderId } from "../provider/types";
import type { ProvidersState } from "../provider/useProviders";
import { Dialog } from "./Dialog";
import { Kbd } from "./Kbd";
import { RadioGroup, radioProps } from "./RadioGroup";

export type LaunchSurface = "terminal" | "chat";

/** What the launcher picked: the new tab's start form opens with it selected. */
export type RoleLaunch = { roleId: string; provider: ProviderId; surface: LaunchSurface };

const BLURB_MAX = 90;

/**
 * One short line about a role from its template: the first heading, else
 * the first line of prose, without Markdown marks. "" when none.
 */
export function roleBlurb(templateText: string): string {
  for (const raw of templateText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(```|~~~|---+|\*\*\*+|___+|<!--)/.test(line)) continue;
    if (/^\{\{[^}]*\}\}$/.test(line)) continue;
    const text = line
      .replace(/^#+\s*/, "")
      .replace(/^[-*>]\s+/, "")
      .replace(/(\*\*|__|`)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    return text.length > BLURB_MAX ? `${text.slice(0, BLURB_MAX - 1).trimEnd()}…` : text;
  }
  return "";
}

/** Providers to offer: each one not known to be missing on this machine. */
export function launchProviders(providers: Pick<ProvidersState, "claude" | "cursor">): ProviderId[] {
  return PROVIDER_IDS.filter((id) => providers[id]?.status.found !== false);
}

/** Every word must appear in the role's name, id, mode or description. */
export function filterRoles(
  roles: readonly RoleSummary[],
  query: string,
  blurbs: Readonly<Record<string, string>>,
): RoleSummary[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...roles];
  return roles.filter((role) => {
    const hay = `${role.name} ${role.id} ${role.defaultMode} ${blurbs[role.id] ?? ""}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

/** Descriptions by role id, read once per run (a role's template seldom changes). */
const blurbCache = new Map<string, string>();

type Props = {
  roles: RoleSummary[];
  /** Providers offered as chips (see launchProviders). */
  providers: ProviderId[];
  /** The chip chosen at first, when offered. */
  defaultProvider: ProviderId;
  /** Reads one role's description; default: its template's first line. */
  describe?: (roleId: string) => Promise<string>;
  onLaunch: (launch: RoleLaunch) => void;
  onClose: () => void;
};

const describeRole = async (roleId: string) => roleBlurb((await getRole(roleId)).templateText);

/**
 * "New tab with role…": search a role, pick the provider and Terminal or
 * Chat, Enter opens a new tab whose start form has them selected.
 */
export function RoleLauncher({
  roles,
  providers,
  defaultProvider,
  describe = describeRole,
  onLaunch,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [surface, setSurface] = useState<LaunchSurface>("terminal");
  const offered = providers.length > 0 ? providers : [defaultProvider];
  const [provider, setProvider] = useState<ProviderId>(
    offered.includes(defaultProvider) ? defaultProvider : offered[0],
  );
  const [blurbs, setBlurbs] = useState<Record<string, string>>(() =>
    Object.fromEntries(roles.filter((role) => blurbCache.has(role.id)).map((role) => [role.id, blurbCache.get(role.id)!])),
  );

  useEffect(() => {
    let live = true;
    for (const role of roles) {
      if (blurbCache.has(role.id)) continue;
      describe(role.id)
        .then((text) => {
          blurbCache.set(role.id, text);
          if (live) setBlurbs((prev) => ({ ...prev, [role.id]: text }));
        })
        // intentionally silent: a row without a description still opens its role.
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [roles, describe]);

  const shown = useMemo(() => filterRoles(roles, query, blurbs), [roles, query, blurbs]);
  useEffect(() => setIndex(0), [query]);
  const current = shown[Math.min(index, shown.length - 1)];

  const launch = (role: RoleSummary | undefined) => {
    if (role) onLaunch({ roleId: role.id, provider, surface });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((at) => Math.min(at + 1, Math.max(shown.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      launch(current);
    } else if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      // Tab switches Terminal / Chat here instead of moving focus.
      event.preventDefault();
      event.stopPropagation();
      setSurface((value) => (value === "terminal" ? "chat" : "terminal"));
    }
  };

  return (
    <Dialog
      title="New tab with role"
      hideTitle
      placement="top"
      className="overlay-panel-palette role-launcher"
      onClose={onClose}
    >
      <input
        className="text-input"
        autoFocus
        data-autofocus
        placeholder="Search roles"
        aria-label="Search roles"
        aria-controls="role-launcher-list"
        aria-activedescendant={current ? `role-launcher-${current.id}` : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="role-launcher-chips">
        {offered.length > 1 && (
          <RadioGroup label="Provider" className="role-launcher-chip-group">
            {offered.map((id) => (
              <button
                key={id}
                type="button"
                className="role-choice"
                {...radioProps(provider === id)}
                onClick={() => setProvider(id)}
              >
                {PROVIDERS[id].label}
              </button>
            ))}
          </RadioGroup>
        )}
        <RadioGroup label="Open as" className="role-launcher-chip-group">
          {(["terminal", "chat"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="role-choice"
              {...radioProps(surface === value)}
              onClick={() => setSurface(value)}
            >
              {value === "terminal" ? "Terminal" : "Chat"}
            </button>
          ))}
        </RadioGroup>
        {surface === "chat" && <span className="hint">Autopilot needs Terminal</span>}
      </div>
      <ul className="palette-list role-launcher-list" id="role-launcher-list" role="listbox" aria-label="Roles">
        {shown.map((role) => {
          const active = role === current;
          return (
            <li
              key={role.id}
              id={`role-launcher-${role.id}`}
              role="option"
              aria-selected={active}
              className={active ? "palette-item palette-item-active role-launcher-row" : "palette-item role-launcher-row"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => launch(role)}
            >
              <span className="role-launcher-dot" style={{ background: role.color || "var(--fg-subtle)" }} aria-hidden />
              <span className="role-launcher-text">
                <span className="role-launcher-name">{role.name}</span>
                <span className="role-launcher-blurb">{blurbs[role.id] ?? ""}</span>
              </span>
              <span className="hint role-launcher-mode">{role.defaultMode}</span>
            </li>
          );
        })}
        {shown.length === 0 && <li className="hint">No matching roles</li>}
      </ul>
      <footer className="role-launcher-footer hint">
        <span>
          <Kbd keys="↑↓" /> choose · <Kbd keys="↵" /> open form · <Kbd keys="Tab" /> Chat/Terminal ·{" "}
          <Kbd keys="Esc" /> close
        </span>
        <span>
          {roles.length} {roles.length === 1 ? "role" : "roles"} · {PROVIDERS[provider].label}
        </span>
      </footer>
    </Dialog>
  );
}
