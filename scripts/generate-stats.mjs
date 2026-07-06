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

const QUERY = `
	query ($login: String!) {
		user(login: $login) {
			followers { totalCount }
			contributionsCollection {
				totalCommitContributions
				totalPullRequestContributions
				totalIssueContributions
				contributionCalendar { totalContributions }
			}
			repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount }
			repositories(ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, first: 100) {
				nodes {
					stargazerCount
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

async function fetchStats() {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({query: QUERY, variables: {login: USERNAME}})
	});

	if (!res.ok) {
		throw new Error(`GraphQL request failed: ${res.status} ${await res.text()}`);
	}

	const {data, errors} = await res.json();
	if (errors?.length) {
		throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
	}

	return data.user;
}

const THEMES = {
	light: {text: '#1f2328', muted: '#59636e', accent: '#0969da', border: '#d0d7de', track: '#eff2f5'},
	dark:  {text: '#e6edf3', muted: '#9198a1', accent: '#58a6ff', border: '#30363d', track: '#21262d'}
};

const FONT = `-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => n.toLocaleString('en-US');

function statsCard(user, theme) {
	const t = THEMES[theme];
	const stars = user.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0);
	const c = user.contributionsCollection;

	const rows = [
		['Contributions (last year)', c.contributionCalendar.totalContributions],
		['Commits (last year)', c.totalCommitContributions],
		['Pull requests (last year)', c.totalPullRequestContributions],
		['Total stars earned', stars],
		['Followers', user.followers.totalCount]
	];

	const rowHeight = 30;
	const top = 62;
	const width = 420;
	const height = top + rows.length * rowHeight + 18;

	const body = rows.map(([label, value], i) => {
		const y = top + i * rowHeight;
		return `
		<circle cx="28" cy="${y - 4}" r="3" fill="${t.accent}"/>
		<text x="42" y="${y}" font-size="14" fill="${t.text}">${esc(label)}</text>
		<text x="${width - 26}" y="${y}" font-size="14" font-weight="600" text-anchor="end" fill="${t.accent}">${fmt(value)}</text>`;
	}).join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub stats for ${esc(USERNAME)}">
	<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="none" stroke="${t.border}"/>
	<g font-family="${FONT}">
		<text x="24" y="36" font-size="16" font-weight="600" fill="${t.accent}">${esc(USERNAME)}'s GitHub Stats</text>
		${body}
	</g>
</svg>
`;
}

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

const user = await fetchStats();
await mkdir(OUT_DIR, {recursive: true});

for (const theme of Object.keys(THEMES)) {
	await writeFile(path.join(OUT_DIR, `stats-${theme}.svg`), statsCard(user, theme));
	await writeFile(path.join(OUT_DIR, `langs-${theme}.svg`), langsCard(user, theme));
}

console.log(`Wrote 4 cards to ${OUT_DIR}`);
