import type * as ReactNamespace from "react";

/**
 * React, as Buzz lends it.
 *
 * A Buzz plugin may not bring its own React: it uses the one the app hands it
 * in `apply`. The card components import `react` like any library, so the
 * build points those imports here and `apply` binds the real one before
 * anything renders.
 */
type ReactLike = typeof ReactNamespace;
let R: ReactLike | undefined;

export function bindReact(react: ReactLike): void {
  R = react;
}

function host(): ReactLike {
  if (!R) throw new Error("React is not bound yet");
  return R;
}

export const useState: ReactLike["useState"] = ((initial?: unknown) => host().useState(initial)) as ReactLike["useState"];
export const useEffect: ReactLike["useEffect"] = (effect, deps) => host().useEffect(effect, deps);
export const useRef: ReactLike["useRef"] = ((initial?: unknown) => host().useRef(initial)) as ReactLike["useRef"];
export const useMemo: ReactLike["useMemo"] = (factory, deps) => host().useMemo(factory, deps);
export const createElement = ((...args: Parameters<ReactLike["createElement"]>) =>
  host().createElement(...args)) as ReactLike["createElement"];

/** React's Fragment, once bound. */
export function fragmentType(): unknown {
  return host().Fragment;
}
