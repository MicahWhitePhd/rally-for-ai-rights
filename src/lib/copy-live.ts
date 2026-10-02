/**
 * The site's text as it stands: src/lib/copy.ts with the editor's overrides
 * applied (/editor/copy, copy_overrides). Every live page, prompt and route
 * reads through liveCopy(); a client component gets what it shows as props.
 *
 * A path names one string: "ROOM.title", "FRONT.steps[1].text",
 * "ROOM.errors.text". Functions, numbers
 * and booleans are not paths and cannot be overridden. An override lands only
 * where the default is a string, so a bad row cannot change a shape.
 *
 * Cached for a few seconds per instance; the editor invalidates on save.
 * If the table cannot be read, the defaults stand (fail open to the code).
 */
import 'server-only';
import * as base from '@/lib/copy';
import { listCopyOverrides } from '@/lib/db/queries/copy';

export type Copy = { -readonly [K in keyof typeof base]: (typeof base)[K] };

const TTL_MS = 10_000;
let cache: { at: number; copy: Copy } | null = null;
let warned = false;

function isPlain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Every string path of a copy module, in source order. Pure. */
export function copyPaths(mod: object): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') out.push(path);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (isPlain(v)) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const [name, value] of Object.entries(mod)) walk(value, name);
  return out;
}

/** A deep copy that keeps functions by reference. Pure. */
export function cloneCopy<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => cloneCopy(x)) as unknown as T;
  if (isPlain(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = cloneCopy(x);
    return out as T;
  }
  return v;
}

const SEG = /^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*|\[\d+\])*)$/;

/** Splits "FRONT.steps[1].text" into ["FRONT", "steps", 1, "text"]; null when malformed. Pure. */
export function parsePath(path: string): Array<string | number> | null {
  const m = SEG.exec(path);
  if (!m) return null;
  const segs: Array<string | number> = [m[1]];
  for (const s of m[2].matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) segs.push(s[1] !== undefined ? s[1] : Number(s[2]));
  return segs;
}

/** The module with overrides applied wherever the default is a string. Never mutates its input. Pure. */
export function applyOverrides(mod: object, overrides: Readonly<Record<string, string>>): Copy {
  const out = cloneCopy(Object.fromEntries(Object.entries(mod))) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const segs = parsePath(path);
    if (!segs || typeof value !== 'string') continue;
    let node: unknown = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      node = Array.isArray(node) && typeof s === 'number' ? node[s] : isPlain(node) && typeof s === 'string' ? node[s] : undefined;
      if (node === undefined) break;
    }
    const last = segs[segs.length - 1];
    if (Array.isArray(node) && typeof last === 'number' && typeof node[last] === 'string') node[last] = value;
    else if (isPlain(node) && typeof last === 'string' && typeof node[last] === 'string') node[last] = value;
  }
  return out as unknown as Copy;
}

/** The defaults, as a plain object (no overrides). */
export function defaultCopy(): Copy {
  return applyOverrides(base, {});
}

export function invalidateLiveCopy(): void {
  cache = null;
}

/** The text as it stands. Cached briefly; falls back to the code's defaults if the table cannot be read. */
export async function liveCopy(): Promise<Copy> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.copy;
  let overrides: Record<string, string> = {};
  try {
    overrides = Object.fromEntries((await listCopyOverrides()).map((r) => [r.path, r.value]));
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[COPY] overrides unavailable, defaults stand', (err as Error)?.message);
    }
  }
  const copy = applyOverrides(base, overrides);
  cache = { at: now, copy };
  return copy;
}
