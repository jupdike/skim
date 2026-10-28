// This module turns TypeScript source into a "header" view. Declarations, signatures, types and comments
// are kept, and function bodies, long arrow expressions and long initializers are replaced by fold
// markers that the browser can expand again. Unlike the C# skeleton, it works from the TypeScript
// compiler's syntax tree, which the caller passes in (see typescript.mjs).

import { MAX_INLINE_BODY, MAX_INLINE_EXPRESSION } from './csharpSkeleton.mjs';
import { applyEdits } from './editText.mjs';

// The compiler can report many follow-on errors for one mistake, so only the first few are shown.
const MAX_WARNINGS = 5;

/**
 * Builds the skeleton of a TypeScript file with the compiler module `ts`. Options: `fileName` decides
 * whether the source is TSX or a .d.ts file, `hidePrivate` drops private class members and, in a file
 * that imports or exports, the top-level declarations it does not export, and `hideComments` drops
 * comments. Returns `{ text, folds, warnings }`.
 */
export function skeletonTypeScript(src, options, ts) {
	const fileName = options.fileName ?? 'file.ts';
	const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
	const lineOf = index => sourceFile.getLineAndCharacterOfPosition(index).line + 1;
	const diagnostics = sourceFile.parseDiagnostics ?? [];
	const warnings = diagnostics.slice(0, MAX_WARNINGS).map(d =>
		`${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (line ${lineOf(d.start)}).`);
	if(diagnostics.length > MAX_WARNINGS) {
		warnings.push(`The compiler reported ${diagnostics.length - MAX_WARNINGS} more errors.`);
	}
	const skeleton = new Skeleton(ts, sourceFile, src, options);
	skeleton.statements(sourceFile.statements, true);
	const folds = [];
	const text = applyEdits({
		src,
		edits: skeleton.edits,
		comments: options.hideComments ? collectComments(ts, sourceFile, src) : [],
		options,
		folds,
		lineOf,
	});
	return { text, folds, warnings };
}

class Skeleton {

	constructor(ts, sourceFile, src, options) {
		this.ts = ts;
		this.sourceFile = sourceFile;
		this.src = src;
		this.options = options;
		this.edits = [];
		this.isModule = sourceFile.statements.some(s => isModuleSyntax(ts, s));
		this.exported = this.isModule ? exportedNames(ts, sourceFile) : new Set();
	}

	/** Walks the statements of a file or a namespace. At the top level of a module, statements that
	 * declare nothing exported are hidden when private members are hidden. */
	statements(list, topLevel) {
		for(const statement of list) {
			if(topLevel && this.options.hidePrivate && this.isModule && this.isUnexported(statement)) {
				this.hide(statement);
				continue;
			}
			this.visit(statement);
		}
	}

	/** Adds the folds for `node` and the code inside it. A node that is folded is not walked further. */
	visit(node) {
		const ts = this.ts;
		if(ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
			return;
		}
		if(ts.isFunctionLike(node)) {
			this.functionBody(node);
			return;
		}
		if(ts.isClassLike(node)) {
			this.classMembers(node);
			return;
		}
		if(ts.isModuleDeclaration(node)) {
			if(node.body != null && ts.isModuleBlock(node.body)) {
				this.statements(node.body.statements, false);
			} else if(node.body != null) {
				// A dotted namespace such as `namespace A.B { … }` nests one declaration in another.
				this.visit(node.body);
			}
			return;
		}
		if(ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) {
			this.initializer(node.initializer);
			return;
		}
		if(ts.isExportAssignment(node)) {
			this.initializer(node.expression);
			return;
		}
		if(ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)
			&& node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			// An assignment such as `(window as any).api = { … }` publishes an API the way an export does.
			this.initializer(node.expression.right);
			return;
		}
		if(ts.isObjectLiteralExpression(node) && this.isModuleObject(node)) {
			this.objectMembers(node);
			return;
		}
		ts.forEachChild(node, child => this.visit(child));
	}

	/** Folds the body of a function, method, constructor, accessor or arrow function. A block body
	 * follows the same rule as a C# method body, and an arrow's expression body follows the rule for
	 * expressions. A declaration without a body, such as an overload, is left alone. */
	functionBody(node) {
		const body = node.body;
		if(body == null) {
			return;
		}
		if(this.ts.isBlock(body)) {
			this.foldBlock(body);
		} else {
			this.foldExpression(body, 'expr');
		}
	}

	classMembers(node) {
		const ts = this.ts;
		for(const member of node.members) {
			if(this.options.hidePrivate && isPrivateMember(ts, member)) {
				this.hide(member);
			} else if(ts.isPropertyDeclaration(member)) {
				this.initializer(member.initializer);
			} else if(ts.isClassStaticBlockDeclaration(member)) {
				this.foldBlock(member.body);
			} else {
				this.visit(member);
			}
		}
	}

	objectMembers(node) {
		const ts = this.ts;
		for(const property of node.properties) {
			if(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isAccessor(property)) {
				this.visit(property);
			}
		}
	}

	/** Folds an initializer or an assigned value. A function keeps its signature and folds its body, a
	 * class or a module object shows its members, and any other value folds when it is long. */
	initializer(expression) {
		if(expression == null) {
			return;
		}
		const ts = this.ts;
		const value = unwrap(ts, expression);
		if(ts.isFunctionLike(value) || ts.isClassLike(value)) {
			this.visit(value);
		} else if(ts.isObjectLiteralExpression(value) && this.isModuleObject(value)) {
			this.objectMembers(value);
		} else {
			this.foldExpression(expression, 'init');
		}
	}

	/** Returns true when an object literal holds functions, as in `export const Module = { init() {…} }`,
	 * or lists them by name, as in `window.api = { setup, dispose }`. Such an object is an API like a
	 * class, so its members are shown instead of folding it whole. */
	isModuleObject(node) {
		const ts = this.ts;
		return node.properties.some(p => {
			if(ts.isMethodDeclaration(p) || ts.isAccessor(p) || ts.isShorthandPropertyAssignment(p)) {
				return true;
			}
			if(!ts.isPropertyAssignment(p)) {
				return false;
			}
			const value = unwrap(ts, p.initializer);
			return ts.isFunctionLike(value) || (ts.isObjectLiteralExpression(value) && this.isModuleObject(value));
		});
	}

	foldBlock(block) {
		const open = block.getStart(this.sourceFile);
		const close = block.end - 1;
		const inner = this.src.slice(open + 1, close);
		const trimmed = inner.trim();
		if(trimmed === '' || (!trimmed.includes('\n') && trimmed.length <= MAX_INLINE_BODY)) {
			return;
		}
		this.edits.push({ from: open + 1, to: close, fold: { kind: 'body', body: inner } });
	}

	foldExpression(node, kind) {
		const from = node.getStart(this.sourceFile);
		const text = this.src.slice(from, node.end);
		if(text.includes('\n') || text.length > MAX_INLINE_EXPRESSION) {
			this.edits.push({ from, to: node.end, fold: { kind, body: text } });
		}
	}

	/** Removes a statement or member along with the comments directly above it and any comment after it
	 * on its last line. The removal starts at the start of the line of the first comment above, so a
	 * blank line before the comments and any file header above them stay. When nothing else is on its
	 * last line, the removal also takes that line's newline, so no blank line is left in its place. */
	hide(node) {
		const ts = this.ts;
		const src = this.src;
		let start = node.getStart(this.sourceFile);
		const comments = ts.getLeadingCommentRanges(src, node.pos) ?? [];
		for(let k = comments.length - 1; k >= 0; k--) {
			const gap = src.slice(comments[k].end, start);
			if(gap.trim() !== '' || gap.split('\n').length > 2) {
				break;
			}
			start = comments[k].pos;
		}
		const from = Math.max(src.lastIndexOf('\n', start - 1) + 1, node.pos);
		let end = node.end;
		for(const comment of ts.getTrailingCommentRanges(src, end) ?? []) {
			end = comment.end;
		}
		const lineEnd = src.indexOf('\n', end);
		// When code before the node shares its first line, the newline stays so the lines do not join.
		if(lineEnd >= 0 && src.slice(end, lineEnd).trim() === '' && (from === 0 || src[from - 1] === '\n')) {
			end = lineEnd + 1;
		}
		this.edits.push({ from, to: end });
	}

	/** Returns true for a top-level declaration that the module does not export. Imports, ambient
	 * `declare` declarations, namespaces and plain statements always stay. */
	isUnexported(statement) {
		const ts = this.ts;
		if(hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword) || hasModifier(ts, statement, ts.SyntaxKind.DeclareKeyword)) {
			return false;
		}
		if(ts.isVariableStatement(statement)) {
			return statement.declarationList.declarations.every(d => !ts.isIdentifier(d.name) || !this.exported.has(d.name.text));
		}
		const declares = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
			|| ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement);
		return declares && statement.name != null && !this.exported.has(statement.name.text);
	}
}

/** Removes the wrappers that do not change what a value is: parentheses, `as`, `satisfies`, `<T>` casts
 * and `!`. */
function unwrap(ts, node) {
	while(ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
		|| ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
		node = node.expression;
	}
	return node;
}

function hasModifier(ts, node, kind) {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some(m => m.kind === kind);
}

function isPrivateMember(ts, member) {
	return hasModifier(ts, member, ts.SyntaxKind.PrivateKeyword) || (member.name != null && ts.isPrivateIdentifier(member.name));
}

/** Returns true when a statement makes its file a module: an import, an export, or an exported
 * declaration. */
function isModuleSyntax(ts, statement) {
	return ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)
		|| ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)
		|| hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword);
}

/** Returns the local names that a module makes public without an `export` keyword on their declaration:
 * the names that `export { a, b as c }` lists and that `export default a` names, the names that a
 * top-level assignment such as `window.api = { a, b: c }` or an exported object such as
 * `export const Module = { a }` publishes, and the class of a published instance such as
 * `export const carousel = new Carousel()`. */
function exportedNames(ts, sourceFile) {
	const names = new Set();
	const addValue = expression => {
		const value = unwrap(ts, expression);
		if(ts.isIdentifier(value)) {
			names.add(value.text);
		} else if(ts.isNewExpression(value) && ts.isIdentifier(value.expression)) {
			names.add(value.expression.text);
		} else if(ts.isObjectLiteralExpression(value)) {
			for(const p of value.properties) {
				if(ts.isShorthandPropertyAssignment(p)) {
					names.add(p.name.text);
				} else if(ts.isPropertyAssignment(p)) {
					addValue(p.initializer);
				}
			}
		}
	};
	for(const statement of sourceFile.statements) {
		if(ts.isExportDeclaration(statement) && statement.moduleSpecifier == null
			&& statement.exportClause != null && ts.isNamedExports(statement.exportClause)) {
			for(const element of statement.exportClause.elements) {
				names.add((element.propertyName ?? element.name).text);
			}
		} else if(ts.isExportAssignment(statement)) {
			addValue(statement.expression);
		} else if(ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
			&& statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
			addValue(statement.expression.right);
		}
	}
	// A variable is exported either by its own `export` keyword or by a list such as `export { a }`, so
	// the values of exported variables are only read once every list has been seen.
	for(const statement of sourceFile.statements) {
		if(!ts.isVariableStatement(statement)) {
			continue;
		}
		const isExported = hasModifier(ts, statement, ts.SyntaxKind.ExportKeyword);
		for(const declaration of statement.declarationList.declarations) {
			const listed = ts.isIdentifier(declaration.name) && names.has(declaration.name.text);
			if(declaration.initializer != null && (isExported || listed)) {
				addValue(declaration.initializer);
			}
		}
	}
	return names;
}

/** Returns the `[from, to]` range of every comment in the file. Every comment is trivia in front of
 * some token, so asking each node and token for the comments before and after it finds them all. */
function collectComments(ts, sourceFile, src) {
	const byStart = new Map();
	const add = ranges => {
		for(const r of ranges ?? []) {
			byStart.set(r.pos, [r.pos, r.end]);
		}
	};
	const walk = node => {
		add(ts.getLeadingCommentRanges(src, node.pos));
		add(ts.getTrailingCommentRanges(src, node.end));
		for(const child of node.getChildren(sourceFile)) {
			// JSDoc nodes sit inside the comment they were parsed from, so they hold no other comments.
			if(child.kind < ts.SyntaxKind.FirstJSDocNode || child.kind > ts.SyntaxKind.LastJSDocNode) {
				walk(child);
			}
		}
	};
	walk(sourceFile);
	return [...byStart.values()];
}
