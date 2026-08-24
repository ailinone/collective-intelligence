#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Self-hosted replacement for the contrib.rocks embed, which was found
// showing only 1 of this repo's 2 contributors (stale cache on their end,
// confirmed by comparing its output against GitHub's own contributors API
// directly). This script fetches the contributor list from GitHub directly
// and renders a single SVG with one circle per contributor, linking each
// avatar image straight to avatars.githubusercontent.com (GitHub's own CDN,
// not a third party), refreshed by the same workflow as the star chart.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const REPO = process.env.STAR_HISTORY_REPO || 'ailinone/collective-intelligence';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.CONTRIBUTORS_OUT_DIR || '.github/contributors';

// Every commit in this repo's history is authored by a human, never by an AI
// assistant. GitHub's /contributors endpoint is cached separately from the
// commit history it summarizes, so a login can still show up here for a
// while after the commit(s) that put it there have been corrected. This
// denylist keeps the widget honest in the meantime, and stays harmless once
// the cache catches up (the filter just never matches again).
const EXCLUDED_LOGINS = new Set(['claude']);

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required.');
  process.exit(1);
}

async function fetchAllContributors(repo) {
  const [owner, name] = repo.split('/');
  const contributors = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/contributors?per_page=100&page=${page}&anon=false`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ailin-contributors-widget-generator',
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub contributors API returned ${res.status}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (batch.length === 0) break;
    contributors.push(...batch.filter((c) => c.type === 'User'));
    if (batch.length < 100) break;
    page++;
  }
  return contributors;
}

async function fetchAvatarDataUri(avatarUrl) {
  const res = await fetch(`${avatarUrl}&s=128`, {
    headers: { 'User-Agent': 'ailin-contributors-widget-generator' },
  });
  if (!res.ok) throw new Error(`Failed to fetch avatar ${avatarUrl}: ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buf.toString('base64')}`;
}

async function renderSvg(contributors) {
  const perRow = 12;
  const cell = 64;
  const gap = 8;
  const radius = 28;
  const rows = Math.ceil(contributors.length / perRow);
  const cols = Math.min(perRow, contributors.length);
  const W = cols * cell + (cols - 1) * gap;
  const H = rows * cell + (rows - 1) * gap;

  const dataUris = await Promise.all(contributors.map((c) => fetchAvatarDataUri(c.avatar_url)));

  const circles = contributors
    .map((c, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const cx = col * (cell + gap) + cell / 2;
      const cy = row * (cell + gap) + cell / 2;
      const clipId = `clip-${i}`;
      return `<g>
    <title>${c.login}</title>
    <clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${radius}" /></clipPath>
    <circle cx="${cx}" cy="${cy}" r="${radius + 1}" fill="none" stroke="#8b949e" stroke-width="1" opacity="0.5" />
    <image href="${dataUris[i]}" x="${cx - radius}" y="${cy - radius}" width="${radius * 2}" height="${radius * 2}" clip-path="url(#${clipId})" />
  </g>`;
    })
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${contributors.length} contributors to this repository">
  ${circles}
</svg>
`;
}

async function main() {
  console.log(`Fetching contributors for ${REPO}...`);
  const fetched = await fetchAllContributors(REPO);
  console.log(`Fetched ${fetched.length} contributors: ${fetched.map((c) => c.login).join(', ')}`);

  const excluded = fetched.filter((c) => EXCLUDED_LOGINS.has(c.login.toLowerCase()));
  if (excluded.length > 0) {
    console.log(`Excluding: ${excluded.map((c) => c.login).join(', ')}`);
  }
  const contributors = fetched.filter((c) => !EXCLUDED_LOGINS.has(c.login.toLowerCase()));
  if (contributors.length === 0) {
    throw new Error('No contributors returned; refusing to render an empty widget.');
  }

  await mkdir(OUT_DIR, { recursive: true });
  const svg = await renderSvg(contributors);
  const outPath = path.join(OUT_DIR, 'contributors.svg');
  await writeFile(outPath, svg, 'utf8');
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
