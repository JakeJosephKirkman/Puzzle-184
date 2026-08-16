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

/**
 * A session id identifies a browser tab, not a person.
 *
 * The same user in two tabs is two collaborators as far as presence and cursors
 * are concerned, which is what makes the app testable with one browser.
 */
export function getSessionId(): string {
  if (typeof window === 'undefined') return 'server';
  const KEY = 'collabspace:session-id';
  let id = window.sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(KEY, id);
  }
  return id;
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
