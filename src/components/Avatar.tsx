'use client';

import { initialsOf } from '@/lib/identity';

export function Avatar({
  name,
  color,
  size = 28,
  ring,
}: {
  name: string;
  color: string;
  size?: number;
  ring?: boolean;
}) {
  return (
    <span
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.38,
        fontWeight: 600,
        flexShrink: 0,
        boxShadow: ring ? '0 0 0 2px var(--surface)' : undefined,
        userSelect: 'none',
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

export function AvatarStack({
  people,
  max = 4,
}: {
  people: { name: string; color: string }[];
  max?: number;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {shown.map((p, i) => (
        <span key={`${p.name}-${i}`} style={{ marginLeft: i === 0 ? 0 : -8 }}>
          <Avatar name={p.name} color={p.color} ring />
        </span>
      ))}
      {extra > 0 && (
        <span
          style={{
            marginLeft: -8,
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'var(--surface-3)',
            color: 'var(--text-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
            boxShadow: '0 0 0 2px var(--surface)',
          }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}
