import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A model filling optional array parameters with `[]` is ordinary behaviour,
 * not misuse. This guards the reading of those inputs, because getting it wrong
 * produced the worst class of bug available here: not an error, but a confident
 * wrong answer. Asked what projects existed in a workspace holding three, the
 * agent sent `{"kinds":[],"authors":[]}` — a filter that matches nothing — and
 * reported that there were none.
 */

/** The shipped reading of those inputs. */
function buildFilter({ type, kinds, authors, limit }, kindOf) {
  const asked = kinds?.length ? kinds : undefined;
  const wanted = asked ?? (type ? [kindOf[type]] : undefined);
  const by = authors?.length ? authors : undefined;
  if (!wanted) return null;
  return { kinds: wanted, ...(by ? { authors: by } : {}), limit: limit ?? 50 };
}

const KINDS = { project: 30621, repo: 30617 };

test("empty arrays are treated as not specified, not as impossible filters", () => {
  const filter = buildFilter({ type: "repo", kinds: [], authors: [] }, KINDS);
  assert.deepEqual(filter, { kinds: [30617], limit: 50 });
});

test("a real kinds list still wins over the friendly type", () => {
  assert.deepEqual(buildFilter({ type: "repo", kinds: [9] }, KINDS), { kinds: [9], limit: 50 });
});

test("real authors are still passed through", () => {
  assert.deepEqual(buildFilter({ type: "project", authors: ["abc"] }, KINDS), {
    kinds: [30621],
    authors: ["abc"],
    limit: 50,
  });
});

test("with nothing to go on it asks, rather than querying for nothing", () => {
  assert.equal(buildFilter({ kinds: [], authors: [] }, KINDS), null);
});
