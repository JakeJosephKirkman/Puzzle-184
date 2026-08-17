import type { DocRole } from '@/types/database';

const ADJECTIVES = [
  'Swift', 'Bright', 'Calm', 'Clever', 'Bold', 'Quiet', 'Keen', 'Warm',
  'Lucid', 'Nimble', 'Steady', 'Vivid', 'Brave', 'Gentle', 'Sharp', 'Merry',
];

const NOUNS = [
  'Otter', 'Falcon', 'Cedar', 'Harbor', 'Meadow', 'Lantern', 'Compass', 'River',
  'Ember', 'Quartz', 'Willow', 'Beacon', 'Sparrow', 'Juniper', 'Anchor', 'Aurora',
];

/** Distinct, high-contrast hues that stay legible against the dark surface. */
export const USER_COLORS = [
  '#8b7bf7', '#ec4899', '#22c55e', '#f59e0b', '#38bdf8',
  '#f43f5e', '#a3e635', '#c084fc', '#2dd4bf', '#fb923c',
];

/** Stable colour for a user id, so their cursor never changes shade between sessions. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return USER_COLORS[hash % USER_COLORS.length];
}

export function generateDisplayName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a} ${n}`;
}

const SESSION_KEY = 'collabspace:session-id';
const SESSION_CHANNEL = 'collabspace:session-claims';

/**
 * A session id identifies a browser tab, not a person.
 *
 * The same user in two tabs is two collaborators as far as presence and cursors
 * are concerned, which is what makes the app demonstrable in one browser.
 *
 * The id lives in sessionStorage so that a reload keeps it -- the offline outbox
 * is keyed by session id, and recovering queued edits after a reload depends on
 * it staying stable. But browsers *copy* sessionStorage into a duplicated tab,
 * so "Duplicate Tab" would hand two live tabs the same id, collide on the
 * presence key and have them fight over one slot.
 *
 * `claimSessionId` resolves that: it asks whether any live tab already holds
 * the id. A duplicate gets an answer and mints a fresh one; a reload gets
 * silence, because the previous tab is gone, and keeps its id.
 */
export function getSessionId(): string {
  if (typeof window === 'undefined') return 'server';
  let id = window.sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export interface SessionClaim {
  sessionId: string;
  release: () => void;
}

/**
 * Take exclusive ownership of a session id, re-minting if a live tab holds it.
 *
 * Resolves quickly: it only waits long enough for another tab to object.
 */
export async function claimSessionId(waitMs = 120): Promise<SessionClaim> {
  const id = getSessionId();
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    return { sessionId: id, release: () => {} };
  }

  const channel = new BroadcastChannel(SESSION_CHANNEL);
  let claimed = id;

  const contested = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    channel.addEventListener('message', function listener(event: MessageEvent) {
      const data = event.data as { type: string; sessionId: string };
      if (data?.type === 'held' && data.sessionId === id) {
        clearTimeout(timer);
        channel.removeEventListener('message', listener);
        resolve(true);
      }
    });
    channel.postMessage({ type: 'who-holds', sessionId: id });
  });

  if (contested) {
    claimed = crypto.randomUUID();
    window.sessionStorage.setItem(SESSION_KEY, claimed);
  }

  // Answer future probes, so the next duplicate re-mints rather than colliding.
  const respond = (event: MessageEvent) => {
    const data = event.data as { type: string; sessionId: string };
    if (data?.type === 'who-holds' && data.sessionId === claimed) {
      channel.postMessage({ type: 'held', sessionId: claimed });
    }
  };
  channel.addEventListener('message', respond);

  return {
    sessionId: claimed,
    release: () => {
      channel.removeEventListener('message', respond);
      channel.close();
    },
  };
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function canEdit(role: DocRole | null): boolean {
  return role === 'owner' || role === 'editor';
}

export function roleLabel(role: DocRole | null): string {
  if (role === 'owner') return 'Owner';
  if (role === 'editor') return 'Editor';
  if (role === 'viewer') return 'Viewer';
  return 'No access';
}

/** Shown wherever an author's account no longer exists. */
export const DELETED_USER = 'Deleted user';

/**
 * Resolve a display name for an author who may be null.
 *
 * Authorship is nullable because deleting an account no longer deletes the
 * work. Profiles outlive the account, so a name is usually still available;
 * only a profile that was purged too falls back to the placeholder.
 */
export function nameOfAuthor(
  authorId: string | null | undefined,
  profiles: Record<string, { display_name: string }>,
): string {
  if (!authorId) return DELETED_USER;
  return profiles[authorId]?.display_name ?? DELETED_USER;
}

export function colorOfAuthor(
  authorId: string | null | undefined,
  profiles: Record<string, { color: string }>,
): string {
  if (!authorId) return '#6b7488';
  return profiles[authorId]?.color ?? colorForUser(authorId);
}
