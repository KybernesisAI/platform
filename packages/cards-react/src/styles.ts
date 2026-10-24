/**
 * The cards' stylesheet, as text, so a host with no CSS pipeline (a plugin
 * that ships one script) can put it in a <style> element, and a host with one
 * can import the same rules.
 *
 * Every colour, font and size reads a `--kyb-*` variable with a light default.
 * A host maps its own theme onto them on any ancestor, e.g.
 * `--kyb-ink: var(--text-primary)`, which is how one set of rules follows
 * each app's light and dark modes.
 */
export const cardStyles: string = `
.kcard .is-good { color: var(--kyb-good, #15803d); }
.kcard .is-bad { color: var(--kyb-bad, #dc2626); }

/* Cards: one frame for every type. */
.kcards { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.kcard {
  border: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); border-radius: 12px; background: var(--kyb-surface, #ffffff);
  padding: 13px 15px; font-size: var(--kyb-fs-base, 14px); line-height: var(--kyb-lh-base, 19px);
}
.kcard--compact { padding: 9px 13px; }
.kcard__head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.kcard--compact .kcard__head { margin-bottom: 4px; }
.kcard__title { flex: 1; min-width: 0; font-weight: 600; }
.klabel {
  font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--kyb-ink-tertiary, #8b91a0);
}
.kcard__source { flex: none; }
.kcard__text { white-space: pre-wrap; color: var(--kyb-ink-secondary, #5c6270); }
.kcard__actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }

.kstats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1px; background: var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; overflow: hidden; }
.kstats__tile { background: var(--kyb-surface, #ffffff); padding: 10px 12px; }
.kstats__value { font-size: 22px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 3px; }
.kstats__change { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); font-variant-numeric: tabular-nums; }
.kstats__change.is-good { color: var(--kyb-good, #15803d); }
.kstats__change.is-bad { color: var(--kyb-bad, #dc2626); }

.kchart__legend { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); }
.kchart__key { display: inline-flex; align-items: center; gap: 6px; }
.kchart__swatch { width: 10px; height: 2px; background: currentColor; }
.kchart__plot { display: flex; gap: 8px; }
.kchart__y { display: flex; flex-direction: column; justify-content: space-between; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; color: var(--kyb-ink-tertiary, #8b91a0); text-align: right; padding-bottom: 20px; min-width: 32px; }
.kchart__frame { position: relative; flex: 1; min-width: 0; }
.kchart__svg { display: block; width: 100%; height: 160px; overflow: visible; }
.kchart__line { fill: none; stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; }
.kchart__area { stroke: none; opacity: 0.06; }
.kchart__base { stroke: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); stroke-width: 1; }
.kchart__rule { stroke: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); stroke-width: 1; }
.kchart__s0 { stroke: var(--kyb-ink, #16181d); fill: var(--kyb-ink, #16181d); color: var(--kyb-ink, #16181d); }
.kchart__s1 { stroke: var(--kyb-ink-secondary, #5c6270); fill: var(--kyb-ink-secondary, #5c6270); color: var(--kyb-ink-secondary, #5c6270); }
.kchart__s2 { stroke: var(--kyb-ink-tertiary, #8b91a0); fill: var(--kyb-ink-tertiary, #8b91a0); color: var(--kyb-ink-tertiary, #8b91a0); }
.kchart__s3 { stroke: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); fill: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); color: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }
.kchart__line.kchart__s0, .kchart__line.kchart__s1, .kchart__line.kchart__s2, .kchart__line.kchart__s3 { fill: none; }
.kchart__x { display: flex; justify-content: space-between; margin-top: 6px; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; color: var(--kyb-ink-tertiary, #8b91a0); }
.kchart__x--slots { display: grid; text-align: center; }
.kchart__x--slots span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; }
.kchart__tip {
  position: absolute; top: 0; transform: translateX(-50%); pointer-events: none; white-space: nowrap;
  background: var(--kyb-surface-raised, #ffffff); border: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); border-radius: 6px;
  padding: 5px 8px; font-size: var(--kyb-fs-xs, 12px); box-shadow: var(--kyb-shadow-menu, 0 10px 34px rgba(16, 18, 24, 0.18));
}

.ktable { overflow-x: auto; }
.ktable__more { margin-top: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); }

.kcheck { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.kcheck__item { display: flex; gap: 9px; align-items: baseline; }
.kcheck__item--skipped, .kcheck__item--waiting { color: var(--kyb-ink-secondary, #5c6270); }
.kcheck__detail { color: var(--kyb-ink-tertiary, #8b91a0); }
.kglyph { flex: none; width: 14px; text-align: center; color: var(--kyb-ink-tertiary, #8b91a0); }
.kglyph.is-good { color: var(--kyb-good, #15803d); }
.kglyph.is-bad { color: var(--kyb-bad, #dc2626); }

.kbrief__head { display: flex; gap: 11px; align-items: center; }
.kbrief__initial {
  width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; flex: none;
  background: var(--kyb-ink, #16181d); color: var(--kyb-ink-inverse, #ffffff); font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 15px;
}
.kbrief__name { font-weight: 600; }
.kbrief__sub { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); }
.kbrief__points { margin: 10px 0 0; padding-left: 18px; }
.kbrief__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 12px 0 0; }
.kbrief__facts dd { margin: 2px 0 0; }
.kbrief .kstats { margin-top: 12px; }

.klink { display: block; width: 100%; text-align: left; padding: 0; }
.klink__desc { color: var(--kyb-ink-secondary, #5c6270); margin-bottom: 4px; }
.klink__url { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); text-decoration: underline; text-decoration-color: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }

.kshot__img { display: block; max-width: 100%; max-height: 320px; border-radius: 8px; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); cursor: zoom-in; }
.kshot__img--big { max-height: none; cursor: zoom-out; }
.kshot__wait, .kartifact__wait { display: grid; place-items: center; height: 120px; color: var(--kyb-ink-tertiary, #8b91a0); }
.kshot__missing, .kartifact__missing { display: flex; gap: 10px; align-items: center; color: var(--kyb-ink-secondary, #5c6270); font-size: var(--kyb-fs-sm, 13px); }
.kshot__caption { margin-top: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); display: flex; gap: 10px; }
.kshot__site { margin-left: auto; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; color: var(--kyb-ink-tertiary, #8b91a0); }

.kfile { display: flex; align-items: center; gap: 10px; }
.kfile__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.kfile__size { margin-left: 8px; color: var(--kyb-ink-tertiary, #8b91a0); font-size: var(--kyb-fs-sm, 13px); }

.kartifact__frame { display: block; width: 100%; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; background: #fff; }
.kartifact--inline { height: 360px; margin-bottom: 10px; }
.kartifact__doc.kartifact--inline { overflow: auto; padding: 4px 2px; }
.kartifact__meta { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); }
.kartifact__preview {
  display: block; width: 100%; padding: 0; margin-bottom: 10px; border: 0; background: none; cursor: pointer; text-align: left;
  position: relative; overflow: hidden; border-radius: 8px;
}
/* The top of the page, faded out, and not interactive: a click opens it. */
.kartifact--preview { height: 200px; pointer-events: none; overflow: hidden; }
.kartifact__preview::after {
  content: ""; position: absolute; inset: auto 0 0 0; height: 64px; pointer-events: none;
  background: linear-gradient(to bottom, transparent, var(--kyb-surface, #ffffff));
}
/* A page is white in both themes, so it fades into its own white, inside its border. */
.kartifact__preview:has(.kartifact__frame)::after {
  inset: auto 1px 1px 1px; border-radius: 0 0 7px 7px;
  background: linear-gradient(to bottom, rgb(255 255 255 / 0), #fff);
}
.kartifact__preview:hover .kartifact__frame, .kartifact__preview:hover .kartifact__doc { border-color: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }
.kartifact__doc.kartifact--preview { border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; padding: 10px 14px; }
.kartifact__row + .kcard__actions { margin-top: 10px; }

.kpr__summary { color: var(--kyb-ink-secondary, #5c6270); }
.kpr__delta { margin: 8px 0; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 11px; }
.kpr__meta { margin-top: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); }
.kpr .kcheck { margin-top: 8px; }
.kdiff { margin-top: 10px; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; overflow: hidden; font-family: var(--kyb-font-mono, ui-monospace, Menlo, Consolas, monospace); font-size: 12px; }
.kdiff__file { padding: 5px 10px; background: var(--kyb-hover, rgba(22, 24, 29, 0.045)); color: var(--kyb-ink-secondary, #5c6270); border-bottom: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); }
.kdiff__line { padding: 0 10px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.kdiff__line.is-good { background: color-mix(in srgb, var(--kyb-good, #15803d) 9%, transparent); color: inherit; }
.kdiff__line.is-bad { background: color-mix(in srgb, var(--kyb-bad, #dc2626) 9%, transparent); color: inherit; }

.kreceipt__amount { font-size: 22px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; }
.kreceipt__meta { font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 11px; color: var(--kyb-ink-tertiary, #8b91a0); margin-top: 2px; }
.kreceipt__note { margin: 8px 0; color: var(--kyb-ink-secondary, #5c6270); }
.kremember { color: var(--kyb-ink-secondary, #5c6270); }
.kroutine__meta { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); margin-top: 3px; }

/* Asks drawn on the card frame: approvals, forms, sign-in, a purchase. */
.kcard.is-done { padding: 9px 13px; }
.kcard.is-done .kcard__head { margin-bottom: 2px; align-items: center; }
.kpill {
  flex: none; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 999px; border: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); color: var(--kyb-ink-secondary, #5c6270);
}
.kpill.is-good { color: var(--kyb-good, #15803d); border-color: currentColor; }
.kapproval__rows { margin: 0; display: grid; gap: 4px; }
.kapproval__row { display: grid; grid-template-columns: 68px 1fr; gap: 10px; align-items: baseline; }
.kapproval__row dt { padding-top: 1px; }
.kapproval__row dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.kapproval__body {
  margin-top: 10px; padding: 10px 12px; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px;
  white-space: pre-wrap; overflow-wrap: anywhere; color: var(--kyb-ink-secondary, #5c6270); max-height: 260px; overflow: auto;
}
.kform { display: flex; flex-direction: column; gap: 10px; }
.kform__choices { display: flex; flex-wrap: wrap; gap: 6px; }
.kform__list { margin: 0; padding-left: 18px; color: var(--kyb-ink-secondary, #5c6270); }
.kbtn {
  height: 30px; padding: 0 13px; border: 0; border-radius: 8px; cursor: pointer;
  font: inherit; font-size: var(--kyb-fs-base, 14px); font-weight: 500;
  color: var(--kyb-ink, #16181d); background: var(--kyb-hover, rgba(22, 24, 29, 0.045));
}
.kbtn:hover { background: var(--kyb-selected, rgba(22, 24, 29, 0.075)); }
.kbtn--primary { background: var(--kyb-ink, #16181d); color: var(--kyb-ink-inverse, #ffffff); }
.kbtn--primary:hover { opacity: 0.87; background: var(--kyb-ink, #16181d); }
.klink { border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
.ktable table { border-collapse: collapse; width: 100%; font-size: var(--kyb-fs-sm, 13px); }
.ktable th { text-align: left; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }
.ktable td { padding: 4px 8px; border-bottom: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); font-variant-numeric: tabular-nums; }
.kartifact__plain { white-space: pre-wrap; }
.kartifact__host { margin-bottom: 10px; }
.kspin {
  width: 16px; height: 16px; border-radius: 50%; display: inline-block;
  border: 2px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); border-top-color: var(--kyb-ink-secondary, #5c6270);
  animation: kspin 0.8s linear infinite;
}
@keyframes kspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .kspin { animation: none; } }
`;
