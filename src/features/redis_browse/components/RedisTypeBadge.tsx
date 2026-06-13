// Redis value-type badge — ported from `redis.jsx` RedisTypeBadge
// (REDIS_SPEC §2): rounded square, mono 600, short label (Str/Hsh/Lst/Set/
// ZSt/Xst) tinted with the type's fixed accent color ({color}22 fill /
// {color}55 border), same recipe as the engine badge. Sized inline (the
// sidebar uses 16px, tab bar 13px, dashboard/toolbars 16–20px).

import { REDIS_TYPES } from "../helpers";
import type { KeyType } from "../api";

interface RedisTypeBadgeProps {
  type: KeyType;
  /** Badge height in px; width is height + 6 (the prototype's aspect). */
  size?: number;
}

export function RedisTypeBadge({ type, size = 20 }: RedisTypeBadgeProps) {
  const m = REDIS_TYPES[type];
  return (
    <span
      className="rtype-badge"
      title={m.label}
      style={{
        width: size + 6,
        height: size,
        fontSize: size * 0.46,
        background: m.color + "22",
        color: m.color,
        border: "1px solid " + m.color + "55",
      }}
    >
      {m.short}
    </span>
  );
}
