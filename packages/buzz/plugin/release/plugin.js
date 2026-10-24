// ../../cards/src/types.ts
var e = [
	"stats",
	"chart",
	"table",
	"checklist",
	"brief",
	"link",
	"screenshot",
	"file",
	"artifact",
	"pull-request",
	"receipt",
	"remembered",
	"routine",
	"approval",
	"form"
];
function t(t) {
	return e.includes(t.card);
}
// ../../cards/src/parse.ts
var n = {
	text: 4e3,
	string: 600,
	tiles: 8,
	series: 4,
	points: 120,
	columns: 12,
	rows: 50,
	items: 50,
	actions: 4,
	diffLines: 24
}, r = (e) => typeof e == "object" && !!e && !Array.isArray(e);
function i(e, t = n.string) {
	if (typeof e == "number" && Number.isFinite(e)) return String(e);
	if (typeof e != "string") return;
	let r = e.trim();
	if (r) return r.length > t ? `${r.slice(0, t - 1)}…` : r;
}
function a(e) {
	if (typeof e == "number" && Number.isFinite(e)) return e;
	if (typeof e == "string" && e.trim() !== "" && Number.isFinite(Number(e))) return Number(e);
}
function o(e, t) {
	return Array.isArray(e) ? e.slice(0, t) : [];
}
function s(e) {
	let t = i(e, 2e3);
	if (t) {
		if (t.startsWith("/") && !t.startsWith("//")) return t;
		try {
			let e = new URL(t);
			return e.protocol === "https:" || e.protocol === "http:" ? e.toString() : void 0;
		} catch {
			return;
		}
	}
}
var c = (e) => e === "good" || e === "bad" || e === "neutral" ? e : void 0;
function l(e) {
	let t = [];
	for (let a of o(e, n.tiles)) {
		if (!r(a)) continue;
		let e = i(a.label), n = i(a.value);
		e && n && t.push({
			label: e,
			value: n,
			change: i(a.change),
			tone: c(a.tone)
		});
	}
	return t;
}
function u(e) {
	let t = [], a = !1;
	for (let c of o(e, n.actions)) {
		if (!r(c)) continue;
		let e = i(c.label, 60);
		if (!e) continue;
		let n = s(c.url), o = i(c.artifact, 120), l = i(c.say, 500), u = n ? {
			label: e,
			url: n
		} : o ? {
			label: e,
			artifact: o
		} : l ? {
			label: e,
			say: l
		} : { label: e };
		(u.url || u.artifact || u.say) && (c.primary === !0 && !a && (u.primary = !0, a = !0), t.push(u));
	}
	return t.length ? t : void 0;
}
var d = [
	"done",
	"waiting",
	"failed",
	"skipped"
], f = [
	"email",
	"event",
	"message",
	"action"
], p = [
	"text",
	"long",
	"number",
	"date",
	"email",
	"choice"
], m = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
function h(e, t, n = 200) {
	let r = o(e, t).flatMap((e) => i(e, n) ?? []);
	return r.length ? r : void 0;
}
var ee = {
	stats(e) {
		let t = l(e.tiles);
		return t.length ? { tiles: t } : null;
	},
	chart(e) {
		let t = e.kind === "bar" || e.kind === "area" ? e.kind : "line", s = o(e.x, n.points).map((e) => i(e, 40) ?? ""), c = o(e.series, n.series).flatMap((e) => {
			if (!r(e)) return [];
			let t = o(e.values, n.points).map(a);
			return t.length === 0 || t.some((e) => e === void 0) ? [] : [{
				name: i(e.name, 60) ?? "",
				values: t
			}];
		});
		if (!c.length) return null;
		let l = Math.max(...c.map((e) => e.values.length));
		return {
			kind: t,
			x: s.length === l ? s : Array.from({ length: l }, (e, t) => s[t] ?? ""),
			series: c,
			unit: i(e.unit, 20)
		};
	},
	table(e) {
		let t = o(e.columns, n.columns).flatMap((e) => {
			if (!r(e)) return [];
			let t = i(e.key, 60);
			return t ? [{
				key: t,
				label: i(e.label, 60) ?? t,
				align: e.align === "right" ? "right" : void 0
			}] : [];
		});
		if (!t.length || !Array.isArray(e.rows)) return null;
		let s = e.rows.filter(r), c = s.slice(0, n.rows).map((e) => {
			let n = {};
			for (let r of t) {
				let t = e[r.key];
				n[r.key] = typeof t == "number" && Number.isFinite(t) ? t : i(t, 200) ?? null;
			}
			return n;
		}), l = Math.max(a(e.total) ?? 0, s.length);
		return {
			columns: t,
			rows: c,
			total: l > c.length ? l : void 0
		};
	},
	checklist(e) {
		let t = o(e.items, n.items).flatMap((e) => {
			if (!r(e)) return [];
			let t = i(e.text);
			return t ? [{
				text: t,
				state: d.includes(e.state) ? e.state : "waiting",
				detail: i(e.detail)
			}] : [];
		});
		return t.length ? { items: t } : null;
	},
	brief(e) {
		let t = i(e.name, 120);
		if (!t) return null;
		let n = o(e.facts, 8).flatMap((e) => {
			if (!r(e)) return [];
			let t = i(e.label, 40), n = i(e.value);
			return t && n ? [{
				label: t,
				value: n
			}] : [];
		}), a = o(e.points, 8).flatMap((e) => i(e) ?? []), s = l(e.tiles);
		return {
			name: t,
			subtitle: i(e.subtitle),
			initial: i(e.initial, 2),
			points: a.length ? a : void 0,
			facts: n.length ? n : void 0,
			tiles: s.length ? s : void 0
		};
	},
	link(e) {
		let t = s(e.url);
		return t ? {
			url: t,
			title: i(e.title, 200),
			site: i(e.site, 120),
			description: i(e.description),
			image: s(e.image)
		} : null;
	},
	screenshot(e) {
		let t = s(e.image);
		return t ? {
			image: t,
			caption: i(e.caption),
			site: i(e.site, 200),
			takenAt: i(e.takenAt, 40),
			width: a(e.width),
			height: a(e.height)
		} : null;
	},
	file(e) {
		let t = s(e.url), n = i(e.name, 200);
		return !t || !n ? null : {
			url: t,
			name: n,
			size: a(e.size),
			mediaType: i(e.mediaType, 100)
		};
	},
	artifact(e) {
		let t = i(e.artifactId, 120);
		return t ? {
			artifactId: t,
			version: a(e.version),
			display: e.display === "inline" ? "inline" : "document",
			format: e.format === "markdown" ? "markdown" : e.format === "html" ? "html" : void 0,
			updatedAt: i(e.updatedAt, 40),
			url: s(e.url)
		} : null;
	},
	"pull-request"(e) {
		let t = i(e.repo, 120), c = i(e.title, 200), l = s(e.url), u = a(e.number);
		if (!t || !c || !l || u === void 0) return null;
		let d = o(e.checks, 10).flatMap((e) => {
			if (!r(e)) return [];
			let t = i(e.name, 80), n = e.state === "passed" || e.state === "failed" || e.state === "running" ? e.state : void 0;
			return t && n ? [{
				name: t,
				state: n,
				detail: i(e.detail, 120)
			}] : [];
		}), f;
		if (r(e.diff)) {
			let t = i(e.diff.file, 200), r = o(e.diff.lines, n.diffLines).flatMap((e) => typeof e == "string" ? [e.slice(0, 300)] : []);
			t && r.length && (f = {
				file: t,
				lines: r
			});
		}
		return {
			repo: t,
			number: u,
			title: c,
			url: l,
			summary: i(e.summary),
			additions: a(e.additions),
			deletions: a(e.deletions),
			checks: d.length ? d : void 0,
			diff: f,
			preview: s(e.preview),
			reviewer: i(e.reviewer, 80)
		};
	},
	receipt(e) {
		let t = i(e.merchant, 120), n = a(e.amount), o = i(e.currency, 3);
		if (!t || n === void 0 || !o) return null;
		let c;
		if (r(e.file)) {
			let t = s(e.file.url), n = i(e.file.name, 200);
			t && n && (c = {
				url: t,
				name: n
			});
		}
		return {
			merchant: t,
			amount: n,
			currency: o.toUpperCase(),
			orderId: i(e.orderId, 80),
			file: c,
			note: i(e.note)
		};
	},
	remembered(e) {
		let t = i(e.fact, 1e3);
		return t ? {
			fact: t,
			memoryId: i(e.memoryId, 120)
		} : null;
	},
	routine(e) {
		let t = i(e.name, 120), n = i(e.schedule, 200);
		if (!t || !n) return null;
		let r = o(e.posts, 6).flatMap((e) => i(e, 80) ?? []), s = i(e.cron, 100), c = a(e.offset);
		return {
			name: t,
			schedule: n,
			nextRun: i(e.nextRun, 40),
			posts: r.length ? r : void 0,
			cron: s && s.split(/\s+/).length === 5 ? s : void 0,
			offset: c !== void 0 && Math.abs(c) <= 960 ? Math.round(c) : void 0
		};
	},
	approval(e) {
		let t = f.includes(e.kind) ? e.kind : "action", a = i(e.tool, 200), s = i(e.action, 80);
		if (!a || !s) return null;
		let c = o(e.fields, 10).flatMap((e) => {
			if (!r(e)) return [];
			let t = i(e.label, 60), n = i(e.value);
			return t && n ? [{
				label: t,
				value: n
			}] : [];
		});
		return {
			kind: t,
			tool: a,
			action: s,
			service: i(e.service, 60),
			to: h(e.to, 20),
			cc: h(e.cc, 20),
			subject: i(e.subject, 300),
			body: i(e.body, n.text),
			when: i(e.when, 80),
			until: i(e.until, 80),
			where: i(e.where, 200),
			people: h(e.people, 30),
			channel: i(e.channel, 120),
			fields: c.length ? c : void 0
		};
	},
	form(e) {
		let t = /* @__PURE__ */ new Set(), n = o(e.fields, 12).flatMap((e) => {
			if (!r(e)) return [];
			let n = i(e.id, 40), a = i(e.label, 120);
			if (!n || !a || !m.test(n) || t.has(n)) return [];
			t.add(n);
			let o = p.includes(e.kind) ? e.kind : "text", s = h(e.options, 20, 120);
			return o === "choice" && !s && (o = "text"), [{
				id: n,
				label: a,
				kind: o,
				options: o === "choice" ? s : void 0,
				required: e.required === !0 || void 0,
				placeholder: i(e.placeholder, 120),
				value: i(e.value, 1e3)
			}];
		});
		return n.length ? {
			fields: n,
			submit: i(e.submit, 40)
		} : null;
	}
};
function g(e) {
	if (Array.isArray(e)) for (let t of e) g(t);
	else if (r(e)) for (let t of Object.keys(e)) e[t] === void 0 ? delete e[t] : g(e[t]);
	return e;
}
function _(t) {
	if (!r(t) || t.kyb !== 1) return null;
	let a = i(t.card, 40);
	if (!a) return null;
	let o = {
		kyb: 1,
		id: i(t.id, 120),
		title: i(t.title, 200),
		source: i(t.source, 60),
		actions: u(t.actions),
		text: i(t.text, n.text)
	};
	if (e.includes(a)) {
		let e = ee[a], n = r(t.data) ? e(t.data) : null;
		return n ? g({
			...o,
			card: a,
			data: g(n)
		}) : o.text ? g({
			...o,
			card: "unknown"
		}) : null;
	}
	return o.text ? g({
		...o,
		card: a
	}) : null;
}
// ../../cards/src/text.ts
function v(e, t) {
	try {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: t.toUpperCase()
		}).format(e / 100);
	} catch {
		return `${(e / 100).toFixed(2)} ${t.toUpperCase()}`;
	}
}
function te(e, t) {
	return t ? /^[A-Za-z]/.test(t) ? `${e} ${t}` : `${e}${t}` : e;
}
function y(e) {
	if (e.title) return e.title;
	if (t(e)) switch (e.card) {
		case "brief": return e.data.name;
		case "link": return e.data.title ?? e.data.site;
		case "file": return e.data.name;
		case "pull-request": return `${e.data.title} (#${e.data.number}, ${e.data.repo})`;
		case "receipt": return `Order placed · ${e.data.merchant}`;
		case "routine": return `Routine: ${e.data.name}`;
		case "remembered": return;
		case "approval": return e.data.service ? `${e.data.action} · ${e.data.service}` : e.data.action;
		default: return;
	}
}
// ../../cards/src/derive.ts
var ne = "[kyb:form]";
function re(e) {
	return `${ne} ${JSON.stringify(e)}`;
}
// ../../cards/src/schedule.ts
var b = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday"
];
function ie(e, t) {
	let n = e < 12 ? "AM" : "PM";
	return `${e % 12 == 0 ? 12 : e % 12}:${String(t).padStart(2, "0")} ${n}`;
}
function ae(e) {
	let t = e.trim().split(/\s+/);
	if (t.length !== 5) return e.trim();
	let [n, r, i, a, o] = t;
	if (a !== "*") return e.trim();
	if (/^\*\/\d+$/.test(n) && r === "*") return `Every ${n.slice(2)} minutes`;
	if (/^\*\/\d+$/.test(r) && /^\d+$/.test(n)) return `Every ${r.slice(2)} hours`;
	if (r === "*" && /^\d+$/.test(n)) return n === "0" ? "Every hour, on the hour" : `Every hour at :${n.padStart(2, "0")}`;
	if (/^\d+$/.test(r) && /^\d+$/.test(n) && Number(r) < 24 && Number(n) < 60) {
		let e = `at ${ie(Number(r), Number(n))}`;
		if (i === "*") {
			if (o === "*") return `Every day ${e}`;
			if (o === "1-5") return `Weekdays ${e}`;
			if (o === "0,6" || o === "6,0") return `Weekends ${e}`;
			if (/^[0-7]$/.test(o)) return `Every ${b[Number(o) % 7]} ${e}`;
			if (/^[0-7](,[0-7])+$/.test(o)) {
				let t = o.split(",").map((e) => b[Number(e) % 7]);
				return `${t.slice(0, -1).join(", ")} and ${t.at(-1)} ${e}`;
			}
		} else if (/^\d+$/.test(i) && o === "*") return `Monthly on day ${i} ${e}`;
	}
	return e.trim();
}
function oe(e, t, n) {
	let r = /* @__PURE__ */ new Set();
	for (let i of e.split(",")) {
		let e = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(i);
		if (!e) return null;
		let a = e[2] ? Number(e[2]) : 1;
		if (a < 1) return null;
		let o = t, s = n;
		if (e[1] !== "*") {
			let [t, r] = e[1].split("-").map(Number);
			o = t, s = r ?? (e[2] ? n : t);
		}
		if (o < t || s > n || o > s) return null;
		for (let e = o; e <= s; e += a) r.add(e);
	}
	return r;
}
var x = (e, t) => (e % t + t) % t;
function se(e) {
	let t = oe(e, 0, 7);
	return t ? [...new Set([...t].map((e) => e % 7))].sort((e, t) => e - t) : null;
}
function ce(e) {
	let t = e.join(",");
	return t === "1,2,3,4,5" ? "1-5" : t === "0,6" ? "0,6" : e.length === 7 ? "*" : [...e].sort((e, t) => (e === 0 ? 7 : e) - (t === 0 ? 7 : t)).join(",");
}
function le(e, t) {
	let n = e.trim().split(/\s+/);
	if (n.length !== 5) return;
	let [r, i, a, o, s] = n;
	if (o !== "*") return;
	if (t === 0 || /^\*\/\d+$/.test(r) && i === "*") return n.join(" ");
	if (/^\d+$/.test(r) && (i === "*" || /^\*\/\d+$/.test(i))) return [
		String(x(Number(r) + t, 60)),
		i,
		a,
		o,
		s
	].join(" ");
	if (!/^\d+$/.test(r) || !/^\d+$/.test(i)) return;
	let c = Number(i) * 60 + Number(r) + t, l = Math.floor(c / 1440), u = x(c, 1440), d = s;
	if (s !== "*" && l !== 0) {
		let e = se(s);
		if (!e) return;
		d = ce(e.map((e) => x(e + l, 7)).sort((e, t) => e - t));
	}
	if (a === "*" || l === 0) return [
		String(u % 60),
		String(Math.floor(u / 60)),
		a,
		o,
		d
	].join(" ");
}
function ue(e) {
	if (!e.cron || typeof e.offset != "number") return e.schedule;
	let t = e.nextRun ? new Date(e.nextRun) : /* @__PURE__ */ new Date();
	if (Number.isNaN(t.getTime())) return e.schedule;
	let n = -t.getTimezoneOffset() - e.offset, r = le(e.cron, n);
	if (!r) return e.schedule;
	let i = ae(r);
	return i === r.trim() ? e.schedule : i;
}
var de = /<!-- kyb:card v1 (\{[\s\S]*?\}) -->/g;
function fe(e) {
	if (!e.includes("<!-- kyb:card v1 ")) return [];
	let t = [];
	for (let n of e.matchAll(de)) try {
		let e = _(JSON.parse(n[1]));
		e && t.push(e);
	} catch {}
	return t;
}
var pe = "<!-- kyb:answer v1 ", me = /<!-- kyb:ask v1 (\{[\s\S]*?\}) -->/g, S = (e) => typeof e == "object" && !!e && !Array.isArray(e), C = (e, t) => typeof e == "string" && e.trim() ? e.slice(0, t) : void 0, w = (e) => {
	for (let t of Object.keys(e)) e[t] === void 0 && delete e[t];
	return e;
};
function he(e) {
	if (S(e) && C(e.kind, 40)) return w({
		kind: C(e.kind, 40),
		site: C(e.site, 500),
		label: C(e.label, 200),
		reason: C(e.reason, 1e3)
	});
}
function ge(e) {
	if (!S(e) || !C(e.id, 200) || typeof e.amount != "number" || !Number.isFinite(e.amount) || !C(e.currency, 10)) return;
	let t = (e) => typeof e == "string" && /^https:\/\//i.test(e) ? e.slice(0, 2e3) : void 0;
	return w({
		id: C(e.id, 200),
		amount: e.amount,
		currency: C(e.currency, 10),
		merchant: C(e.merchant, 200),
		merchant_url: t(e.merchant_url),
		approval_url: t(e.approval_url)
	});
}
var _e = (e) => JSON.stringify(e).replace(/--/g, "-\\u002d");
function ve(e) {
	if (!S(e) || !C(e.requestId, 200) || typeof e.text != "string") return null;
	let t = Array.isArray(e.options) ? e.options.flatMap((e) => S(e) && C(e.id, 200) && C(e.label, 500) ? [w({
		id: C(e.id, 200),
		label: C(e.label, 500),
		description: C(e.description, 1e3),
		style: C(e.style, 40)
	})] : []) : [];
	return w({
		requestId: C(e.requestId, 200),
		kind: C(e.kind, 40) ?? "question",
		text: e.text.slice(0, 8e3),
		options: t.length ? t : void 0,
		allowFreeform: e.allowFreeform === !0 || void 0,
		card: S(e.card) ? _(e.card) ?? void 0 : void 0,
		vault: he(e.vault),
		spend: ge(e.spend)
	});
}
function ye(e) {
	if (!e.includes("<!-- kyb:ask v1 ")) return [];
	let t = [];
	for (let n of e.matchAll(me)) try {
		let e = ve(JSON.parse(n[1]));
		e && t.push(e);
	} catch {}
	return t;
}
var be = 8e3;
function xe(e, t) {
	let n = { requestId: e.requestId };
	return e.optionId && (n.optionId = e.optionId), e.text !== void 0 && (n.text = e.text.slice(0, be)), `${t.trim() || "Answered"}\n\n${pe}${_e(n)} -->`;
}
// src/react.ts
var T;
function Se(e) {
	T = e;
}
function E() {
	if (!T) throw Error("React is not bound yet");
	return T;
}
var D = ((e) => E().useState(e)), O = (e, t) => E().useEffect(e, t), k = ((e) => E().useRef(e)), Ce = ((...e) => E().createElement(...e));
function we() {
	return E().Fragment;
}
// src/jsx-runtime.ts
var A = Symbol.for("kyb.fragment"), j = Ce;
function M(e, t, n, r) {
	let i = e === A ? we() : e, { children: a, ...o } = t ?? {}, s = n === void 0 ? o : {
		...o,
		key: n
	};
	return a === void 0 ? j(i, s) : r && Array.isArray(a) ? j(i, s, ...a) : j(i, s, a);
}
var N = (e, t, n) => M(e, t, n, !1), P = (e, t, n) => M(e, t, n, !0), F = (e) => /^https?:\/\//i.test(e);
function Te(e, t) {
	return F(e) ? e : t.agentUrl ? new URL(e, t.agentUrl).toString() : null;
}
function I(e, t) {
	let n = Te(e, t);
	n && t.openUrl(n);
}
function L(e, t, n) {
	n.openFile ? n.openFile(e, t) : I(e, n);
}
function Ee(e) {
	return e < 1024 ? `${e} B` : e < 1048576 ? `${Math.round(e / 1024)} KB` : `${(e / 1048576).toFixed(1)} MB`;
}
function R({ className: e }) {
	return /* @__PURE__ */ N("div", {
		className: e,
		role: "status",
		"aria-label": "Loading",
		children: /* @__PURE__ */ N("span", { className: "kspin" })
	});
}
function De(e, t) {
	return e.artifact ? !!t.onOpenArtifact : e.say ? !!t.onSay : !!e.url;
}
function Oe({ actions: e, ctx: t }) {
	let n = e?.filter((e) => De(e, t)) ?? [];
	return n.length ? /* @__PURE__ */ N("div", {
		className: "kcard__actions",
		children: n.map((e, n) => /* @__PURE__ */ N("button", {
			type: "button",
			className: `kbtn${e.primary ? " kbtn--primary" : ""}`,
			onClick: () => {
				e.artifact ? t.onOpenArtifact?.(e.artifact) : e.url ? I(e.url, t) : e.say && t.onSay?.(e.say);
			},
			children: e.label
		}, n))
	}) : null;
}
function ke(e) {
	return e === "good" ? " is-good" : e === "bad" ? " is-bad" : "";
}
function z({ tiles: e }) {
	return /* @__PURE__ */ N("div", {
		className: "kstats",
		children: e.map((e, t) => /* @__PURE__ */ P("div", {
			className: "kstats__tile",
			children: [
				/* @__PURE__ */ N("div", {
					className: "klabel",
					children: e.label
				}),
				/* @__PURE__ */ N("div", {
					className: "kstats__value",
					children: e.value
				}),
				e.change ? /* @__PURE__ */ N("div", {
					className: `kstats__change${ke(e.tone)}`,
					children: e.change
				}) : null
			]
		}, t))
	});
}
function Ae({ data: e }) {
	let [t, n] = D(null), r = k(null), i = e.x.length, a = e.series.flatMap((e) => e.values), o = Math.min(0, ...a), s = Math.max(...a, o + 1), c = (e) => 154 - (e - o) / (s - o) * 148, l = (e) => i <= 1 ? 300 : e / (i - 1) * 600, u = (t) => te(t.toLocaleString(), e.unit), d = e.kind === "bar", f = (e) => d ? (e + .5) / Math.max(1, i) : l(e) / 600, p = e.series.map((t, n) => {
		if (e.kind === "bar") {
			let r = 600 / Math.max(1, i), a = r * .7 / e.series.length;
			return t.values.map((e, t) => /* @__PURE__ */ N("rect", {
				className: `kchart__bar kchart__s${n}`,
				x: t * r + r * .15 + n * a,
				y: Math.min(c(e), c(0)),
				width: Math.max(1, a - 1),
				height: Math.abs(c(0) - c(e))
			}, `${n}-${t}`));
		}
		let r = t.values.map((e, t) => `${l(t)},${c(e)}`).join(" ");
		return /* @__PURE__ */ P("g", { children: [e.kind === "area" && n === 0 ? /* @__PURE__ */ N("polygon", {
			className: `kchart__area kchart__s${n}`,
			points: `${l(0)},${c(o)} ${r} ${l(t.values.length - 1)},${c(o)}`
		}) : null, /* @__PURE__ */ N("polyline", {
			className: `kchart__line kchart__s${n}`,
			points: r,
			vectorEffect: "non-scaling-stroke"
		})] }, n);
	}), m = (t) => e.x[t] ?? "", h = i <= (d ? 12 : 8) ? [...Array(i).keys()] : [
		0,
		Math.floor((i - 1) / 2),
		i - 1
	];
	return /* @__PURE__ */ P("div", {
		className: "kchart",
		children: [e.series.length > 1 ? /* @__PURE__ */ N("div", {
			className: "kchart__legend",
			children: e.series.map((e, t) => /* @__PURE__ */ P("span", {
				className: "kchart__key",
				children: [/* @__PURE__ */ N("span", { className: `kchart__swatch kchart__s${t}` }), e.name]
			}, t))
		}) : null, /* @__PURE__ */ P("div", {
			className: "kchart__plot",
			children: [/* @__PURE__ */ P("div", {
				className: "kchart__y",
				children: [/* @__PURE__ */ N("span", { children: u(s) }), /* @__PURE__ */ N("span", { children: u(o) })]
			}), /* @__PURE__ */ P("div", {
				className: "kchart__frame",
				children: [
					/* @__PURE__ */ P("svg", {
						ref: r,
						viewBox: "0 0 600 160",
						preserveAspectRatio: "none",
						className: "kchart__svg",
						onMouseMove: (e) => {
							let t = r.current?.getBoundingClientRect();
							if (!t || i === 0) return;
							let a = (e.clientX - t.left) / t.width, o = d ? Math.floor(a * i) : Math.round(a * (i - 1));
							n(Math.max(0, Math.min(i - 1, o)));
						},
						onMouseLeave: () => n(null),
						children: [
							/* @__PURE__ */ N("line", {
								className: "kchart__base",
								x1: 0,
								x2: 600,
								y1: c(0),
								y2: c(0),
								vectorEffect: "non-scaling-stroke"
							}),
							p,
							t === null ? null : /* @__PURE__ */ N("line", {
								className: "kchart__rule",
								x1: f(t) * 600,
								x2: f(t) * 600,
								y1: 0,
								y2: 160,
								vectorEffect: "non-scaling-stroke"
							})
						]
					}),
					t === null ? null : /* @__PURE__ */ P("div", {
						className: "kchart__tip",
						style: { left: `${f(t) * 100}%` },
						children: [/* @__PURE__ */ N("div", {
							className: "klabel",
							children: m(t)
						}), e.series.map((n, r) => /* @__PURE__ */ P("div", { children: [e.series.length > 1 ? `${n.name} ` : "", /* @__PURE__ */ N("strong", { children: u(n.values[t] ?? 0) })] }, r))]
					}),
					/* @__PURE__ */ N("div", {
						className: d ? "kchart__x kchart__x--slots" : "kchart__x",
						style: d ? { gridTemplateColumns: `repeat(${i}, 1fr)` } : void 0,
						children: d ? e.x.map((e, t) => /* @__PURE__ */ N("span", { children: h.includes(t) ? m(t) : "" }, t)) : h.map((e) => /* @__PURE__ */ N("span", { children: m(e) }, e))
					})
				]
			})]
		})]
	});
}
function je({ src: e, alt: t, ctx: n }) {
	let [r, i] = D(null), [a, o] = D(!1);
	return O(() => {
		let t = !0;
		if (e.startsWith("data:image/")) i({ url: e });
		else if (!n.loadImage) i(F(e) ? { url: e } : { error: "This picture is on the agent and can't be shown here." });
		else if (!n.agentUrl && !F(e)) i({ error: "No agent address to fetch this from." });
		else return i(null), n.loadImage(e).then((e) => {
			t && i(e.ok ? { url: e.dataUrl } : { error: e.error });
		}), () => {
			t = !1;
		};
	}, [
		e,
		n.agentUrl,
		n.loadImage
	]), r ? r.url ? /* @__PURE__ */ N("img", {
		className: `kshot__img${a ? " kshot__img--big" : ""}`,
		src: r.url,
		alt: t,
		onClick: () => o((e) => !e),
		title: a ? "Smaller" : "Larger"
	}) : /* @__PURE__ */ P("div", {
		className: "kshot__missing",
		children: [r.error, F(e) ? /* @__PURE__ */ N("button", {
			type: "button",
			className: "kbtn",
			onClick: () => n.openUrl(e),
			children: "Open in browser"
		}) : null]
	}) : /* @__PURE__ */ N(R, { className: "kshot__wait" });
}
function Me(e) {
	return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:">${e}`;
}
var Ne = {
	inline: "kartifact--inline",
	preview: "kartifact--preview",
	full: ""
};
function B({ artifactId: e, version: t, className: n, mode: r = "full", ctx: i }) {
	let [a, o] = D(null);
	O(() => {
		let n = !0;
		if (o(null), !i.loadArtifact) o({ error: "This artifact can't be shown here." });
		else return i.loadArtifact(e, t).then((e) => {
			n && o(e.ok ? {
				content: e.content,
				format: e.format
			} : { error: e.error });
		}), () => {
			n = !1;
		};
	}, [
		e,
		t,
		i.loadArtifact
	]);
	let s = [Ne[r], n].filter(Boolean).join(" ");
	return a ? a.error ? /* @__PURE__ */ N("div", {
		className: `kartifact__missing ${s}`,
		children: a.error
	}) : a.format === "markdown" ? /* @__PURE__ */ N("div", {
		className: `kartifact__doc ${s}`,
		children: i.renderMarkdown ? i.renderMarkdown(a.content ?? "") : /* @__PURE__ */ N("div", {
			className: "kartifact__plain",
			children: a.content
		})
	}) : i.renderArtifactHtml ? /* @__PURE__ */ N("div", {
		className: `kartifact__host ${s}`,
		children: i.renderArtifactHtml(a.content ?? "", r)
	}) : /* @__PURE__ */ N("iframe", {
		className: `kartifact__frame ${s}`,
		sandbox: "allow-scripts",
		srcDoc: Me(a.content ?? ""),
		title: "Artifact",
		referrerPolicy: "no-referrer"
	}) : /* @__PURE__ */ N(R, { className: `kartifact__wait ${s}` });
}
function V(e) {
	if (!e) return;
	let t = Date.parse(e);
	if (!Number.isNaN(t)) return new Date(t).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit"
	});
}
function Pe({ data: e, title: t, ctx: n }) {
	let r = [
		e.format === "markdown" ? "Document" : "Page",
		e.version ? `v${e.version}` : void 0,
		V(e.updatedAt) ? `updated ${V(e.updatedAt)}` : void 0
	].filter(Boolean), i = e.url, a = n.onOpenArtifact ?? (i ? () => I(i, n) : void 0), o = n.renderArtifact?.(e, t);
	return /* @__PURE__ */ P(A, { children: [
		o == null ? n.loadArtifact ? e.display === "inline" ? /* @__PURE__ */ N(B, {
			artifactId: e.artifactId,
			version: e.version,
			mode: "inline",
			ctx: n
		}) : a ? /* @__PURE__ */ N("button", {
			type: "button",
			className: "kartifact__preview",
			"aria-label": `Open ${t ?? "artifact"}`,
			onClick: () => a(e.artifactId, t, e.version),
			children: /* @__PURE__ */ N(B, {
				artifactId: e.artifactId,
				version: e.version,
				mode: "preview",
				ctx: n
			})
		}) : /* @__PURE__ */ N("div", {
			className: "kartifact__preview",
			children: /* @__PURE__ */ N(B, {
				artifactId: e.artifactId,
				version: e.version,
				mode: "preview",
				ctx: n
			})
		}) : null : /* @__PURE__ */ N("div", {
			className: "kartifact__host",
			children: o
		}),
		/* @__PURE__ */ N("div", {
			className: "kartifact__row",
			children: /* @__PURE__ */ N("span", {
				className: "kartifact__meta",
				children: r.join(" · ")
			})
		}),
		a ? /* @__PURE__ */ N("div", {
			className: "kcard__actions",
			children: /* @__PURE__ */ N("button", {
				type: "button",
				className: "kbtn kbtn--primary",
				onClick: () => a(e.artifactId, t, e.version),
				children: "Open"
			})
		}) : null
	] });
}
function Fe(e, t) {
	if (!e) return;
	let n = /^\d{4}-\d{2}-\d{2}$/, r = Date.parse(e);
	if (Number.isNaN(r)) return t ? `${e} – ${t}` : e;
	if (n.test(e)) return (/* @__PURE__ */ new Date(`${e}T00:00:00`)).toLocaleDateString([], {
		weekday: "short",
		day: "numeric",
		month: "short"
	});
	let i = new Date(r), a = i.toLocaleString([], {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit"
	}), o = t ? Date.parse(t) : NaN;
	if (Number.isNaN(o)) return a;
	let s = new Date(o).toDateString() === i.toDateString();
	return `${a} – ${new Date(o).toLocaleString([], s ? {
		hour: "numeric",
		minute: "2-digit"
	} : {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "numeric",
		minute: "2-digit"
	})}`;
}
function H({ data: e }) {
	let t = [];
	if (e.kind === "email") e.to?.length && t.push(["To", e.to.join(", ")]), e.cc?.length && t.push(["Cc", e.cc.join(", ")]), e.subject && t.push(["Subject", e.subject]);
	else if (e.kind === "event") {
		e.subject && t.push(["Event", e.subject]);
		let n = Fe(e.when, e.until);
		n && t.push(["When", n]), e.where && t.push(["Where", e.where]), e.people?.length && t.push(["With", e.people.join(", ")]);
	} else e.kind === "message" && (e.channel && t.push(["In", e.channel]), e.to?.length && t.push(["To", e.to.join(", ")]));
	for (let n of e.fields ?? []) t.push([n.label, n.value]);
	return /* @__PURE__ */ P("div", {
		className: "kapproval",
		children: [t.length ? /* @__PURE__ */ N("dl", {
			className: "kapproval__rows",
			children: t.map(([e, t], n) => /* @__PURE__ */ P("div", {
				className: "kapproval__row",
				children: [/* @__PURE__ */ N("dt", {
					className: "klabel",
					children: e
				}), /* @__PURE__ */ N("dd", { children: t })]
			}, n))
		}) : null, e.body ? /* @__PURE__ */ N("div", {
			className: "kapproval__body",
			children: e.body
		}) : null]
	});
}
function U({ state: e }) {
	return e === "passed" || e === "done" ? /* @__PURE__ */ N("span", {
		className: "kglyph is-good",
		children: "✓"
	}) : e === "failed" ? /* @__PURE__ */ N("span", {
		className: "kglyph is-bad",
		children: "✗"
	}) : e === "running" ? /* @__PURE__ */ N("span", {
		className: "kglyph",
		children: "…"
	}) : e === "skipped" ? /* @__PURE__ */ N("span", {
		className: "kglyph",
		children: "–"
	}) : /* @__PURE__ */ N("span", {
		className: "kglyph",
		children: "○"
	});
}
function Ie() {
	return /* @__PURE__ */ P("svg", {
		className: "kfile__icon",
		width: "18",
		height: "18",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "1.6",
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true",
		children: [/* @__PURE__ */ N("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }), /* @__PURE__ */ N("path", { d: "M14 3v5h5" })]
	});
}
function Le({ card: e, ctx: t }) {
	switch (e.card) {
		case "stats": return /* @__PURE__ */ N(z, { tiles: e.data.tiles });
		case "chart": return /* @__PURE__ */ N(Ae, { data: e.data });
		case "table": {
			let t = e.data, n = (e) => e == null ? "" : typeof e == "number" ? e.toLocaleString() : String(e);
			return /* @__PURE__ */ P("div", {
				className: "ktable",
				children: [/* @__PURE__ */ P("table", { children: [/* @__PURE__ */ N("thead", { children: /* @__PURE__ */ N("tr", { children: t.columns.map((e) => /* @__PURE__ */ N("th", {
					style: e.align === "right" ? { textAlign: "right" } : void 0,
					children: e.label
				}, e.key)) }) }), /* @__PURE__ */ N("tbody", { children: t.rows.map((e, r) => /* @__PURE__ */ N("tr", { children: t.columns.map((t) => /* @__PURE__ */ N("td", {
					style: t.align === "right" || typeof e[t.key] == "number" ? { textAlign: "right" } : void 0,
					children: n(e[t.key])
				}, t.key)) }, r)) })] }), t.total && t.total > t.rows.length ? /* @__PURE__ */ P("div", {
					className: "ktable__more",
					children: [
						"Showing ",
						t.rows.length.toLocaleString(),
						" of ",
						t.total.toLocaleString(),
						" rows"
					]
				}) : null]
			});
		}
		case "checklist": return /* @__PURE__ */ N("ul", {
			className: "kcheck",
			children: e.data.items.map((e, t) => /* @__PURE__ */ P("li", {
				className: `kcheck__item kcheck__item--${e.state}`,
				children: [/* @__PURE__ */ N(U, { state: e.state }), /* @__PURE__ */ P("span", { children: [e.text, e.detail ? /* @__PURE__ */ P("span", {
					className: "kcheck__detail",
					children: [" ", e.detail]
				}) : null] })]
			}, t))
		});
		case "brief": {
			let t = e.data;
			return /* @__PURE__ */ P("div", {
				className: "kbrief",
				children: [
					/* @__PURE__ */ P("div", {
						className: "kbrief__head",
						children: [/* @__PURE__ */ N("span", {
							className: "kbrief__initial",
							children: (t.initial ?? t.name.slice(0, 1)).toUpperCase()
						}), /* @__PURE__ */ P("div", { children: [/* @__PURE__ */ N("div", {
							className: "kbrief__name",
							children: t.name
						}), t.subtitle ? /* @__PURE__ */ N("div", {
							className: "kbrief__sub",
							children: t.subtitle
						}) : null] })]
					}),
					t.points?.length ? /* @__PURE__ */ N("ul", {
						className: "kbrief__points",
						children: t.points.map((e, t) => /* @__PURE__ */ N("li", { children: e }, t))
					}) : null,
					t.facts?.length ? /* @__PURE__ */ N("dl", {
						className: "kbrief__facts",
						children: t.facts.map((e, t) => /* @__PURE__ */ P("div", { children: [/* @__PURE__ */ N("dt", {
							className: "klabel",
							children: e.label
						}), /* @__PURE__ */ N("dd", { children: e.value })] }, t))
					}) : null,
					t.tiles?.length ? /* @__PURE__ */ N(z, { tiles: t.tiles }) : null
				]
			});
		}
		case "link": {
			let n = e.data;
			return /* @__PURE__ */ P("button", {
				type: "button",
				className: "klink",
				onClick: () => I(n.url, t),
				children: [n.description ? /* @__PURE__ */ N("div", {
					className: "klink__desc",
					children: n.description
				}) : null, /* @__PURE__ */ N("div", {
					className: "klink__url",
					children: n.site ?? n.url
				})]
			});
		}
		case "screenshot": {
			let n = e.data;
			return /* @__PURE__ */ P("div", {
				className: "kshot",
				children: [/* @__PURE__ */ N(je, {
					src: n.image,
					alt: n.caption ?? "Screenshot",
					ctx: t
				}), n.caption || n.site ? /* @__PURE__ */ P("div", {
					className: "kshot__caption",
					children: [n.caption, n.site ? /* @__PURE__ */ N("span", {
						className: "kshot__site",
						children: n.site
					}) : null]
				}) : null]
			});
		}
		case "file": {
			let n = e.data;
			return /* @__PURE__ */ P("div", {
				className: "kfile",
				children: [
					/* @__PURE__ */ N(Ie, {}),
					/* @__PURE__ */ P("div", {
						className: "kfile__name",
						children: [n.name, n.size ? /* @__PURE__ */ N("span", {
							className: "kfile__size",
							children: Ee(n.size)
						}) : null]
					}),
					F(n.url) ? /* @__PURE__ */ N("button", {
						type: "button",
						className: "kbtn",
						onClick: () => L(n.url, n.name, t),
						children: "Open"
					}) : null
				]
			});
		}
		case "artifact": return /* @__PURE__ */ N(Pe, {
			data: e.data,
			title: e.title,
			ctx: t
		});
		case "pull-request": {
			let n = e.data;
			return /* @__PURE__ */ P("div", {
				className: "kpr",
				children: [
					n.summary ? /* @__PURE__ */ N("div", {
						className: "kpr__summary",
						children: n.summary
					}) : null,
					n.additions !== void 0 || n.deletions !== void 0 ? /* @__PURE__ */ P("div", {
						className: "kpr__delta",
						children: [
							/* @__PURE__ */ P("span", {
								className: "is-good",
								children: ["+", n.additions ?? 0]
							}),
							" ",
							/* @__PURE__ */ P("span", {
								className: "is-bad",
								children: ["−", n.deletions ?? 0]
							})
						]
					}) : null,
					n.checks?.length ? /* @__PURE__ */ N("ul", {
						className: "kcheck",
						children: n.checks.map((e, t) => /* @__PURE__ */ P("li", {
							className: "kcheck__item",
							children: [/* @__PURE__ */ N(U, { state: e.state }), /* @__PURE__ */ P("span", { children: [e.name, e.detail ? /* @__PURE__ */ P("span", {
								className: "kcheck__detail",
								children: [" ", e.detail]
							}) : null] })]
						}, t))
					}) : null,
					n.diff ? /* @__PURE__ */ P("div", {
						className: "kdiff",
						children: [/* @__PURE__ */ N("div", {
							className: "kdiff__file",
							children: n.diff.file
						}), n.diff.lines.map((e, t) => /* @__PURE__ */ N("div", {
							className: `kdiff__line${e.startsWith("+") ? " is-good" : e.startsWith("-") ? " is-bad" : ""}`,
							children: e
						}, t))]
					}) : null,
					n.reviewer ? /* @__PURE__ */ P("div", {
						className: "kpr__meta",
						children: ["Review: ", n.reviewer]
					}) : null,
					/* @__PURE__ */ P("div", {
						className: "kcard__actions",
						children: [/* @__PURE__ */ N("button", {
							type: "button",
							className: "kbtn",
							onClick: () => I(n.url, t),
							children: "View pull request"
						}), n.preview ? /* @__PURE__ */ N("button", {
							type: "button",
							className: "kbtn",
							onClick: () => I(n.preview, t),
							children: "Preview"
						}) : null]
					})
				]
			});
		}
		case "receipt": {
			let n = e.data;
			return /* @__PURE__ */ P("div", {
				className: "kreceipt",
				children: [
					/* @__PURE__ */ N("div", {
						className: "kreceipt__amount",
						children: v(n.amount, n.currency)
					}),
					n.orderId ? /* @__PURE__ */ P("div", {
						className: "kreceipt__meta",
						children: ["Order ", n.orderId]
					}) : null,
					n.note ? /* @__PURE__ */ N("div", {
						className: "kreceipt__note",
						children: n.note
					}) : null,
					n.file && F(n.file.url) ? /* @__PURE__ */ N("button", {
						type: "button",
						className: "kbtn",
						onClick: () => L(n.file.url, n.file.name, t),
						children: n.file.name
					}) : null
				]
			});
		}
		case "remembered": return /* @__PURE__ */ N("div", {
			className: "kremember",
			children: e.data.fact
		});
		case "approval": return /* @__PURE__ */ N(H, { data: e.data });
		case "form": return /* @__PURE__ */ N("ol", {
			className: "kform__list",
			children: e.data.fields.map((e) => /* @__PURE__ */ N("li", { children: e.label }, e.id))
		});
		case "routine": {
			let t = e.data;
			return /* @__PURE__ */ P("div", {
				className: "kroutine",
				children: [
					/* @__PURE__ */ N("div", { children: ue(t) }),
					t.nextRun ? /* @__PURE__ */ P("div", {
						className: "kroutine__meta",
						children: ["Next run ", V(t.nextRun)]
					}) : null,
					t.posts?.length ? /* @__PURE__ */ P("div", {
						className: "kroutine__meta",
						children: ["Posts to ", t.posts.join(", ")]
					}) : null
				]
			});
		}
	}
}
var Re = {
	remembered: "Memory",
	artifact: "Artifact",
	screenshot: "Computer",
	receipt: "Payments",
	"pull-request": "GitHub",
	routine: "Routine",
	form: "Question"
};
function W({ card: e, ctx: n }) {
	let r = y(e), i = e.source ?? Re[e.card], a = t(e), o = e.card === "remembered";
	return /* @__PURE__ */ P("div", {
		className: `kcard kcard--${a ? e.card : "unknown"}${o ? " kcard--compact" : ""}`,
		children: [
			r || i ? /* @__PURE__ */ P("div", {
				className: "kcard__head",
				children: [r ? /* @__PURE__ */ N("span", {
					className: "kcard__title",
					children: r
				}) : /* @__PURE__ */ N("span", { className: "kcard__title" }), i ? /* @__PURE__ */ N("span", {
					className: "klabel kcard__source",
					children: i
				}) : null]
			}) : null,
			a ? /* @__PURE__ */ N(Le, {
				card: e,
				ctx: n
			}) : /* @__PURE__ */ N("div", {
				className: "kcard__text",
				children: e.text
			}),
			/* @__PURE__ */ N(Oe, {
				actions: e.card === "artifact" ? e.actions?.filter((e) => !e.artifact) : e.actions,
				ctx: n
			})
		]
	});
}
function ze({ cards: e, ctx: t }) {
	return e.length === 0 ? null : /* @__PURE__ */ N("div", {
		className: "kcards",
		children: e.map((e, n) => /* @__PURE__ */ N(W, {
			card: e,
			ctx: t
		}, e.id ?? n))
	});
}
// ../../cards-react/src/AskView.tsx
function G(e) {
	try {
		return new URL(e).hostname.replace(/^www\./, "");
	} catch {
		return e;
	}
}
function K({ title: e, label: t, good: n, detail: r }) {
	return /* @__PURE__ */ P("div", {
		className: "kcard kask is-done",
		children: [/* @__PURE__ */ P("div", {
			className: "kcard__head",
			children: [/* @__PURE__ */ N("span", {
				className: "kcard__title",
				children: e
			}), /* @__PURE__ */ N("span", {
				className: `kpill${n ? " is-good" : ""}`,
				children: t
			})]
		}), r ? /* @__PURE__ */ N("div", {
			className: "kcard__text",
			children: r
		}) : null]
	});
}
function q({ error: e, sending: t }) {
	return e ? /* @__PURE__ */ N("div", {
		className: "kask__error",
		children: e
	}) : t ? /* @__PURE__ */ N("div", {
		className: "kask__note",
		children: "Sending…"
	}) : null;
}
function Be({ ask: e, data: t, title: n, props: r }) {
	let i = t.kind !== "action" && (t.subject !== void 0 || t.body !== void 0), [a, o] = D(!1), [s, c] = D(t.subject ?? ""), [l, u] = D(t.body ?? ""), d = t.kind === "email" || t.kind === "message", f = e.options?.find((e) => e.id === "approve") ? "approve" : e.options?.[0]?.id ?? "approve", p = r.sending === !0;
	return /* @__PURE__ */ P("div", {
		className: "kcard kcard--approval kask",
		children: [
			/* @__PURE__ */ P("div", {
				className: "kcard__head",
				children: [/* @__PURE__ */ N("span", {
					className: "kcard__title",
					children: n
				}), t.service ? /* @__PURE__ */ N("span", {
					className: "klabel kcard__source",
					children: t.service
				}) : null]
			}),
			a ? /* @__PURE__ */ P("div", {
				className: "kform",
				children: [t.subject === void 0 ? null : /* @__PURE__ */ P("label", {
					className: "kform__field",
					children: [/* @__PURE__ */ N("span", {
						className: "klabel",
						children: t.kind === "event" ? "Event" : "Subject"
					}), /* @__PURE__ */ N("input", {
						className: "kinput",
						value: s,
						onChange: (e) => c(e.target.value)
					})]
				}), /* @__PURE__ */ P("label", {
					className: "kform__field",
					children: [/* @__PURE__ */ N("span", {
						className: "klabel",
						children: t.kind === "event" ? "Description" : "Message"
					}), /* @__PURE__ */ N("textarea", {
						className: "kinput kinput--long",
						rows: 8,
						value: l,
						onChange: (e) => u(e.target.value)
					})]
				})]
			}) : /* @__PURE__ */ N(H, { data: t }),
			/* @__PURE__ */ N("div", {
				className: "kcard__actions",
				children: a ? /* @__PURE__ */ P(A, { children: [/* @__PURE__ */ N("button", {
					type: "button",
					className: "kbtn kbtn--primary",
					disabled: p,
					onClick: () => {
						let e = ["Not as written. Make it again with these changes, then ask me again."];
						s.trim() !== (t.subject ?? "") && e.push(`${t.kind === "event" ? "Title" : "Subject"}: ${s.trim()}`), l !== (t.body ?? "") && e.push(`${t.kind === "event" ? "Description" : "Body"}:\n${l.trim()}`), r.onAnswer({
							optionId: "cancel",
							text: e.join("\n"),
							label: "Sent back with changes"
						});
					},
					children: "Send back with changes"
				}), /* @__PURE__ */ N("button", {
					type: "button",
					className: "kbtn",
					disabled: p,
					onClick: () => o(!1),
					children: "Never mind"
				})] }) : /* @__PURE__ */ P(A, { children: [
					/* @__PURE__ */ N("button", {
						type: "button",
						className: "kbtn kbtn--primary",
						disabled: p,
						onClick: () => r.onAnswer({
							optionId: f,
							label: "Approved"
						}),
						children: d ? t.action === "Save draft" ? "Save it" : "Send it" : "Approve"
					}),
					i ? /* @__PURE__ */ N("button", {
						type: "button",
						className: "kbtn",
						disabled: p,
						onClick: () => o(!0),
						children: "Edit"
					}) : null,
					/* @__PURE__ */ N("button", {
						type: "button",
						className: "kbtn",
						disabled: p,
						onClick: () => r.onAnswer({
							optionId: "cancel",
							label: "Declined"
						}),
						children: d ? "Don't send" : "Decline"
					})
				] })
			}),
			/* @__PURE__ */ N(q, {
				error: r.error,
				sending: r.sending
			})
		]
	});
}
function Ve({ field: e, value: t, onChange: n }) {
	return e.kind === "long" ? /* @__PURE__ */ N("textarea", {
		className: "kinput kinput--long",
		rows: 4,
		value: t,
		placeholder: e.placeholder,
		onChange: (e) => n(e.target.value)
	}) : e.kind === "choice" && e.options?.length ? /* @__PURE__ */ N("div", {
		className: "kform__choices",
		children: e.options.map((e) => /* @__PURE__ */ N("button", {
			type: "button",
			className: `kbtn${t === e ? " kbtn--primary" : ""}`,
			onClick: () => n(e),
			children: e
		}, e))
	}) : /* @__PURE__ */ N("input", {
		className: "kinput",
		type: e.kind === "number" ? "number" : e.kind === "date" ? "date" : e.kind === "email" ? "email" : "text",
		value: t,
		placeholder: e.placeholder,
		onChange: (e) => n(e.target.value)
	});
}
function He({ ask: e, data: t, title: n, props: r }) {
	let [i, a] = D(() => Object.fromEntries(t.fields.map((e) => [e.id, e.value ?? ""]))), o = t.fields.some((e) => e.required && !i[e.id]?.trim()), s = e.options?.find((e) => e.id === "cancel"), c = r.sending === !0;
	return /* @__PURE__ */ P("div", {
		className: "kcard kcard--form kask",
		children: [
			/* @__PURE__ */ P("div", {
				className: "kcard__head",
				children: [/* @__PURE__ */ N("span", {
					className: "kcard__title",
					children: n ?? "A few details"
				}), /* @__PURE__ */ N("span", {
					className: "klabel kcard__source",
					children: "Question"
				})]
			}),
			e.text ? /* @__PURE__ */ N("div", {
				className: "kask__text",
				children: e.text
			}) : null,
			/* @__PURE__ */ N("div", {
				className: "kform",
				children: t.fields.map((e) => /* @__PURE__ */ P("label", {
					className: "kform__field",
					children: [/* @__PURE__ */ P("span", {
						className: "klabel",
						children: [e.label, e.required ? " *" : ""]
					}), /* @__PURE__ */ N(Ve, {
						field: e,
						value: i[e.id] ?? "",
						onChange: (t) => a((n) => ({
							...n,
							[e.id]: t
						}))
					})]
				}, e.id))
			}),
			/* @__PURE__ */ P("div", {
				className: "kcard__actions",
				children: [/* @__PURE__ */ N("button", {
					type: "button",
					className: "kbtn kbtn--primary",
					disabled: o || c,
					onClick: () => {
						let e = Object.fromEntries(Object.entries(i).map(([e, t]) => [e, t.trim()]).filter(([, e]) => e)), n = t.fields.filter((t) => e[t.id]).map((t) => `${t.label}: ${e[t.id]}`).join("\n");
						r.onAnswer({
							text: re(e),
							label: n || "Sent"
						});
					},
					children: t.submit ?? "Send"
				}), s ? /* @__PURE__ */ N("button", {
					type: "button",
					className: "kbtn",
					disabled: c,
					onClick: () => r.onAnswer({
						optionId: s.id,
						label: s.label
					}),
					children: s.label
				}) : null]
			}),
			/* @__PURE__ */ N(q, {
				error: r.error,
				sending: r.sending
			})
		]
	});
}
function J({ ask: e, props: t, skip: n = [] }) {
	let [r, i] = D(""), a = e.options?.filter((e) => !n.includes(e.id)) ?? [], o = e.allowFreeform === !0 || !e.options?.length, s = t.sending === !0;
	return /* @__PURE__ */ P(A, { children: [
		a.length ? /* @__PURE__ */ N("div", {
			className: "kcard__actions",
			children: a.map((n, r) => /* @__PURE__ */ N("button", {
				type: "button",
				title: n.description,
				className: `kbtn${n.style === "primary" || r === 0 && e.kind === "tool-approval" ? " kbtn--primary" : ""}`,
				disabled: s,
				onClick: () => t.onAnswer({
					optionId: n.id,
					label: n.label
				}),
				children: n.label
			}, n.id))
		}) : null,
		o ? /* @__PURE__ */ P("form", {
			className: "kask__typed",
			onSubmit: (e) => {
				e.preventDefault();
				let n = r.trim();
				n && t.onAnswer({
					text: n,
					label: n
				});
			},
			children: [/* @__PURE__ */ N("input", {
				className: "kinput",
				value: r,
				placeholder: "Your answer",
				onChange: (e) => i(e.target.value)
			}), /* @__PURE__ */ N("button", {
				type: "submit",
				className: "kbtn",
				disabled: s || !r.trim(),
				children: "Send"
			})]
		}) : null,
		/* @__PURE__ */ N(q, {
			error: t.error,
			sending: t.sending
		})
	] });
}
function Ue(e) {
	return e.optionId === "cancel" ? {
		label: /changes/i.test(e.label) ? "Sent back" : "Declined",
		good: !1
	} : {
		label: e.optionId === "approve" || e.optionId === "approved" ? "Approved" : "Answered",
		good: !0
	};
}
function We(e) {
	let { ask: n, ctx: r, answered: i } = e, a = n.card && t(n.card) ? n.card : void 0;
	if (a?.card === "approval") {
		let t = y(a) ?? a.data.action;
		if (i) {
			let e = Ue(i);
			return /* @__PURE__ */ N(K, {
				title: t,
				label: e.label,
				good: e.good,
				detail: a.data.subject
			});
		}
		return /* @__PURE__ */ N(Be, {
			ask: n,
			data: a.data,
			title: t,
			props: e
		});
	}
	if (a?.card === "form") {
		if (i) {
			let e = i.optionId === "cancel";
			return /* @__PURE__ */ N(K, {
				title: a.title ?? "Your answers",
				label: e ? "Skipped" : "Sent",
				good: !e,
				detail: e ? void 0 : i.label
			});
		}
		return /* @__PURE__ */ N(He, {
			ask: n,
			data: a.data,
			title: a.title,
			props: e
		});
	}
	if (n.spend) {
		let t = n.spend, a = t.merchant ?? (t.merchant_url ? G(t.merchant_url) : "a merchant");
		if (i) {
			let e = i.optionId === "cancel";
			return /* @__PURE__ */ N(K, {
				title: "Purchase approval",
				label: e ? "Cancelled" : "Approved",
				good: !e,
				detail: `${v(t.amount, t.currency)} at ${a}`
			});
		}
		return /* @__PURE__ */ P("div", {
			className: "kcard kcard--spend kask",
			children: [
				/* @__PURE__ */ P("div", {
					className: "kcard__head",
					children: [/* @__PURE__ */ N("span", {
						className: "kcard__title",
						children: "Purchase approval"
					}), /* @__PURE__ */ N("span", {
						className: "klabel kcard__source",
						children: "Link"
					})]
				}),
				/* @__PURE__ */ P("div", {
					className: "kask__amount",
					children: [/* @__PURE__ */ N("span", {
						className: "kask__total",
						children: v(t.amount, t.currency)
					}), /* @__PURE__ */ P("span", {
						className: "kask__note",
						children: [
							"at ",
							a,
							t.merchant_url && t.merchant ? /* @__PURE__ */ P(A, { children: [" · ", G(t.merchant_url)] }) : null
						]
					})]
				}),
				t.approval_url ? /* @__PURE__ */ N("div", {
					className: "kcard__actions",
					children: /* @__PURE__ */ N("button", {
						type: "button",
						className: "kbtn kbtn--primary",
						onClick: () => r.openUrl(t.approval_url),
						children: "Approve in Link"
					})
				}) : null,
				/* @__PURE__ */ N(J, {
					ask: n,
					props: e
				}),
				/* @__PURE__ */ N("div", {
					className: "kask__note",
					children: "Approving in Link issues a one-time card for exactly this amount. The agent checks with Link before paying."
				})
			]
		});
	}
	if (n.vault) {
		let t = n.vault, r = t.kind === "login" ? "a login" : t.kind === "card" ? "a card" : t.kind === "address" ? "an address" : "contact details";
		return i ? /* @__PURE__ */ N(K, {
			title: `Needs ${r}`,
			label: i.optionId === "cancel" ? "Cancelled" : "Answered",
			good: i.optionId !== "cancel"
		}) : /* @__PURE__ */ P("div", {
			className: "kcard kcard--vault kask",
			children: [
				/* @__PURE__ */ P("div", {
					className: "kcard__head",
					children: [/* @__PURE__ */ P("span", {
						className: "kcard__title",
						children: [
							"Needs ",
							r,
							t.site ? /* @__PURE__ */ P(A, { children: [" for ", G(t.site)] }) : null
						]
					}), /* @__PURE__ */ N("span", {
						className: "klabel kcard__source",
						children: "Vault"
					})]
				}),
				t.reason ? /* @__PURE__ */ N("div", {
					className: "kask__text",
					children: t.reason
				}) : n.text ? /* @__PURE__ */ N("div", {
					className: "kask__text",
					children: n.text
				}) : null,
				/* @__PURE__ */ N("div", {
					className: "kask__note",
					children: "Add it to your vault in KYBER Studio. Never type a password or card number in a conversation."
				}),
				/* @__PURE__ */ N(J, {
					ask: {
						...n,
						allowFreeform: !1
					},
					props: e
				})
			]
		});
	}
	return i ? /* @__PURE__ */ N(K, {
		title: n.text.split("\n")[0].slice(0, 120) || "Question",
		label: "Answered",
		good: !0,
		detail: i.label
	}) : /* @__PURE__ */ P("div", {
		className: "kask-stack",
		children: [n.card ? /* @__PURE__ */ N(W, {
			card: n.card,
			ctx: r
		}) : null, /* @__PURE__ */ P("div", {
			className: "kcard kask",
			children: [/* @__PURE__ */ N("div", {
				className: "kask__text",
				children: n.text
			}), /* @__PURE__ */ N(J, {
				ask: n,
				props: e
			})]
		})]
	});
}
// ../../cards-react/src/styles.ts
var Ge = "\n.kcard .is-good { color: var(--kyb-good, #15803d); }\n.kcard .is-bad { color: var(--kyb-bad, #dc2626); }\n\n/* Cards: one frame for every type. */\n.kcards { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }\n.kcard {\n  border: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); border-radius: 12px; background: var(--kyb-surface, #ffffff);\n  padding: 13px 15px; font-size: var(--kyb-fs-base, 14px); line-height: var(--kyb-lh-base, 19px);\n}\n.kcard--compact { padding: 9px 13px; }\n.kcard__head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }\n.kcard--compact .kcard__head { margin-bottom: 4px; }\n.kcard__title { flex: 1; min-width: 0; font-weight: 600; }\n.klabel {\n  font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;\n  color: var(--kyb-ink-tertiary, #8b91a0);\n}\n.kcard__source { flex: none; }\n.kcard__text { white-space: pre-wrap; color: var(--kyb-ink-secondary, #5c6270); }\n.kcard__actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }\n\n.kstats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1px; background: var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; overflow: hidden; }\n.kstats__tile { background: var(--kyb-surface, #ffffff); padding: 10px 12px; }\n.kstats__value { font-size: 22px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; margin-top: 3px; }\n.kstats__change { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); font-variant-numeric: tabular-nums; }\n.kstats__change.is-good { color: var(--kyb-good, #15803d); }\n.kstats__change.is-bad { color: var(--kyb-bad, #dc2626); }\n\n.kchart__legend { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); }\n.kchart__key { display: inline-flex; align-items: center; gap: 6px; }\n.kchart__swatch { width: 10px; height: 2px; background: currentColor; }\n.kchart__plot { display: flex; gap: 8px; }\n.kchart__y { display: flex; flex-direction: column; justify-content: space-between; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; color: var(--kyb-ink-tertiary, #8b91a0); text-align: right; padding-bottom: 20px; min-width: 32px; }\n.kchart__frame { position: relative; flex: 1; min-width: 0; }\n.kchart__svg { display: block; width: 100%; height: 160px; overflow: visible; }\n.kchart__line { fill: none; stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; }\n.kchart__area { stroke: none; opacity: 0.06; }\n.kchart__base { stroke: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); stroke-width: 1; }\n.kchart__rule { stroke: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); stroke-width: 1; }\n.kchart__s0 { stroke: var(--kyb-ink, #16181d); fill: var(--kyb-ink, #16181d); color: var(--kyb-ink, #16181d); }\n.kchart__s1 { stroke: var(--kyb-ink-secondary, #5c6270); fill: var(--kyb-ink-secondary, #5c6270); color: var(--kyb-ink-secondary, #5c6270); }\n.kchart__s2 { stroke: var(--kyb-ink-tertiary, #8b91a0); fill: var(--kyb-ink-tertiary, #8b91a0); color: var(--kyb-ink-tertiary, #8b91a0); }\n.kchart__s3 { stroke: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); fill: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); color: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }\n.kchart__line.kchart__s0, .kchart__line.kchart__s1, .kchart__line.kchart__s2, .kchart__line.kchart__s3 { fill: none; }\n.kchart__x { display: flex; justify-content: space-between; margin-top: 6px; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; color: var(--kyb-ink-tertiary, #8b91a0); }\n.kchart__x--slots { display: grid; text-align: center; }\n.kchart__x--slots span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; }\n.kchart__tip {\n  position: absolute; top: 0; transform: translateX(-50%); pointer-events: none; white-space: nowrap;\n  background: var(--kyb-surface-raised, #ffffff); border: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); border-radius: 6px;\n  padding: 5px 8px; font-size: var(--kyb-fs-xs, 12px); box-shadow: var(--kyb-shadow-menu, 0 10px 34px rgba(16, 18, 24, 0.18));\n}\n\n.ktable { overflow-x: auto; }\n.ktable__more { margin-top: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); }\n\n.kcheck { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }\n.kcheck__item { display: flex; gap: 9px; align-items: baseline; }\n.kcheck__item--skipped, .kcheck__item--waiting { color: var(--kyb-ink-secondary, #5c6270); }\n.kcheck__detail { color: var(--kyb-ink-tertiary, #8b91a0); }\n.kglyph { flex: none; width: 14px; text-align: center; color: var(--kyb-ink-tertiary, #8b91a0); }\n.kglyph.is-good { color: var(--kyb-good, #15803d); }\n.kglyph.is-bad { color: var(--kyb-bad, #dc2626); }\n\n.kbrief__head { display: flex; gap: 11px; align-items: center; }\n.kbrief__initial {\n  width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; flex: none;\n  background: var(--kyb-ink, #16181d); color: var(--kyb-ink-inverse, #ffffff); font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 15px;\n}\n.kbrief__name { font-weight: 600; }\n.kbrief__sub { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); }\n.kbrief__points { margin: 10px 0 0; padding-left: 18px; }\n.kbrief__facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 12px 0 0; }\n.kbrief__facts dd { margin: 2px 0 0; }\n.kbrief .kstats { margin-top: 12px; }\n\n.kform__field { display: flex; flex-direction: column; gap: 4px; }\n.kinput {\n  width: 100%; box-sizing: border-box; min-height: 30px; padding: 5px 9px; border-radius: 8px;\n  border: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); background: var(--kyb-surface, #ffffff);\n  color: var(--kyb-ink, #16181d); font: inherit; font-size: var(--kyb-fs-base, 14px);\n}\n.kinput--long { resize: vertical; min-height: 90px; }\n.kbtn:disabled { opacity: 0.5; cursor: default; }\n.kask-stack { display: flex; flex-direction: column; gap: 8px; }\n.kask__text { white-space: pre-wrap; margin-bottom: 4px; }\n.kask__note { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); margin-top: 8px; }\n.kask__error { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-bad, #dc2626); margin-top: 8px; }\n.kask__amount { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }\n.kask__amount .kask__note { margin-top: 0; }\n.kask__total { font-size: 22px; line-height: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }\n.kask__typed { display: flex; gap: 7px; margin-top: 10px; }\n.klink { display: block; width: 100%; text-align: left; padding: 0; }\n.klink__desc { color: var(--kyb-ink-secondary, #5c6270); margin-bottom: 4px; }\n.klink__url { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); text-decoration: underline; text-decoration-color: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }\n\n.kshot__img { display: block; max-width: 100%; max-height: 320px; border-radius: 8px; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); cursor: zoom-in; }\n.kshot__img--big { max-height: none; cursor: zoom-out; }\n.kshot__wait, .kartifact__wait { display: grid; place-items: center; height: 120px; color: var(--kyb-ink-tertiary, #8b91a0); }\n.kshot__missing, .kartifact__missing { display: flex; gap: 10px; align-items: center; color: var(--kyb-ink-secondary, #5c6270); font-size: var(--kyb-fs-sm, 13px); }\n.kshot__caption { margin-top: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-secondary, #5c6270); display: flex; gap: 10px; }\n.kshot__site { margin-left: auto; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; color: var(--kyb-ink-tertiary, #8b91a0); }\n\n.kfile { display: flex; align-items: center; gap: 10px; }\n.kfile__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }\n.kfile__size { margin-left: 8px; color: var(--kyb-ink-tertiary, #8b91a0); font-size: var(--kyb-fs-sm, 13px); }\n\n.kartifact__frame { display: block; width: 100%; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; background: #fff; }\n.kartifact--inline { height: 360px; margin-bottom: 10px; }\n.kartifact__doc.kartifact--inline { overflow: auto; padding: 4px 2px; }\n.kartifact__meta { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); }\n.kartifact__preview {\n  display: block; width: 100%; padding: 0; margin-bottom: 10px; border: 0; background: none; cursor: pointer; text-align: left;\n  position: relative; overflow: hidden; border-radius: 8px;\n}\n/* The top of the page, faded out, and not interactive: a click opens it. */\n.kartifact--preview { height: 200px; pointer-events: none; overflow: hidden; }\n.kartifact__preview::after {\n  content: \"\"; position: absolute; inset: auto 0 0 0; height: 64px; pointer-events: none;\n  background: linear-gradient(to bottom, transparent, var(--kyb-surface, #ffffff));\n}\n/* A page is white in both themes, so it fades into its own white, inside its border. */\n.kartifact__preview:has(.kartifact__frame)::after {\n  inset: auto 1px 1px 1px; border-radius: 0 0 7px 7px;\n  background: linear-gradient(to bottom, rgb(255 255 255 / 0), #fff);\n}\n.kartifact__preview:hover .kartifact__frame, .kartifact__preview:hover .kartifact__doc { border-color: var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }\n.kartifact__doc.kartifact--preview { border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; padding: 10px 14px; }\n.kartifact__row + .kcard__actions { margin-top: 10px; }\n\n.kpr__summary { color: var(--kyb-ink-secondary, #5c6270); }\n.kpr__delta { margin: 8px 0; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 11px; }\n.kpr__meta { margin-top: 8px; font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); }\n.kpr .kcheck { margin-top: 8px; }\n.kdiff { margin-top: 10px; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px; overflow: hidden; font-family: var(--kyb-font-mono, ui-monospace, Menlo, Consolas, monospace); font-size: 12px; }\n.kdiff__file { padding: 5px 10px; background: var(--kyb-hover, rgba(22, 24, 29, 0.045)); color: var(--kyb-ink-secondary, #5c6270); border-bottom: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); }\n.kdiff__line { padding: 0 10px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }\n.kdiff__line.is-good { background: color-mix(in srgb, var(--kyb-good, #15803d) 9%, transparent); color: inherit; }\n.kdiff__line.is-bad { background: color-mix(in srgb, var(--kyb-bad, #dc2626) 9%, transparent); color: inherit; }\n\n.kreceipt__amount { font-size: 22px; line-height: 28px; font-weight: 500; font-variant-numeric: tabular-nums; }\n.kreceipt__meta { font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 11px; color: var(--kyb-ink-tertiary, #8b91a0); margin-top: 2px; }\n.kreceipt__note { margin: 8px 0; color: var(--kyb-ink-secondary, #5c6270); }\n.kremember { color: var(--kyb-ink-secondary, #5c6270); }\n.kroutine__meta { font-size: var(--kyb-fs-sm, 13px); color: var(--kyb-ink-tertiary, #8b91a0); margin-top: 3px; }\n\n/* Asks drawn on the card frame: approvals, forms, sign-in, a purchase. */\n.kcard.is-done { padding: 9px 13px; }\n.kcard.is-done .kcard__head { margin-bottom: 2px; align-items: center; }\n.kpill {\n  flex: none; font-family: var(--kyb-font-label, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;\n  padding: 2px 7px; border-radius: 999px; border: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); color: var(--kyb-ink-secondary, #5c6270);\n}\n.kpill.is-good { color: var(--kyb-good, #15803d); border-color: currentColor; }\n.kapproval__rows { margin: 0; display: grid; gap: 4px; }\n.kapproval__row { display: grid; grid-template-columns: 68px 1fr; gap: 10px; align-items: baseline; }\n.kapproval__row dt { padding-top: 1px; }\n.kapproval__row dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }\n.kapproval__body {\n  margin-top: 10px; padding: 10px 12px; border: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); border-radius: 8px;\n  white-space: pre-wrap; overflow-wrap: anywhere; color: var(--kyb-ink-secondary, #5c6270); max-height: 260px; overflow: auto;\n}\n.kform { display: flex; flex-direction: column; gap: 10px; }\n.kform__choices { display: flex; flex-wrap: wrap; gap: 6px; }\n.kform__list { margin: 0; padding-left: 18px; color: var(--kyb-ink-secondary, #5c6270); }\n.kbtn {\n  height: 30px; padding: 0 13px; border: 0; border-radius: 8px; cursor: pointer;\n  font: inherit; font-size: var(--kyb-fs-base, 14px); font-weight: 500;\n  color: var(--kyb-ink, #16181d); background: var(--kyb-hover, rgba(22, 24, 29, 0.045));\n}\n.kbtn:hover { background: var(--kyb-selected, rgba(22, 24, 29, 0.075)); }\n.kbtn--primary { background: var(--kyb-ink, #16181d); color: var(--kyb-ink-inverse, #ffffff); }\n.kbtn--primary:hover { opacity: 0.87; background: var(--kyb-ink, #16181d); }\n.klink { border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }\n.ktable table { border-collapse: collapse; width: 100%; font-size: var(--kyb-fs-sm, 13px); }\n.ktable th { text-align: left; font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); }\n.ktable td { padding: 4px 8px; border-bottom: 1px solid var(--kyb-stroke, rgba(22, 24, 29, 0.09)); font-variant-numeric: tabular-nums; }\n.kartifact__plain { white-space: pre-wrap; }\n.kartifact__host { margin-bottom: 10px; }\n.kspin {\n  width: 16px; height: 16px; border-radius: 50%; display: inline-block;\n  border: 2px solid var(--kyb-stroke-strong, rgba(22, 24, 29, 0.16)); border-top-color: var(--kyb-ink-secondary, #5c6270);\n  animation: kspin 0.8s linear infinite;\n}\n@keyframes kspin { to { transform: rotate(360deg); } }\n@media (prefers-reduced-motion: reduce) { .kspin { animation: none; } }\n", Ke = [
	"react",
	"conversation",
	"panels",
	"browser",
	"relay"
], Y = /* @__PURE__ */ new WeakMap();
function X(e) {
	let t = Y.get(e);
	return t || (t = e.content.includes("<!-- kyb:card v1 ") ? fe(e.content) : [], Y.set(e, t)), t;
}
var Z = /* @__PURE__ */ new WeakMap();
function Q(e) {
	let t = Z.get(e);
	return t || (t = e.content.includes("<!-- kyb:ask v1 ") ? ye(e.content) : [], Z.set(e, t)), t;
}
var qe = "kybernesis.cards.answered.v1", Je = 200;
function Ye() {
	try {
		let e = localStorage.getItem(qe), t = e ? JSON.parse(e) : {};
		return t && typeof t == "object" ? t : {};
	} catch {
		return {};
	}
}
function Xe(e, t) {
	try {
		let n = {
			...Ye(),
			[e]: {
				optionId: t.optionId,
				label: t.label.slice(0, 500)
			}
		}, r = Object.keys(n);
		for (let e of r.slice(0, Math.max(0, r.length - Je))) delete n[e];
		localStorage.setItem(qe, JSON.stringify(n));
	} catch {}
}
var Ze = "/eve/v1/kyb/artifact-shares/";
function Qe(e) {
	try {
		let t = new URL(e);
		return t.protocol === "https:" && t.pathname.includes(Ze);
	} catch {
		return !1;
	}
}
var $ = "kybernesis-artifacts";
function $e(e) {
	for (let t = e.parentElement; t; t = t.parentElement) {
		let e = getComputedStyle(t).overflowY;
		if (e === "auto" || e === "scroll" || e === "overlay") return t;
	}
	return null;
}
var et = "\n.kyb-buzz {\n  --kyb-ink: var(--text-color-primary, #16181d);\n  --kyb-ink-secondary: var(--text-color-secondary, #5c6270);\n  --kyb-ink-tertiary: var(--text-color-tertiary, #8b91a0);\n  --kyb-ink-inverse: var(--text-color-inverse, #ffffff);\n  --kyb-surface: var(--surface-base, #ffffff);\n  --kyb-surface-raised: var(--surface-popover, #ffffff);\n  --kyb-stroke: var(--border-color-standard, rgba(22, 24, 29, 0.09));\n  --kyb-stroke-strong: var(--border-color-prominent, rgba(22, 24, 29, 0.16));\n  --kyb-hover: color-mix(in srgb, var(--text-color-primary, #16181d) 5%, transparent);\n  --kyb-selected: color-mix(in srgb, var(--text-color-primary, #16181d) 9%, transparent);\n  --kyb-good: var(--text-color-success, #15803d);\n  --kyb-bad: var(--text-color-danger, #dc2626);\n  --kyb-font-label: var(--font-mono, ui-monospace, monospace);\n  --kyb-font-mono: var(--font-mono, ui-monospace, monospace);\n  /* A message sizes to its content; a card is one width, like Buzz's own wide blocks. */\n  width: 640px;\n  max-width: 100%;\n  box-sizing: border-box;\n}\n.kyb-buzz .kcards { margin-top: 2px; }\n.kyb-buzz .kask + .kask { margin-top: 8px; }\n/* The message list restyles buttons; the primary one keeps its own colours. */\n.kyb-buzz .kbtn--primary {\n  background: var(--surface-inverse, #16181d) !important;\n  color: var(--text-color-inverse, #ffffff) !important;\n}\n/* The card shows the page itself: the host's address bar and its buttons stay hidden. */\n.kyb-buzz__page [role=\"toolbar\"][aria-label=\"Browser controls\"] { display: none !important; }\n.kyb-buzz__page {\n  display: flex;\n  flex-direction: column;\n  height: 460px;\n  border: 1px solid var(--kyb-stroke);\n  border-radius: 8px;\n  overflow: hidden;\n}\n.kyb-buzz__waiting {\n  display: grid;\n  place-items: center;\n  flex: 1;\n  color: var(--kyb-ink-tertiary);\n  font-size: 13px;\n}\n";
function tt(e) {
	let t = document.createElement("a");
	t.href = e, t.target = "_blank", t.rel = "noopener noreferrer", t.click();
}
function nt(e) {
	let t = e.react;
	Se(t);
	let n = e.browser.View, r = () => e.browser.available;
	function i({ url: e, title: t }) {
		let r = k(null), [i, a] = D(!1);
		return O(() => {
			let e = r.current;
			if (!e) return;
			let t = new IntersectionObserver((e) => a(e.some((e) => e.intersectionRatio >= .99)), {
				root: $e(e),
				threshold: [
					0,
					.5,
					.99,
					1
				]
			});
			return t.observe(e), () => t.disconnect();
		}, []), /* @__PURE__ */ N("div", {
			ref: r,
			className: "kyb-buzz__page",
			children: i ? /* @__PURE__ */ N(n, {
				url: e,
				storage: $,
				label: t
			}) : /* @__PURE__ */ N("div", {
				className: "kyb-buzz__waiting",
				children: t ?? "Page"
			})
		});
	}
	e.panels.register({
		id: "artifact",
		title: "Artifact",
		keepOpen: !0,
		matches: (e) => r() && Qe(e),
		component: ({ target: e }) => /* @__PURE__ */ N(n, {
			url: e,
			storage: $
		})
	});
	function a(t, n, r = []) {
		let i = e.relay.snapshot();
		if (i.status !== "ready") return "Not connected to the community right now. Try again in a moment.";
		try {
			return i.session.messages.reply(t.channelId, t.threadRootId ?? t.id, n, r, [], t.id), null;
		} catch (e) {
			return `Could not send: ${e.message}`;
		}
	}
	function o({ message: e, ask: t, host: n }) {
		let r = `${e.id}:${t.requestId}`, [i, o] = D(() => Ye()[r]), [s, c] = D();
		return /* @__PURE__ */ N(We, {
			ask: t,
			ctx: n,
			answered: i,
			error: s,
			onAnswer: (n) => {
				let i = a(e, xe({
					requestId: t.requestId,
					optionId: n.optionId,
					text: n.text
				}, n.label));
				i ? c(i) : (c(void 0), Xe(r, n), o(n));
			}
		});
	}
	function s({ message: e, canOpen: t, open: n }) {
		let s = X(e), c = Q(e), l = {
			openUrl: (e) => {
				t(e) && n(e) || tt(e);
			},
			renderArtifact: (e, t) => e.url && r() && Qe(e.url) ? /* @__PURE__ */ N(i, {
				url: e.url,
				title: t
			}) : null,
			onSay: (t) => {
				let n = a(e, t, [e.authorId]);
				n && console.warn(`[kybernesis.cards] ${n}`);
			}
		};
		return /* @__PURE__ */ P("div", {
			className: "kyb-buzz",
			children: [
				/* @__PURE__ */ N("style", { children: et + Ge }),
				c.map((t) => /* @__PURE__ */ N(o, {
					message: e,
					ask: t,
					host: l
				}, t.requestId)),
				/* @__PURE__ */ N(ze, {
					cards: s,
					ctx: l
				})
			]
		});
	}
	e.conversation.registerMessage({
		id: "cards",
		title: "Kybernesis cards",
		matches: (e) => X(e).length > 0 || Q(e).length > 0,
		component: s
	});
}
export { nt as apply, Ke as inject };
