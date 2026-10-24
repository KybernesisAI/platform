import { createElement, fragmentType } from "./react.js";

/**
 * The automatic JSX runtime, over Buzz's React (see react.ts).
 *
 * `jsxs` gets children written side by side in the source, which React must
 * not treat as a list needing keys, so they are passed one by one; `jsx` gets
 * one child, or a list a component built, which keeps its own keys.
 */
export const Fragment = Symbol.for("kyb.fragment");

type Props = Record<string, unknown> | null;
const make = createElement as (type: unknown, props: Props, ...children: unknown[]) => unknown;

function element(type: unknown, props: Props, key: unknown, spread: boolean): unknown {
  const real = type === Fragment ? fragmentType() : type;
  const { children, ...rest } = props ?? {};
  const own = key === undefined ? rest : { ...rest, key };
  if (children === undefined) return make(real, own);
  return spread && Array.isArray(children) ? make(real, own, ...children) : make(real, own, children);
}

export const jsx = (type: unknown, props: Props, key?: unknown): unknown => element(type, props, key, false);
export const jsxs = (type: unknown, props: Props, key?: unknown): unknown => element(type, props, key, true);
