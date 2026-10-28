// This module finds a TypeScript compiler that is already installed, so skim can parse .ts files
// without an npm install of its own. It looks in SKIM_TYPESCRIPT, in the repos' node_modules folders,
// and in the global npm root, and it loads the first one it finds.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

let loaded = null;

/**
 * Returns `{ ts, from, tried }`, where `ts` is the compiler module (or null when none was found), `from`
 * is the package folder it came from, and `tried` lists the folders that were searched. The search runs
 * once, the first time a .ts file is skeletonized, and its result is kept.
 */
export function loadTypeScript(root) {
	loaded ??= find(root);
	return loaded;
}

async function find(root) {
	const tried = [];
	for await (const dir of candidates(root)) {
		tried.push(dir);
		if(!existsSync(path.join(dir, 'package.json'))) {
			continue;
		}
		try {
			const ts = createRequire(import.meta.url)(dir);
			return { ts, from: dir, tried };
		} catch {
			// This copy cannot be loaded, so the search moves on to the next one.
		}
	}
	return { ts: null, from: null, tried };
}

/** Yields the typescript package folders to try, in order. The global npm root is only asked for when
 * every earlier folder has been tried, since that runs npm. */
async function* candidates(root) {
	if(process.env.SKIM_TYPESCRIPT) {
		yield path.resolve(process.env.SKIM_TYPESCRIPT);
	}
	yield path.join(root, 'Athena', 'Venus', 'node_modules', 'typescript');
	yield path.join(root, 'Deku', 'Dekutron', 'ElectronHostHook', 'node_modules', 'typescript');
	try {
		const { stdout } = await run('npm', ['root', '-g']);
		if(stdout.trim() !== '') {
			yield path.join(stdout.trim(), 'typescript');
		}
	} catch {
		// npm is not on the path, so only the folder next to node is left to try.
	}
	yield path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'typescript');
}
