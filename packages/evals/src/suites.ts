/**
 * Baseline eval suites for Kybernesis eve agents.
 *
 * Every fixture here encodes a hardening lesson learned in production:
 * - Nonces are generated INSIDE test() bodies — eve caches compiled eval modules
 *   across runs, so module-scope Date.now() reuses one value forever.
 * - Fixture facts carry per-run unique keys — the hermetic eval workspace
 *   ACCUMULATES across runs, and repeated identical facts make the agent
 *   (correctly) decline duplicates or recall stale contradictions.
 * - Fixture wording is COMPANY-GENERAL — department-flavored prompts make a
 *   delegation-capable agent (correctly) route to a subagent, whose tool calls
 *   happen in a child session invisible to parent-stream predicates.
 * - No security-flavored vocabulary ("canary", "secret") — models refuse those
 *   as extraction attempts instead of searching memory.
 * - Memory tools are matched by remote-name suffix (see tools.ts).
 * - Routing evals get a realistic time budget: delegation runs a full child
 *   session doing real memory work.
 */
import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { MEMORY_READ_SUFFIXES, MEMORY_WRITE_SUFFIXES, isResultFrom, resultToolName } from "./tools.js";

type EveEval = ReturnType<typeof defineEval>;

export interface BaselineConfig {
  /** Shown-name the smoke eval's judge checks for (default: "the company's assistant"). */
  agentDisplayName?: string;
  /** Include the Arcana memory suite (default true; requires @kybernesis/arcana wired). */
  memory?: boolean;
  /**
   * Department subagents to generate routing evals for. Default prompts exist for
   * "finance", "marketing", and "engineering"; any other name needs a `prompt`.
   */
  routing?: Array<{ subagent: string; prompt?: string }>;
  /** How long to let Arcana index a fresh fact before cross-session recall (default 25s). */
  indexingWaitMs?: number;
}

const DEFAULT_ROUTING_PROMPTS: Record<string, string> = {
  finance:
    "What did we spend this month across our systems, and how does it trend against budget?",
  marketing:
    "Marketing task: draft three positioning angles for announcing our new internal AI assistant to the team. Audience is our own employees; tone is confident and plain-spoken. No clarification needed — use exactly this brief.",
  engineering:
    "What's the state of production errors and recent engineering incidents?",
};

/** Boots, replies, and knows who it is. */
export function smokeSuite(config?: Pick<BaselineConfig, "agentDisplayName">): EveEval[] {
  const who = config?.agentDisplayName ?? "the company's assistant";
  return [
    defineEval({
      description: "Smoke: the agent boots, accepts a turn, and replies coherently.",
      tags: ["fast"],
      async test(t) {
        await t.send("In one sentence, who are you and what do you do?");
        t.succeeded();
        t.check(
          t.reply,
          satisfies(
            (reply) => typeof reply === "string" && reply.trim().length > 0,
            "non-empty reply",
          ),
        );
        t.judge.autoevals
          .closedQA(`identifies itself as ${who}`)
          .atLeast(0.5);
      },
    }),
  ];
}

/** The Arcana memory behaviors: hygiene, explicit + proactive stores, brain notes, recall. */
export function memorySuite(config?: Pick<BaselineConfig, "indexingWaitMs">): EveEval[] {
  const indexingWaitMs = config?.indexingWaitMs ?? 25_000;
  return [
    defineEval({
      description: "Memory: a plain greeting does not thrash the memory pipeline.",
      tags: ["fast"],
      async test(t) {
        await t.send("Hey!");
        t.succeeded();
        t.eventsSatisfy("no memory writes on a greeting", (events) =>
          events.every((event) => !isResultFrom(event, MEMORY_WRITE_SUFFIXES)),
        );
        t.eventsSatisfy("no memory reads on a greeting", (events) =>
          events.every((event) => !isResultFrom(event, MEMORY_READ_SUFFIXES)),
        ).soft();
      },
    }),

    defineEval({
      description:
        'Memory: an explicit "remember ..." is stored and confirmed — never refused as out of scope.',
      async test(t) {
        const runId = Date.now().toString(36);
        await t.send(
          `Remember that baseline check ${runId} of the agent's memory pipeline completed successfully. This is eval-generated test data.`,
        );
        t.succeeded();
        t.eventsSatisfy("arcana_remember was called", (events) =>
          events.some((event) => isResultFrom(event, ["arcana_remember"])),
        );
        t.judge.autoevals
          .closedQA("confirms the information was saved, without refusing")
          .atLeast(0.6);
      },
    }),

    defineEval({
      description:
        "Memory: a stated company-general decision is stored proactively, without the word 'remember'.",
      async test(t) {
        const runId = Date.now().toString(36);
        await t.send(
          `Team update: we decided that starting cycle ${runId}, the weekly all-hands moves to Tuesdays at 10am.`,
        );
        t.succeeded();
        t.eventsSatisfy("arcana_remember was called", (events) =>
          events.some((event) => isResultFrom(event, ["arcana_remember"])),
        );
      },
    }),

    defineEval({
      description:
        "Memory: long-form content produces a brain note with BOTH halves — brain_write (file) then brain_add (index).",
      async test(t) {
        const runId = Date.now().toString(36);
        await t.send(
          `Document this decision (eval-generated test data, run ${runId}): starting cycle ${runId}, the company observes a no-meeting focus morning on the first Friday of each month. Rationale: protected deep-work time. Alternatives considered: a full no-meeting day (too disruptive to client calls).`,
        );
        t.succeeded();
        t.eventsSatisfy("brain_write then brain_add both completed", (events) => {
          const names = events
            .map(resultToolName)
            .filter((name): name is string => name !== null);
          const writeAt = names.findIndex((n) => n.endsWith("arcana_brain_write"));
          const addAt = names.findIndex((n) => n.endsWith("arcana_brain_add"));
          return writeAt !== -1 && addAt !== -1 && writeAt < addAt;
        });
      },
    }),

    defineEval({
      description:
        "Memory: a fact stored in one session is looked up UNPROMPTED and recalled correctly from a brand-new session.",
      async test(t) {
        const nonce = `marigold-${Date.now().toString(36)}`;
        const wsKey = `ws-${nonce.slice(-6)}`;
        await t.send(
          `Remember that the internal project codename for workstream ${wsKey} is "${nonce}". This is eval-generated test data.`,
        );
        t.eventsSatisfy("arcana_remember was called", (events) =>
          events.some((event) => isResultFrom(event, ["arcana_remember"])),
        );

        await new Promise((resolve) => setTimeout(resolve, indexingWaitMs));

        // No "check your memory" hint: this asserts recall-first behavior AND
        // cross-session durability in one pass.
        const fresh = t.newSession();
        const answer = await fresh.send(
          `What is the internal project codename for workstream ${wsKey}?`,
        );
        fresh.succeeded();
        t.eventsSatisfy("memory was consulted before answering", (events) =>
          events.some((event) => isResultFrom(event, MEMORY_READ_SUFFIXES)),
        );
        t.check(answer.message, includes(nonce)).label("codename recalled");
      },
    }),
  ];
}

/** Delegation: clearly departmental asks route to the right specialist. */
export function routingSuite(entries: Array<{ subagent: string; prompt?: string }>): EveEval[] {
  return entries.map(({ subagent, prompt }) => {
    const resolved = prompt ?? DEFAULT_ROUTING_PROMPTS[subagent];
    if (!resolved) {
      throw new Error(
        `routingSuite: no default prompt for subagent "${subagent}" — supply one via { subagent, prompt }.`,
      );
    }
    return defineEval({
      description: `Routing: a ${subagent}-shaped task is delegated to the ${subagent} specialist.`,
      // Delegation runs a full child session doing real memory work.
      timeoutMs: 360_000,
      async test(t) {
        await t.send(resolved);
        t.succeeded();
        t.calledSubagent(subagent);
      },
    });
  });
}

/** The full baseline: smoke + memory + routing, per config. */
export function kybernesisBaseline(config?: BaselineConfig): EveEval[] {
  return [
    ...smokeSuite(config),
    ...(config?.memory === false ? [] : memorySuite(config)),
    ...routingSuite(config?.routing ?? []),
  ];
}
