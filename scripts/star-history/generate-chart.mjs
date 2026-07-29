#!/usr/bin/env node
// Copyright (C) 2026 Ailin One, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Self-hosted replacement for the star-history.com embed. GitHub restricted
// the stargazers API (Accept: application/vnd.github.star+json) to repo
// collaborators/admins on 2026-06-30, which broke third-party chart services
// for any repo they don't administer themselves. This script runs in our own
// repo's own Actions context (a collaborator by definition), fetches the
// same data directly, and renders two static SVGs (light/dark) committed to
// the repo. GitHub sanitizes <style>/media-query blocks out of SVGs embedded
// in README rendering, so the two themes must be separate files, switched by
// the README's own <picture><source media="prefers-color-scheme"> tags.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const REPO = process.env.STAR_HISTORY_REPO || 'ailinone/collective-intelligence';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.STAR_HISTORY_OUT_DIR || '.github/star-history';

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required (a repo collaborator token, e.g. the Actions default token).');
  process.exit(1);
}

async function fetchAllStargazers(repo) {
  const [owner, name] = repo.split('/');
  const events = [];
  let page = 1;
  for (;;) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/stargazers?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github.star+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ailin-star-history-chart-generator',
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub stargazers API returned ${res.status}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (batch.length === 0) break;
    events.push(...batch.map((e) => e.starred_at));
    if (batch.length < 100) break;
    page++;
  }
  return events.map((d) => new Date(d)).sort((a, b) => a - b);
}

function buildCumulativeSeries(starDates) {
  return starDates.map((date, i) => ({ date, count: i + 1 }));
}

function downsample(points, maxPoints = 400) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const sampled = [];
  for (let i = 0; i < maxPoints; i++) sampled.push(points[Math.floor(i * step)]);
  sampled.push(points[points.length - 1]);
  return sampled;
}

function niceStep(maxValue, targetTicks = 4) {
  const raw = maxValue / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw || 1));
  const residual = raw / magnitude;
  let niceResidual;
  if (residual >= 5) niceResidual = 5;
  else if (residual >= 2) niceResidual = 2;
  else niceResidual = 1;
  return Math.max(1, niceResidual * magnitude);
}

function formatDate(date, spanMs) {
  const day = 24 * 60 * 60 * 1000;
  if (spanMs <= 3 * day) {
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
  }
  if (spanMs <= 60 * day) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (spanMs <= 2 * 365 * day) {
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { year: 'numeric' });
}

const THEMES = {
  light: {
    bg: '#ffffff',
    grid: '#e2e6ec',
    axisText: '#57606a',
    titleText: '#1f2328',
    line: '#6d28d9',
    areaTop: 'rgba(109, 40, 217, 0.16)',
    areaBottom: 'rgba(109, 40, 217, 0.0)',
    marker: '#6d28d9',
    markerRing: '#ffffff',
  },
  dark: {
    bg: '#0d1117',
    grid: '#30363d',
    axisText: '#8b949e',
    titleText: '#e6edf3',
    line: '#a78bfa',
    areaTop: 'rgba(167, 139, 250, 0.18)',
    areaBottom: 'rgba(167, 139, 250, 0.0)',
    marker: '#a78bfa',
    markerRing: '#0d1117',
  },
};

function renderSvg(points, repo, theme) {
  const W = 800;
  const H = 400;
  const M = { top: 40, right: 28, bottom: 40, left: 56 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const t = THEMES[theme];

  const firstDate = points[0].date;
  const lastDate = points[points.length - 1].date;
  const spanMs = Math.max(1, lastDate - firstDate);
  const maxCount = points[points.length - 1].count;
  const yStep = niceStep(maxCount);
  const yMax = Math.ceil(maxCount / yStep) * yStep || yStep;

  const x = (date) => M.left + ((date - firstDate) / spanMs) * plotW;
  const y = (count) => M.top + plotH - (count / yMax) * plotH;

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.count).toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${x(lastDate).toFixed(1)},${(M.top + plotH).toFixed(1)} L${x(firstDate).toFixed(1)},${(M.top + plotH).toFixed(1)} Z`;

  const yTicks = [];
  for (let v = 0; v <= yMax; v += yStep) yTicks.push(v);

  const xTickCount = 5;
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) {
    const ms = firstDate.getTime() + (spanMs * i) / (xTickCount - 1);
    xTicks.push(new Date(ms));
  }

  const gridLines = yTicks
    .map(
      (v) =>
        `<line x1="${M.left}" y1="${y(v).toFixed(1)}" x2="${W - M.right}" y2="${y(v).toFixed(1)}" stroke="${t.grid}" stroke-width="1" />`,
    )
    .join('\n    ');
  const yLabels = yTicks
    .map(
      (v) =>
        `<text x="${M.left - 10}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="12" fill="${t.axisText}" font-family="ui-monospace, Consolas, monospace">${v.toLocaleString('en-US')}</text>`,
    )
    .join('\n    ');
  const xLabels = xTicks
    .map(
      (d) =>
        `<text x="${x(d).toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="12" fill="${t.axisText}" font-family="ui-monospace, Consolas, monospace">${formatDate(d, spanMs)}</text>`,
    )
    .join('\n    ');

  const endX = x(lastDate);
  const endY = y(maxCount);
  const endLabel = `${maxCount.toLocaleString('en-US')} stars`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cumulative GitHub stars over time for ${repo}, currently ${maxCount.toLocaleString('en-US')}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${t.bg}" />
  <text x="${M.left}" y="24" font-size="14" font-weight="600" fill="${t.titleText}" font-family="-apple-system, Segoe UI, sans-serif">${repo}: star history</text>
  <g>
    ${gridLines}
    ${yLabels}
    ${xLabels}
  </g>
  <path d="${areaPath}" fill="url(#fill-${theme})" stroke="none" />
  <path d="${linePath}" fill="none" stroke="${t.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
  <circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="4" fill="${t.marker}" stroke="${t.markerRing}" stroke-width="2" />
  <text x="${(endX - 8).toFixed(1)}" y="${(endY - 12).toFixed(1)}" text-anchor="end" font-size="13" font-weight="600" fill="${t.titleText}" font-family="-apple-system, Segoe UI, sans-serif">${endLabel}</text>
  <defs>
    <linearGradient id="fill-${theme}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${t.areaTop}" />
      <stop offset="100%" stop-color="${t.areaBottom}" />
    </linearGradient>
  </defs>
</svg>
`;
}

async function main() {
  console.log(`Fetching stargazers for ${REPO}...`);
  const starDates = await fetchAllStargazers(REPO);
  console.log(`Fetched ${starDates.length} stars.`);
  if (starDates.length === 0) {
    throw new Error('No stargazers returned; refusing to render an empty chart.');
  }

  const points = downsample(buildCumulativeSeries(starDates));
  await mkdir(OUT_DIR, { recursive: true });

  for (const theme of ['light', 'dark']) {
    const svg = renderSvg(points, REPO, theme);
    const outPath = path.join(OUT_DIR, `chart-${theme}.svg`);
    await writeFile(outPath, svg, 'utf8');
    console.log(`Wrote ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
