#!/usr/bin/env node
// Generates SVG stat cards for the profile README from the GitHub GraphQL API.
// Requires GITHUB_TOKEN. Writes light/dark variants into assets/.

import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const USERNAME = process.env.USERNAME ?? 'gtibrett';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = path.join(process.cwd(), 'assets');

if (!TOKEN) {
	console.error('GITHUB_TOKEN is required');
	process.exit(1);
}

async function graphql(query, variables = {}) {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({query, variables})
	});

	if (!res.ok) {
		throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
	}

	const {data, errors} = await res.json();
	if (errors?.length) {
		throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
	}

	return data;
}

const PROFILE_QUERY = `
	query ($login: String!) {
		user(login: $login) {
			createdAt
			repositories(ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, first: 100) {
				nodes {
					languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
						edges {
							size
							node { name color }
						}
					}
				}
			}
		}
	}
`;

// contributionsCollection is capped at a 1-year window, so the full history
// is fetched as one aliased sub-query per calendar year since account creation.
async function fetchContributionDays(createdAt) {
	const now = new Date();
	const ranges = [];
	let from = new Date(createdAt);

	while (from < now) {
		const nextYear = new Date(Date.UTC(from.getUTCFullYear() + 1, 0, 1));
		const to = nextYear < now ? new Date(nextYear.getTime() - 1000) : now;
		ranges.push({alias: `y${from.getUTCFullYear()}`, from: from.toISOString(), to: to.toISOString()});
		from = nextYear;
	}

	const fields = ranges.map(({alias, from, to}) => `
		${alias}: contributionsCollection(from: "${from}", to: "${to}") {
			contributionCalendar {
				weeks { contributionDays { date contributionCount } }
			}
		}`).join('');

	const data = await graphql(`query ($login: String!) { user(login: $login) { ${fields} } }`, {login: USERNAME});

	const counts = new Map();
	for (const {alias} of ranges) {
		for (const week of data.user[alias].contributionCalendar.weeks) {
			for (const day of week.contributionDays) {
				counts.set(day.date, day.contributionCount);
			}
		}
	}

	const today = now.toISOString().slice(0, 10);
	return [...counts.entries()]
		.filter(([date]) => date <= today)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, count]) => ({date, count}));
}

function computeStreaks(days) {
	let total = 0;
	let firstContribution = null;

	for (const d of days) {
		total += d.count;
		if (d.count > 0 && !firstContribution) {
			firstContribution = d.date;
		}
	}

	let longest = {length: 0, start: null, end: null};
	let run = null;
	for (const d of days) {
		run = d.count > 0 ? (run ? {...run, length: run.length + 1, end: d.date} : {length: 1, start: d.date, end: d.date}) : null;
		if (run && run.length > longest.length) {
			longest = run;
		}
	}

	// today with no contributions yet doesn't break the streak
	const current = {length: 0, start: null, end: null};
	let i = days.length - 1;
	if (i >= 0 && days[i].count === 0) {
		i--;
	}
	for (; i >= 0 && days[i].count > 0; i--) {
		current.length++;
		current.start = days[i].date;
		current.end ??= days[i].date;
	}

	return {total, firstContribution, longest, current};
}

const THEMES = {
	light: {text: '#1f2328', muted: '#59636e', accent: '#0969da', border: '#d0d7de', track: '#eff2f5'},
	dark:  {text: '#e6edf3', muted: '#9198a1', accent: '#58a6ff', border: '#30363d', track: '#21262d'}
};

const FONT = `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => n.toLocaleString('en-US');
const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});

function langsCard(user, theme) {
	const t = THEMES[theme];
	const totals = new Map();

	for (const repo of user.repositories.nodes) {
		for (const edge of repo.languages.edges) {
			const prev = totals.get(edge.node.name) ?? {size: 0, color: edge.node.color};
			prev.size += edge.size;
			totals.set(edge.node.name, prev);
		}
	}

	const grand = [...totals.values()].reduce((sum, l) => sum + l.size, 0) || 1;
	const langs = [...totals.entries()]
		.map(([name, {size, color}]) => ({name, color: color ?? t.muted, pct: (size / grand) * 100}))
		.sort((a, b) => b.pct - a.pct)
		.slice(0, 8);

	const width = 420;
	const barX = 24;
	const barWidth = width - 48;
	const barY = 54;
	const legendTop = 86;
	const legendRow = 26;
	const rows = Math.ceil(langs.length / 2);
	const height = legendTop + rows * legendRow + 12;

	let offset = 0;
	const segments = langs.map((l) => {
		const w = Math.max((l.pct / 100) * barWidth, 0);
		const seg = `<rect x="${barX + offset}" y="${barY}" width="${w}" height="10" fill="${l.color}"/>`;
		offset += w;
		return seg;
	}).join('');

	const legend = langs.map((l, i) => {
		const col = i % 2;
		const row = Math.floor(i / 2);
		const x = barX + col * (barWidth / 2);
		const y = legendTop + row * legendRow;
		return `
		<circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${l.color}"/>
		<text x="${x + 18}" y="${y}" font-size="13" fill="${t.text}">${esc(l.name)} <tspan fill="${t.muted}">${l.pct.toFixed(1)}%</tspan></text>`;
	}).join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Most used languages for ${esc(USERNAME)}">
	<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="none" stroke="${t.border}"/>
	<g font-family="${FONT}">
		<text x="24" y="36" font-size="16" font-weight="600" fill="${t.accent}">Most Used Languages</text>
		<rect x="${barX}" y="${barY}" width="${barWidth}" height="10" rx="5" fill="${t.track}"/>
		<g clip-path="url(#bar)">${segments}</g>
		<clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barWidth}" height="10" rx="5"/></clipPath>
		${legend}
	</g>
</svg>
`;
}

function streakCard(streaks, theme) {
	const t = THEMES[theme];
	const width = 420;
	const height = 150;

	const columns = [
		{
			value: fmt(streaks.total),
			label: 'Total Contributions',
			range: streaks.firstContribution ? `${fmtDate(streaks.firstContribution)} – Present` : '',
			color: t.text
		},
		{
			value: fmt(streaks.current.length),
			label: 'Current Streak',
			range: streaks.current.length > 0 ? `${fmtDate(streaks.current.start)} – Present` : 'No active streak',
			color: t.accent
		},
		{
			value: fmt(streaks.longest.length),
			label: 'Longest Streak',
			range: streaks.longest.length > 0 ? `${fmtDate(streaks.longest.start)} – ${fmtDate(streaks.longest.end)}` : '',
			color: t.text
		}
	];

	const body = columns.map((col, i) => {
		const cx = width / 6 + i * (width / 3);
		return `
		<text x="${cx}" y="64" font-size="26" font-weight="700" text-anchor="middle" fill="${col.color}">${col.value}</text>
		<text x="${cx}" y="94" font-size="13" text-anchor="middle" fill="${t.text}">${esc(col.label)}</text>
		<text x="${cx}" y="116" font-size="11" text-anchor="middle" fill="${t.muted}">${esc(col.range)}</text>`;
	}).join('');

	const dividers = [1, 2].map((i) => `<line x1="${(width / 3) * i + 0.5}" y1="30" x2="${(width / 3) * i + 0.5}" y2="${height - 30}" stroke="${t.border}"/>`).join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Contribution streak for ${esc(USERNAME)}">
	<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="none" stroke="${t.border}"/>
	<g font-family="${FONT}">
		${dividers}
		${body}
	</g>
</svg>
`;
}

const {user} = await graphql(PROFILE_QUERY, {login: USERNAME});
const days = await fetchContributionDays(user.createdAt);
const streaks = computeStreaks(days);

await mkdir(OUT_DIR, {recursive: true});

for (const theme of Object.keys(THEMES)) {
	await writeFile(path.join(OUT_DIR, `langs-${theme}.svg`), langsCard(user, theme));
	await writeFile(path.join(OUT_DIR, `streak-${theme}.svg`), streakCard(streaks, theme));
}

console.log(`Wrote 4 cards to ${OUT_DIR} (total: ${streaks.total}, current: ${streaks.current.length}, longest: ${streaks.longest.length})`);
