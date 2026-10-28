// This module builds the header view of a .razor file. Directives and Razor comments are kept, each
// run of markup becomes one fold, and the inside of each `@code` or `@functions` block goes through the
// C# skeleton as a class body.

import { foldMarker, lexCSharp, lineAt, skeletonCSharp } from './csharpSkeleton.mjs';

const DIRECTIVE = /^\s*@(page|using|inject|inherits|implements|attribute|typeparam|layout|namespace|rendermode|preservewhitespace)\b/;

/** Returns `{ text, folds, warnings }` for a .razor file, with the same options as `skeletonCSharp`. */
export function skeletonRazor(src, options = {}) {
	const folds = [];
	const warnings = [];
	let out = '';
	let cursor = 0;
	for(const block of findCodeBlocks(src, warnings)) {
		out += markup(src, cursor, block.start, folds, options);
		const inner = src.slice(block.open + 1, block.close);
		const code = skeletonCSharp(inner, {
			...options,
			context: 'class',
			razor: true,
			folds,
			lineOffset: lineAt(src, block.open + 1) - 1,
		});
		warnings.push(...code.warnings);
		out += src.slice(block.start, block.open + 1) + code.text + '}';
		cursor = Math.min(src.length, block.close + 1);
	}
	out += markup(src, cursor, src.length, folds, options);
	return { text: out.replace(/\n{3,}/g, '\n\n'), folds, warnings };
}

/** Finds each `@code { … }` and `@functions { … }` block that is not inside a Razor comment. */
function findCodeBlocks(src, warnings) {
	const comments = razorComments(src);
	const blocks = [];
	const pattern = /@(code|functions)\b\s*\{/g;
	let m;
	while((m = pattern.exec(src)) != null) {
		if(comments.some(([from, to]) => m.index >= from && m.index < to)) {
			continue;
		}
		const open = m.index + m[0].length - 1;
		const lexed = lexCSharp(src, { start: open + 1, stopAtCloseBrace: true, razor: true });
		if(lexed.error != null) {
			warnings.push(`The @${m[1]} block on line ${lineAt(src, m.index)}: ${lexed.error.message}.`);
		}
		blocks.push({ start: m.index, open, close: lexed.end });
		pattern.lastIndex = lexed.end + 1;
	}
	return blocks;
}

function razorComments(src) {
	const ranges = [];
	let i = src.indexOf('@*');
	while(i >= 0) {
		const end = src.indexOf('*@', i + 2);
		const to = end < 0 ? src.length : end + 2;
		ranges.push([i, to]);
		i = src.indexOf('@*', to);
	}
	return ranges;
}

/** Turns the text between code blocks into kept directive and comment lines plus one fold per run of
 * markup. Blank lines inside a run belong to the run. */
function markup(src, from, to, folds, options) {
	if(from >= to) {
		return '';
	}
	const firstLine = lineAt(src, from);
	const lines = src.slice(from, to).split('\n');
	const kinds = [];
	let inComment = false;
	for(const line of lines) {
		const trimmed = line.trim();
		if(inComment || trimmed.startsWith('@*')) {
			kinds.push('comment');
			const close = line.lastIndexOf('*@');
			const open = line.lastIndexOf('@*');
			inComment = close < 0 || close < open;
		} else if(DIRECTIVE.test(line)) {
			kinds.push('keep');
		} else if(trimmed === '') {
			kinds.push('blank');
		} else {
			kinds.push('markup');
		}
	}
	const out = [];
	let k = 0;
	while(k < lines.length) {
		const kind = kinds[k];
		if(kind === 'markup') {
			let end = k;
			for(let j = k; j < lines.length && (kinds[j] === 'markup' || kinds[j] === 'blank'); j++) {
				if(kinds[j] === 'markup') {
					end = j;
				}
			}
			const body = lines.slice(k, end + 1).join('\n');
			const id = folds.length;
			folds.push({ id, kind: 'markup', body, lines: end - k + 1, startLine: firstLine + k, endLine: firstLine + end });
			out.push(foldMarker(id));
			k = end + 1;
			continue;
		}
		if(kind === 'comment' && options.hideComments) {
			k++;
			continue;
		}
		out.push(kind === 'blank' ? '' : lines[k]);
		k++;
	}
	return out.join('\n');
}
