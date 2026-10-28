// This module turns C# source into a "header" view. Types, member signatures, attributes and comments
// are kept, and method bodies, accessor bodies and long initializers are replaced by fold markers that
// the browser can expand again. It is a hand-written lexer plus a brace-and-semicolon structure pass,
// not a full parser, so it reports a warning whenever the structure does not add up.

import { applyEdits, foldMarker } from './editText.mjs';

export { foldMarker };

// Short bodies and initializers read fine inline, so only longer ones are folded. The TypeScript
// skeleton uses the same limits.
export const MAX_INLINE_BODY = 50;
export const MAX_INLINE_EXPRESSION = 100;

/**
 * Lexes C# source and returns a mask: a copy of the source in which every string, character literal,
 * comment and preprocessor line is replaced by spaces, with newlines kept. Only real code braces,
 * parentheses and semicolons remain in the mask, so the structure pass can count them safely.
 * When `stopAtCloseBrace` is true, the scan starts just inside a `{` and `end` is the index of its
 * matching `}`. When `razor` is true, the source is the code of a .razor file, and markup inside it
 * (`@<div>…</div>` templates and tags that start a statement) is masked like a string.
 */
export function lexCSharp(src, { start = 0, stopAtCloseBrace = false, razor = false } = {}) {
	const lexer = new Lexer(src, razor);
	const end = lexer.scanCode(start, stopAtCloseBrace ? 'block' : 'file');
	return { mask: lexer.mask.join(''), comments: lexer.comments, error: lexer.error, end };
}

class Lexer {

	constructor(src, razor) {
		this.src = src;
		this.razor = razor;
		this.mask = src.split('');
		this.comments = [];
		this.error = null;
	}

	fail(message, at) {
		if(this.error == null) {
			this.error = { message, line: lineAt(this.src, at) };
		}
	}

	blank(from, to) {
		for(let k = from; k < to; k++) {
			if(this.mask[k] !== '\n') {
				this.mask[k] = ' ';
			}
		}
	}

	/** Scans code from `i`. In "file" mode the scan runs to the end of the source. In "block" mode it
	 * returns the index of the `}` that closes the block it started in. In "hole" mode it is inside an
	 * interpolated string's `{…}` hole, and it returns the index of the hole's closing `}`, skipping any
	 * `:format` part. */
	scanCode(i, mode) {
		const src = this.src;
		const n = src.length;
		let depth = 0;
		let parens = 0;
		while(i < n) {
			const c = src[i];
			const next = src[i + 1];
			if(c === '/' && next === '/') {
				const end = indexOrEnd(src, '\n', i);
				this.comment(i, end);
				i = end;
				continue;
			}
			if(c === '/' && next === '*') {
				let end = src.indexOf('*/', i + 2);
				if(end < 0) {
					this.fail('The file ends inside a block comment', i);
					end = n;
				} else {
					end += 2;
				}
				this.comment(i, end);
				i = end;
				continue;
			}
			if(c === '#' && mode !== 'hole' && isLineStart(src, i)) {
				const end = indexOrEnd(src, '\n', i);
				this.blank(i, end);
				i = end;
				continue;
			}
			if(c === '\'') {
				const end = this.skipChar(i);
				this.blank(i, end);
				i = end;
				continue;
			}
			if(this.razor && mode !== 'hole' && this.isMarkupStart(i)) {
				const end = this.skipMarkup(c === '@' ? i + 1 : i);
				this.blank(i, end);
				i = end;
				continue;
			}
			const str = stringStart(src, i);
			if(str != null) {
				const end = this.skipString(str);
				this.blank(i, end);
				i = end;
				continue;
			}
			if(c === '(' || c === '[') {
				parens++;
			} else if(c === ')' || c === ']') {
				parens--;
			} else if(c === '{') {
				depth++;
			} else if(c === '}') {
				if(depth === 0 && mode !== 'file') {
					return i;
				}
				depth--;
			} else if(c === ':' && mode === 'hole' && depth === 0 && parens === 0 && next !== ':' && src[i - 1] !== ':') {
				// The rest of the hole is a format string such as `{value:N0}`, which runs to the next `}`.
				const close = src.indexOf('}', i);
				if(close >= 0) {
					return close;
				}
			}
			i++;
		}
		if(mode !== 'file') {
			this.fail('A brace is never closed', n);
		}
		return n;
	}

	/** Returns true when `i` starts Razor markup: a `@<tag` template, a `@*` comment, or a tag at the start
	 * of a statement. */
	isMarkupStart(i) {
		const src = this.src;
		const c = src[i];
		if(c === '@') {
			return src[i + 1] === '*' || (src[i + 1] === '<' && /[A-Za-z]/.test(src[i + 2] ?? ''));
		}
		if(c !== '<' || !/[A-Za-z]/.test(src[i + 1] ?? '')) {
			return false;
		}
		let k = i - 1;
		while(k >= 0 && /\s/.test(this.mask[k])) {
			k--;
		}
		return k < 0 || '{};'.includes(this.mask[k]);
	}

	/** Skips Razor markup starting at `i`, which is either `*` of a `@*` comment or the `<` of an
	 * element, and returns the index just after the element closes. Tags are counted, and attribute
	 * values, comments and void elements are skipped. */
	skipMarkup(i) {
		const src = this.src;
		const n = src.length;
		if(src[i] === '*') {
			const end = src.indexOf('*@', i + 1);
			return end < 0 ? n : end + 2;
		}
		let depth = 0;
		let j = i;
		while(j < n) {
			if(src.startsWith('@*', j)) {
				const end = src.indexOf('*@', j + 2);
				j = end < 0 ? n : end + 2;
				continue;
			}
			if(src.startsWith('<!--', j)) {
				const end = src.indexOf('-->', j + 4);
				j = end < 0 ? n : end + 3;
				continue;
			}
			if(src.startsWith('@@', j)) {
				j += 2;
				continue;
			}
			if(src[j] === '@' && /[A-Za-z_({]/.test(src[j + 1] ?? '')) {
				// An expression such as `@Row(EnumSegments<Flow>(x))` can hold generics that look like tags,
				// and the code in `@foreach(…) { … }` can too.
				j = this.skipRazorCode(j + 1);
				continue;
			}
			if(src[j] === '<' && src[j + 1] === '/') {
				const end = indexOrEnd(src, '>', j);
				depth--;
				j = end + 1;
				if(depth <= 0) {
					return Math.min(j, n);
				}
				continue;
			}
			if(src[j] === '<' && /[A-Za-z]/.test(src[j + 1] ?? '')) {
				const name = /^[A-Za-z][\w.:-]*/.exec(src.slice(j + 1, j + 64))[0];
				const end = this.tagEnd(j + 1);
				const selfClosing = src[end - 1] === '/' || VOID_ELEMENTS.has(name.toLowerCase());
				j = end + 1;
				if(!selfClosing) {
					depth++;
				} else if(depth === 0) {
					return Math.min(j, n);
				}
				continue;
			}
			j++;
		}
		this.fail('A Razor markup block is not closed', i);
		return n;
	}

	/** Skips Razor code in markup, starting just after its `@`, and returns the index after it. The code
	 * is a `{ … }` block, a statement such as `if(…) { … } else { … }` whose blocks are C#, or an
	 * expression such as `(a + b)`, `Item.Title` or `Row(x)[0]`. */
	skipRazorCode(j) {
		const src = this.src;
		if(src[j] === '{') {
			return this.scanCode(j + 1, 'block') + 1;
		}
		const word = /^\w+/.exec(src.slice(j, j + 16))?.[0];
		if(RAZOR_STATEMENTS.has(word)) {
			return this.skipRazorStatement(j);
		}
		return this.skipRazorExpression(j);
	}

	/** Skips `keyword (…) { … }` and any `else`, `catch` or `finally` parts that follow it. */
	skipRazorStatement(j) {
		const src = this.src;
		let k = j;
		for(;;) {
			k = skipSpaces(src, k + /^\w+/.exec(src.slice(k))[0].length);
			if(src.startsWith('if', k) && !/\w/.test(src[k + 2] ?? '')) {
				k = skipSpaces(src, k + 2);
			}
			if(src[k] === '(') {
				k = skipSpaces(src, this.skipBalanced(k));
			}
			if(src[k] !== '{') {
				return k;
			}
			k = this.scanCode(k + 1, 'block') + 1;
			const next = skipSpaces(src, k);
			const continuation = /^(else|catch|finally)\b/.exec(src.slice(next, next + 8));
			if(continuation == null) {
				return k;
			}
			k = next;
		}
	}

	/** Skips a Razor expression in markup, such as `(a + b)`, `Name`, `Item.Title` or `Row(x)[0]`,
	 * starting just after its `@`, and returns the index after it. */
	skipRazorExpression(j) {
		const src = this.src;
		if(src[j] === '(') {
			return this.skipBalanced(j);
		}
		while(j < src.length) {
			const c = src[j];
			if(/[\w]/.test(c)) {
				j++;
			} else if(c === '(' || c === '[') {
				j = this.skipBalanced(j);
			} else if((c === '.' || c === '?') && /[\w.]/.test(src[j + 1] ?? '')) {
				j++;
			} else {
				return j;
			}
		}
		return j;
	}

	/** Skips a `(…)` or `[…]` group starting at `j`, including any quoted text inside it, and returns the
	 * index after its closing bracket. */
	skipBalanced(j) {
		const src = this.src;
		const n = src.length;
		let depth = 0;
		while(j < n) {
			const c = src[j];
			if(c === '"' || c === '\'') {
				let k = j + 1;
				while(k < n && src[k] !== c && src[k] !== '\n') {
					k += src[k] === '\\' ? 2 : 1;
				}
				j = k + 1;
				continue;
			}
			if(c === '(' || c === '[') {
				depth++;
			} else if(c === ')' || c === ']') {
				depth--;
				if(depth === 0) {
					return j + 1;
				}
			}
			j++;
		}
		return n;
	}

	/** Returns the index of the `>` that ends the tag starting at `j`, skipping quoted attribute values
	 * and `@(…)` expressions. */
	tagEnd(j) {
		const src = this.src;
		const n = src.length;
		let parens = 0;
		while(j < n) {
			const c = src[j];
			if((c === '"' || c === '\'') && parens === 0) {
				j = indexOrEnd(src, c, j + 1) + 1;
				continue;
			}
			if(c === '(') {
				parens++;
			} else if(c === ')') {
				parens--;
			} else if(c === '>' && parens <= 0) {
				return j;
			}
			j++;
		}
		return n;
	}

	comment(from, to) {
		this.comments.push([from, to]);
		this.blank(from, to);
	}

	skipChar(i) {
		const src = this.src;
		const n = src.length;
		let j = i + 1;
		j += src[j] === '\\' ? 2 : 1;
		while(j < n && src[j] !== '\'' && src[j] !== '\n') {
			j++;
		}
		if(src[j] === '\'') {
			return j + 1;
		}
		this.fail('A character literal is not closed', i);
		return j;
	}

	skipString({ quote, dollars, verbatim }) {
		const src = this.src;
		const n = src.length;
		let quotes = 0;
		while(src[quote + quotes] === '"') {
			quotes++;
		}
		if(quotes >= 3 && !verbatim) {
			return this.skipRawString(quote + quotes, quotes, dollars);
		}
		let j = quote + 1;
		while(j < n) {
			const c = src[j];
			if(verbatim) {
				if(c === '"') {
					if(src[j + 1] === '"') {
						j += 2;
						continue;
					}
					return j + 1;
				}
			} else {
				if(c === '\\') {
					j += 2;
					continue;
				}
				if(c === '"') {
					return j + 1;
				}
				if(c === '\n') {
					this.fail('A string is not closed', quote);
					return j;
				}
			}
			if(dollars > 0 && c === '{') {
				if(src[j + 1] === '{') {
					j += 2;
					continue;
				}
				j = this.scanCode(j + 1, 'hole') + 1;
				continue;
			}
			if(dollars > 0 && c === '}' && src[j + 1] === '}') {
				j += 2;
				continue;
			}
			j++;
		}
		this.fail('A string is not closed', quote);
		return n;
	}

	/** Skips a raw string `"""…"""`. With `$$"""`, a hole opens with as many `{` as there are `$`. */
	skipRawString(j, quotes, dollars) {
		const src = this.src;
		const n = src.length;
		while(j < n) {
			if(src[j] === '"') {
				let run = 0;
				while(src[j + run] === '"') {
					run++;
				}
				if(run >= quotes) {
					return j + run;
				}
				j += run;
				continue;
			}
			if(dollars > 0 && src[j] === '{') {
				let run = 0;
				while(src[j + run] === '{') {
					run++;
				}
				if(run >= dollars) {
					j = this.scanCode(j + run, 'hole') + dollars;
					continue;
				}
				j += run;
				continue;
			}
			j++;
		}
		this.fail('A raw string is not closed', j);
		return n;
	}
}

/** Returns where a string literal starts at `i` (after any `$` and `@` prefixes), or null. */
function stringStart(src, i) {
	const c = src[i];
	if(c !== '"' && c !== '$' && c !== '@') {
		return null;
	}
	let j = i;
	let dollars = 0;
	let verbatim = false;
	while(src[j] === '$' || src[j] === '@') {
		if(src[j] === '$') {
			dollars++;
		} else {
			verbatim = true;
		}
		j++;
	}
	if(src[j] !== '"') {
		return null;
	}
	return { quote: j, dollars, verbatim };
}

/**
 * Builds the skeleton of a C# file. Options: `hidePrivate` drops private members, `hideComments` drops
 * comments, and `context` is the kind of scope the source starts in ("namespace" for a file, "class"
 * for the inside of a Razor `@code` block). `folds` is shared when several pieces of one file are
 * skeletonized, so fold ids stay unique, and `lineOffset` shifts the reported line numbers.
 * Returns `{ text, folds, warnings }`.
 */
export function skeletonCSharp(src, options = {}) {
	const folds = options.folds ?? [];
	const lexed = lexCSharp(src, { razor: options.razor });
	const warnings = [];
	if(lexed.error != null) {
		warnings.push(`${lexed.error.message} (line ${lexed.error.line + (options.lineOffset ?? 0)}).`);
	}
	const skeleton = new Skeleton(src, lexed, options, warnings);
	skeleton.block(0, src.length, options.context ?? 'namespace');
	const text = skeleton.build(folds);
	if(!bracesBalance(text, options.razor)) {
		warnings.push('The braces in the skeleton do not balance, so some members may be cut or merged.');
	}
	return { text, folds, warnings };
}

class Skeleton {

	constructor(src, lexed, options, warnings) {
		this.src = src;
		this.mask = lexed.mask;
		this.comments = lexed.comments;
		this.options = options;
		this.warnings = warnings;
		this.lineOffset = options.lineOffset ?? 0;
		this.edits = [];
		this.match = matchBraces(lexed.mask, src, warnings, this.lineOffset);
	}

	/** Walks the members of a scope between `start` and `end`. A member ends at a `;` or at the `}` that
	 * closes its block. `ctx` is "namespace", "class", "interface", "enum" or "accessors". */
	block(start, end, ctx) {
		if(ctx === 'enum') {
			return;
		}
		const mask = this.mask;
		let segStart = start;
		let parens = 0;
		for(let i = start; i < end; i++) {
			const c = mask[i];
			if(c === '(' || c === '[') {
				parens++;
				continue;
			}
			if(c === ')' || c === ']') {
				parens--;
				continue;
			}
			if(parens > 0) {
				continue;
			}
			if(c === ';') {
				this.member(segStart, i + 1, ctx);
				segStart = i + 1;
				continue;
			}
			if(c === '=') {
				const next = mask[i + 1];
				if(next === '=') {
					i++;
					continue;
				}
				if('!<>'.includes(mask[i - 1])) {
					continue;
				}
				const isArrow = next === '>';
				const exprStart = isArrow ? i + 2 : i + 1;
				const semi = this.statementEnd(exprStart, end);
				// A constant's value is part of its signature, so it stays when it fits on one line.
				const isConst = !isArrow && /\bconst\b/.test(mask.slice(segStart, i));
				this.foldExpression(exprStart, semi, isArrow ? 'expr' : 'init', isConst);
				this.member(segStart, semi + 1, ctx);
				segStart = semi + 1;
				i = semi;
				continue;
			}
			if(c === '{') {
				const close = this.match.get(i) ?? end;
				const header = stripBrackets(mask.slice(segStart, i)).trim();
				const kind = classify(header, ctx);
				let memberEnd = close + 1;
				if(kind === 'property') {
					this.block(i + 1, close, 'accessors');
					// A property can have an initializer after its accessors, as in `{ get; set; } = new();`.
					const after = skipSpaces(mask, close + 1);
					if(mask[after] === '=' && mask[after + 1] !== '>' && after < end) {
						const semi = this.statementEnd(after + 1, end);
						this.foldExpression(after + 1, semi, 'init');
						memberEnd = semi + 1;
					}
				} else if(kind === 'body') {
					this.foldBody(i, close);
				} else {
					this.block(i + 1, close, kind);
				}
				this.member(segStart, memberEnd, ctx, header);
				segStart = memberEnd;
				i = memberEnd - 1;
			}
		}
	}

	/** Records the member between `from` and `to`, and hides it when private members are hidden. */
	member(from, to, ctx, header) {
		if(!this.options.hidePrivate || ctx === 'accessors' || ctx === 'enum') {
			return;
		}
		const h = header ?? stripBrackets(this.mask.slice(from, to)).trim();
		if(isPrivate(h, ctx)) {
			this.edits.push({ from, to });
		}
	}

	/** Returns the index of the `;` that ends the statement starting at `k`, skipping nested brackets. */
	statementEnd(k, end) {
		const mask = this.mask;
		let depth = 0;
		for(let i = k; i < end; i++) {
			const c = mask[i];
			if(c === '(' || c === '[' || c === '{') {
				depth++;
			} else if(c === ')' || c === ']' || c === '}') {
				depth--;
			} else if(c === ';' && depth === 0) {
				return i;
			}
		}
		this.warnings.push(`A member that starts on line ${this.line(k)} has no closing semicolon.`);
		return end;
	}

	foldBody(open, close) {
		const inner = this.src.slice(open + 1, close);
		const trimmed = inner.trim();
		if(trimmed === '' || (!trimmed.includes('\n') && trimmed.length <= MAX_INLINE_BODY)) {
			return;
		}
		this.edits.push({ from: open + 1, to: close, fold: { kind: 'body', body: inner } });
	}

	foldExpression(from, to, kind, keepOneLine = false) {
		const src = this.src;
		let s = from;
		while(s < to && /\s/.test(src[s])) {
			s++;
		}
		let e = to;
		while(e > s && /\s/.test(src[e - 1])) {
			e--;
		}
		const text = src.slice(s, e);
		if(text === '' || (!text.includes('\n') && (keepOneLine || text.length <= MAX_INLINE_EXPRESSION))) {
			return;
		}
		this.edits.push({ from: s, to: e, fold: { kind, body: text } });
	}

	line(index) {
		return lineAt(this.src, index) + this.lineOffset;
	}

	/** Applies the edits and returns the skeleton text. Edits inside a hidden member are dropped. */
	build(folds) {
		return applyEdits({
			src: this.src,
			edits: this.edits,
			comments: this.comments,
			options: this.options,
			folds,
			lineOf: index => this.line(index),
		});
	}
}

const RAZOR_STATEMENTS = new Set(['if', 'foreach', 'for', 'while', 'switch', 'using', 'lock', 'do', 'try']);

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Decides what a `{` opens from the header text before it (with comments and attributes removed). */
function classify(header, ctx) {
	if(ctx === 'accessors') {
		return 'body';
	}
	const typeMatch = /(^|[\s;])(class|struct|interface|record|enum|namespace)\s+[@\w]/.exec(header);
	// A method with a `where T : class` constraint mentions "class" after its parameter list.
	if(typeMatch != null && !header.slice(0, typeMatch.index).includes('(')) {
		switch(typeMatch[2]) {
			case 'interface':
			case 'enum':
			case 'namespace':
				return typeMatch[2];
			default:
				return 'class';
		}
	}
	if(header === '' || header.includes('(')) {
		return 'body';
	}
	return 'property';
}

function isPrivate(header, ctx) {
	const h = header.replace(/\s+/g, ' ');
	if(h === '' || /^(using|namespace)\b/.test(h)) {
		return false;
	}
	if(/\bprivate\b/.test(h)) {
		return true;
	}
	// Members of a class or struct are private when they have no access modifier. Interface members are
	// public, and types directly in a namespace are internal.
	if(ctx !== 'class' || /\b(public|protected|internal)\b/.test(h)) {
		return false;
	}
	// An explicit interface implementation such as `void IFoo.Bar()` has no modifier but is public surface.
	const name = h.split('(')[0].trim();
	return !/\.\s*[@\w]+(\s*<[^>]*>)?$/.test(name);
}

/** Maps the index of each `{` in the mask to the index of its `}`. */
function matchBraces(mask, src, warnings, lineOffset) {
	const match = new Map();
	const stack = [];
	for(let i = 0; i < mask.length; i++) {
		if(mask[i] === '{') {
			stack.push(i);
		} else if(mask[i] === '}') {
			if(stack.length === 0) {
				warnings.push(`Line ${lineAt(src, i) + lineOffset} has a } that closes nothing.`);
				continue;
			}
			match.set(stack.pop(), i);
		}
	}
	if(stack.length > 0) {
		warnings.push(`The { on line ${lineAt(src, stack[0]) + lineOffset} is never closed.`);
	}
	return match;
}

/** Returns true when the braces in `text`, ignoring strings and comments, open and close in order. */
export function bracesBalance(text, razor = false) {
	const { mask, error } = lexCSharp(text, { razor });
	if(error != null) {
		return false;
	}
	let depth = 0;
	for(const c of mask) {
		if(c === '{') {
			depth++;
		} else if(c === '}' && --depth < 0) {
			return false;
		}
	}
	return depth === 0;
}

/** Removes `[…]` groups, which are attributes, indexer parameters and array ranks. */
function stripBrackets(text) {
	let out = '';
	let depth = 0;
	for(const c of text) {
		if(c === '[') {
			depth++;
		} else if(c === ']') {
			depth = Math.max(0, depth - 1);
		} else if(depth === 0) {
			out += c;
		}
	}
	return out;
}

function skipSpaces(text, i) {
	while(i < text.length && /\s/.test(text[i])) {
		i++;
	}
	return i;
}

function indexOrEnd(text, needle, from) {
	const i = text.indexOf(needle, from);
	return i < 0 ? text.length : i;
}

function isLineStart(text, i) {
	for(let k = i - 1; k >= 0 && text[k] !== '\n'; k--) {
		if(text[k] !== ' ' && text[k] !== '\t') {
			return false;
		}
	}
	return true;
}

/** Returns the 1-based line number of `index` in `text`. */
export function lineAt(text, index) {
	let line = 1;
	const end = Math.min(index, text.length);
	for(let k = 0; k < end; k++) {
		if(text.charCodeAt(k) === 10) {
			line++;
		}
	}
	return line;
}
