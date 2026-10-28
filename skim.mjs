#!/usr/bin/env node
// skim shows the C# and Razor files of the pull requests your branches would open, as "header" views:
// signatures, attributes and comments, with bodies folded. Run `node Tools/skim/skim.mjs --help`.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { skeletonCSharp } from './lib/csharpSkeleton.mjs';
import { DEFAULT_REPOS, loadPrGroups } from './lib/prFiles.mjs';
import { skeletonRazor } from './lib/razorSkeleton.mjs';

const HELP = `Usage: node Tools/skim/skim.mjs [options] [path-or-glob ...]

Shows the .cs and .razor files in the PR that each repo's current branch would open.

Options:
  --new              Only show files the PRs add.
  --only <p,...>     Only show files under these folders or matching these globs (relative to the
                     tb folder). Positional arguments are added to this list.
  --repos <r,...>    Which repo folders to look at (default: ${DEFAULT_REPOS.join(',')}).
  --base <branch>    Use this base branch instead of the PR's or the repo's default branch.
  --fetch            Run git fetch in each repo first.
  --port <n>         The port to serve on (default 5179).
  --no-open          Do not open the browser.
  --check            Print the skeleton warnings for every file and exit, without serving.
`;

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		new: { type: 'boolean', default: false },
		only: { type: 'string', multiple: true, default: [] },
		repos: { type: 'string' },
		base: { type: 'string' },
		fetch: { type: 'boolean', default: false },
		port: { type: 'string', default: '5179' },
		'no-open': { type: 'boolean', default: false },
		check: { type: 'boolean', default: false },
		root: { type: 'string', default: path.resolve(toolDir, '..', '..') },
		help: { type: 'boolean', default: false },
	},
});

if(values.help) {
	process.stdout.write(HELP);
	process.exit(0);
}

const root = path.resolve(values.root);
const loadOptions = {
	root,
	repos: values.repos ? values.repos.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_REPOS,
	base: values.base,
	onlyNew: values.new,
	only: [...values.only.flatMap(s => s.split(',')), ...positionals].map(s => s.trim()).filter(Boolean),
	fetch: values.fetch,
};

let groupsPromise = loadPrGroups(loadOptions);

if(values.check) {
	await check(await groupsPromise);
	process.exit(0);
}

/** Resolves a root-relative path from the browser, refusing anything outside the root or not skimmable. */
function resolveFile(relative) {
	if(typeof relative !== 'string' || !/\.(cs|razor)$/.test(relative)) {
		return null;
	}
	const full = path.resolve(root, relative);
	return full.startsWith(root + path.sep) ? full : null;
}

async function skeletonOf(relative, options) {
	const full = resolveFile(relative);
	if(full == null) {
		throw Object.assign(new Error('That path is not a .cs or .razor file under the tb folder.'), { status: 400 });
	}
	const src = (await readFile(full, 'utf8')).replace(/\r\n/g, '\n');
	const result = relative.endsWith('.razor') ? skeletonRazor(src, options) : skeletonCSharp(src, options);
	return { ...result, totalLines: src.split('\n').length };
}

async function check(groups) {
	let failed = 0;
	let total = 0;
	for(const group of groups) {
		for(const file of group.files) {
			total++;
			const { warnings, folds } = await skeletonOf(file.path, {});
			if(warnings.length > 0) {
				failed++;
				console.log(`${file.path}\n  ${warnings.join('\n  ')}`);
			} else if(folds.length === 0 && file.lines > 40) {
				console.log(`${file.path}\n  (no folds in ${file.lines} lines)`);
			}
		}
	}
	console.log(`${total} files, ${failed} with warnings.`);
}

const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function send(res, status, body, type = 'application/json') {
	res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
	res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, 'http://localhost');
	try {
		if(url.pathname === '/api/prs') {
			if(url.searchParams.get('refresh') === '1') {
				groupsPromise = loadPrGroups(loadOptions);
			}
			send(res, 200, { root, options: { ...loadOptions, root: undefined }, groups: await groupsPromise });
			return;
		}
		if(url.pathname === '/api/skeleton') {
			const options = {
				hidePrivate: url.searchParams.get('hidePrivate') === '1',
				hideComments: url.searchParams.get('hideComments') === '1',
			};
			send(res, 200, await skeletonOf(url.searchParams.get('path'), options));
			return;
		}
		if(url.pathname === '/api/raw') {
			const full = resolveFile(url.searchParams.get('path'));
			if(full == null) {
				send(res, 400, { error: 'That path is not a .cs or .razor file under the tb folder.' });
				return;
			}
			send(res, 200, { text: (await readFile(full, 'utf8')).replace(/\r\n/g, '\n') });
			return;
		}
		const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
		const file = path.resolve(toolDir, 'public', name);
		if(!file.startsWith(path.join(toolDir, 'public') + path.sep)) {
			send(res, 404, 'Not found', 'text/plain');
			return;
		}
		send(res, 200, await readFile(file, 'utf8'), CONTENT_TYPES[path.extname(file)] ?? 'text/plain');
	} catch(e) {
		send(res, e.status ?? (e.code === 'ENOENT' ? 404 : 500), { error: e.message });
	}
});

const port = Number(values.port);
server.on('error', e => {
	console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Pass --port to pick another.` : e.message);
	process.exit(1);
});
server.listen(port, '127.0.0.1', async () => {
	const address = `http://127.0.0.1:${port}/`;
	const groups = await groupsPromise;
	for(const g of groups) {
		console.log(`${g.repo.padEnd(16)} ${g.branch} → ${g.base}  ${g.commits} commits, ${g.files.length} files${g.pr ? `, PR #${g.pr.number}` : ''}`);
	}
	console.log(`skim is serving ${address}`);
	if(!values['no-open']) {
		execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [address], () => {});
	}
});
