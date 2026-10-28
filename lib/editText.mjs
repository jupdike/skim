// This module turns a source file and a list of edits into skeleton text. Each edit either removes a
// range (a hidden member) or replaces it with a fold marker, and the C# and TypeScript skeletons both
// build their text here, so their folds and their hidden-comment output look the same.

const FOLD_OPEN = '\uE000';
const FOLD_CLOSE = '\uE001';
const DIGIT_BASE = 0xE010;

const DROPPED_LINE = '\u0007';

/** Returns the marker that stands in for fold `id` in skeleton text. The marker uses private-use
 * characters only, so a syntax highlighter passes it through as plain text and the browser can find it. */
export function foldMarker(id) {
	let digits = '';
	for(const d of String(id)) {
		digits += String.fromCharCode(DIGIT_BASE + Number(d));
	}
	return FOLD_OPEN + digits + FOLD_CLOSE;
}

/**
 * Applies `edits` to `src` and returns the skeleton text. An edit is `{ from, to }`, which removes the
 * range, or `{ from, to, fold: { kind, body } }`, which replaces the range with a marker for a new entry
 * in `folds`. An edit that starts inside an earlier edit is dropped, so folds inside a hidden member
 * disappear with it. `comments` lists `[from, to]` ranges that `options.hideComments` removes, and
 * `lineOf` maps an index in `src` to the line number that a fold reports.
 */
export function applyEdits({ src, edits, comments, options, folds, lineOf }) {
	const copy = options.hideComments ? withoutComments(src, comments) : src;
	const sorted = [...edits].sort((a, b) => (a.from - b.from) || (b.to - a.to));
	let out = '';
	let cursor = 0;
	for(const edit of sorted) {
		if(edit.from < cursor) {
			continue;
		}
		out += copy.slice(cursor, edit.from);
		if(edit.fold != null) {
			const id = folds.length;
			const body = edit.fold.body;
			folds.push({
				id,
				kind: edit.fold.kind,
				body,
				lines: body.trim().split('\n').length,
				startLine: lineOf(edit.from),
				endLine: lineOf(edit.to),
			});
			out += foldMarker(id);
		}
		cursor = edit.to;
	}
	out += copy.slice(cursor);
	if(options.hideComments) {
		out = out.split('\n').filter(l => !l.includes(DROPPED_LINE)).map(l => l.replace(/[ \t]+$/, '')).join('\n');
	}
	if(options.hideComments || options.hidePrivate) {
		out = out.replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
	}
	return out;
}

/** Returns the source with comments blanked out. A line that held nothing but comments is marked so
 * that `applyEdits` can drop it entirely. The result has the same length as the source, so edit
 * positions still apply. */
function withoutComments(src, comments) {
	const chars = src.split('');
	for(const [from, to] of comments) {
		for(let k = from; k < to; k++) {
			if(chars[k] !== '\n') {
				chars[k] = ' ';
			}
		}
	}
	let lineStart = 0;
	for(let k = 0; k <= chars.length; k++) {
		if(k === chars.length || chars[k] === '\n') {
			const blankNow = chars.slice(lineStart, k).every(ch => ch === ' ' || ch === '\t');
			const blankBefore = src.slice(lineStart, k).trim() === '';
			if(blankNow && !blankBefore) {
				chars[lineStart] = DROPPED_LINE;
			}
			lineStart = k + 1;
		}
	}
	return chars.join('');
}
