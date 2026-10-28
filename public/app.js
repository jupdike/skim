// The skim page lists the files of each would-be PR on the left and shows the selected file's header view
// on the right. Fold markers in the skeleton text become chips that expand the folded code in place.

const $ = id => document.getElementById(id);

const state = {
	groups: [],
	selected: null,
	skeleton: null,
	raw: false,
	prefs: loadPrefs(),
};

function loadPrefs() {
	const defaults = { hidePrivate: false, hideComments: false, newOnly: false, collapsed: [] };
	try {
		return { ...defaults, ...JSON.parse(localStorage.getItem('skim.prefs') ?? '{}') };
	} catch {
		return defaults;
	}
}

function savePrefs() {
	try {
		localStorage.setItem('skim.prefs', JSON.stringify(state.prefs));
	} catch {
		// The preferences only last for this page when storage is unavailable.
	}
}

function escapeHtml(text) {
	return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);
}

function highlight(text, language) {
	if(window.hljs?.getLanguage(language)) {
		return window.hljs.highlight(text, { language, ignoreIllegals: true }).value;
	}
	return escapeHtml(text);
}

/** Returns the language of a skimmable file: "razor", "csharp" or "typescript". */
function languageOf(path) {
	if(path.endsWith('.razor')) {
		return 'razor';
	}
	return path.endsWith('.cs') ? 'csharp' : 'typescript';
}

async function getJson(url) {
	const response = await fetch(url);
	const body = await response.json();
	if(!response.ok) {
		throw new Error(body.error ?? response.statusText);
	}
	return body;
}

// The sidebar.

async function loadGroups(refresh = false) {
	$('groups').innerHTML = '<div class="muted pad">Reading the branches…</div>';
	try {
		const data = await getJson(`/api/prs${refresh ? '?refresh=1' : ''}`);
		state.groups = data.groups;
	} catch(e) {
		$('groups').innerHTML = `<div class="warn pad">${escapeHtml(e.message)}</div>`;
		return;
	}
	renderGroups();
	const fromHash = decodeURIComponent(location.hash.replace(/^#f=/, ''));
	const files = allFiles();
	const initial = files.find(f => f.path === fromHash) ?? files.find(f => f.path === state.selected) ?? visibleFiles()[0];
	if(initial != null) {
		select(initial.path);
	}
}

function allFiles() {
	return state.groups.flatMap(g => g.files);
}

function fileMatches(file) {
	if(state.prefs.newOnly && file.status !== 'A' && file.status !== 'N') {
		return false;
	}
	const terms = $('filter').value.toLowerCase().split(/\s+/).filter(Boolean);
	const path = file.path.toLowerCase();
	return terms.every(t => path.includes(t));
}

/** Returns the files in the order they are shown, leaving out filtered files and collapsed groups. */
function visibleFiles() {
	return state.groups
		.filter(g => !state.prefs.collapsed.includes(g.repo))
		.flatMap(g => g.files.filter(fileMatches));
}

const STATUS_TITLES = {
	A: 'Added on the branch',
	M: 'Modified on the branch',
	R: 'Renamed on the branch',
	N: 'New and not committed yet',
	W: 'Changed in the working tree only, not on the branch',
};

function groupMeta(g) {
	const parts = [`${escapeHtml(g.branch)} → ${escapeHtml(g.base)}`, `${g.commits} commits`];
	if(g.pr != null) {
		parts.push(`<a href="${escapeHtml(g.pr.url)}" target="_blank" rel="noopener">PR #${g.pr.number}${g.pr.isDraft ? ' (draft)' : ''}</a>`);
	} else {
		parts.push('no PR yet');
	}
	if(g.behindBase > 0) {
		parts.push(`<span class="warn" title="Commits on ${escapeHtml(g.base)} that the branch does not have">${g.behindBase} behind ${escapeHtml(g.base)}</span>`);
	}
	if(g.upstream == null) {
		parts.push('<span class="warn">not pushed</span>');
	} else if(g.upstream.ahead > 0) {
		parts.push(`<span class="warn">${g.upstream.ahead} unpushed</span>`);
	}
	if(g.dirtyCount > 0) {
		parts.push(`<span class="warn" title="Files with uncommitted changes, which are not in the PR yet">${g.dirtyCount} uncommitted</span>`);
	}
	const notes = g.notes.map(n => `<div class="warn">${escapeHtml(n)}</div>`).join('');
	return parts.join(' · ') + notes;
}

function renderGroups() {
	const total = allFiles().length;
	$('summary').textContent = `${state.groups.length} PRs · ${total} files`;
	if(state.groups.length === 0) {
		$('groups').innerHTML = '<div class="muted pad">No repo has a branch with commits ahead of its base.</div>';
		return;
	}
	const html = [];
	for(const g of state.groups) {
		const collapsed = state.prefs.collapsed.includes(g.repo);
		const files = g.files.filter(fileMatches);
		html.push(`<div class="group-head" data-repo="${escapeHtml(g.repo)}">
			<div class="group-name"><span class="caret">${collapsed ? '▸' : '▾'}</span>${escapeHtml(g.repo)}
				<span class="muted">${files.length === g.files.length ? `${g.files.length} files` : `${files.length} of ${g.files.length} files`}</span></div>
			<div class="group-meta">${groupMeta(g)}</div>
		</div>`);
		if(collapsed) {
			continue;
		}
		let folder = null;
		for(const f of files) {
			const slash = f.repoPath.lastIndexOf('/');
			const dir = slash < 0 ? '' : f.repoPath.slice(0, slash);
			if(dir !== folder) {
				folder = dir;
				html.push(`<div class="folder">${escapeHtml(dir || '(repo root)')}</div>`);
			}
			const stats = f.add == null ? `${f.lines ?? '?'} lines` : f.status === 'A' ? `<span class="add">+${f.add}</span>` : `<span class="add">+${f.add}</span> <span class="del">−${f.del}</span>`;
			html.push(`<div class="file${f.path === state.selected ? ' selected' : ''}" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
				<span class="badge ${f.status}" title="${STATUS_TITLES[f.status] ?? ''}">${f.status}</span>
				<span class="name">${escapeHtml(f.repoPath.slice(slash + 1))}</span>
				${f.dirty && f.status !== 'N' && f.status !== 'W' ? '<span class="dirty-dot" title="Has uncommitted changes">●</span>' : ''}
				<span class="num">${stats}</span>
			</div>`);
		}
	}
	$('groups').innerHTML = html.join('');
}

$('groups').addEventListener('click', e => {
	const file = e.target.closest('.file');
	if(file != null) {
		select(file.dataset.path);
		return;
	}
	const head = e.target.closest('.group-head');
	if(head != null && e.target.tagName !== 'A') {
		const repo = head.dataset.repo;
		const collapsed = state.prefs.collapsed;
		state.prefs.collapsed = collapsed.includes(repo) ? collapsed.filter(r => r !== repo) : [...collapsed, repo];
		savePrefs();
		renderGroups();
	}
});

// The main pane.

async function select(path) {
	state.selected = path;
	history.replaceState(null, '', `#f=${encodeURIComponent(path)}`);
	for(const row of document.querySelectorAll('.file')) {
		row.classList.toggle('selected', row.dataset.path === path);
	}
	document.querySelector('.file.selected')?.scrollIntoView({ block: 'nearest' });
	const file = allFiles().find(f => f.path === path);
	$('empty').hidden = true;
	$('file-head').hidden = false;
	$('file-path').textContent = path;
	$('file-status').textContent = file?.status ?? '';
	$('file-status').className = `badge ${file?.status ?? ''}`;
	$('file-status').title = STATUS_TITLES[file?.status] ?? '';
	await renderFile();
}

async function renderFile() {
	const path = state.selected;
	if(path == null) {
		return;
	}
	const language = languageOf(path);
	const query = new URLSearchParams({
		path,
		hidePrivate: state.prefs.hidePrivate ? '1' : '0',
		hideComments: state.prefs.hideComments ? '1' : '0',
	});
	let data;
	try {
		data = await getJson(`/api/${state.raw ? 'raw' : 'skeleton'}?${query}`);
	} catch(e) {
		$('code').innerHTML = `<span class="warn">${escapeHtml(e.message)}</span>`;
		return;
	}
	if(path !== state.selected) {
		return;
	}
	const scroll = $('code-wrap');
	scroll.scrollTop = 0;
	if(state.raw) {
		state.skeleton = null;
		$('warnings').hidden = true;
		$('code').innerHTML = highlight(data.text, language === 'razor' ? 'xml' : language);
		$('file-stats').textContent = `${data.text.split('\n').length} lines`;
		return;
	}
	state.skeleton = data;
	$('warnings').hidden = data.warnings.length === 0;
	$('warnings').innerHTML = data.warnings.length === 0 ? '' : `The skeleton may be wrong here, so check it against <button class="link-button" id="warn-raw">the raw file</button>:<br>${data.warnings.map(escapeHtml).join('<br>')}`;
	const shown = data.text.split('\n').length;
	$('file-stats').textContent = `${shown} of ${data.totalLines} lines · ${data.folds.length} folds`;
	$('code').innerHTML = highlightSkeleton(data.text, language).replace(/([-]+)/g, (_, digits) => {
		const id = Number([...digits].map(c => c.charCodeAt(0) - 0xE010).join(''));
		return `<span class="fold" data-id="${id}">${chipHtml(data.folds[id])}</span>`;
	});
}

/** Highlights skeleton text in the file's language. highlight.js has no Razor grammar, so in a .razor
 * skeleton each `@* … *@` comment is cut out and shown as a comment, and the code between comments is
 * highlighted as C#. */
function highlightSkeleton(text, language) {
	if(language !== 'razor') {
		return highlight(text, language);
	}
	return text.split(/(@\*[\s\S]*?\*@)/).map((part, i) =>
		i % 2 === 1 ? `<span class="hljs-comment">${escapeHtml(part)}</span>` : highlight(part, 'csharp')).join('');
}

function chipHtml(fold) {
	const lines = `${fold.lines} line${fold.lines === 1 ? '' : 's'}`;
	const label = fold.kind === 'markup' ? `markup · ${lines}` : fold.kind === 'body' ? `… ${lines}` : fold.lines > 1 ? `… ${lines}` : '…';
	const range = fold.startLine === fold.endLine ? `line ${fold.startLine}` : `lines ${fold.startLine}–${fold.endLine}`;
	return `<button class="chip" title="Show ${range}">${label}</button>`;
}

function setFoldOpen(span, open) {
	const fold = state.skeleton?.folds[Number(span.dataset.id)];
	if(fold == null || span.classList.contains('open') === open) {
		return;
	}
	span.classList.toggle('open', open);
	if(open) {
		// A fold in a .razor file is markup or the C# of its @code block. Any other fold is in the
		// file's own language.
		const language = languageOf(state.selected ?? '');
		const body = highlight(fold.body, fold.kind === 'markup' ? 'xml' : language === 'razor' ? 'csharp' : language);
		span.innerHTML = `<button class="chip" title="Fold lines ${fold.startLine}–${fold.endLine}">▴</button>${body}`;
	} else {
		span.innerHTML = chipHtml(fold);
	}
}

$('code').addEventListener('click', e => {
	const chip = e.target.closest('.chip');
	if(chip == null) {
		return;
	}
	const span = chip.parentElement;
	setFoldOpen(span, !span.classList.contains('open'));
});

function setAllFolds(open) {
	// Opening a fold can reveal no new folds, since fold bodies are the original code, so one pass is enough.
	for(const span of document.querySelectorAll('#code .fold')) {
		setFoldOpen(span, open);
	}
}

$('expand-all').addEventListener('click', () => setAllFolds(true));
$('collapse-all').addEventListener('click', () => setAllFolds(false));

function toggleRaw() {
	state.raw = !state.raw;
	$('raw').setAttribute('aria-pressed', String(state.raw));
	renderFile();
}

$('raw').addEventListener('click', toggleRaw);
$('warnings').addEventListener('click', e => {
	if(e.target.id === 'warn-raw') {
		toggleRaw();
	}
});

$('copy-path').addEventListener('click', async () => {
	try {
		await navigator.clipboard.writeText(state.selected ?? '');
		$('copy-path').textContent = 'copied';
		setTimeout(() => $('copy-path').textContent = 'copy', 1200);
	} catch {
		$('copy-path').textContent = 'copy failed';
	}
});

for(const id of ['hidePrivate', 'hideComments']) {
	$(id).checked = state.prefs[id];
	$(id).addEventListener('change', () => {
		state.prefs[id] = $(id).checked;
		savePrefs();
		renderFile();
	});
}

$('newOnly').checked = state.prefs.newOnly;
$('newOnly').addEventListener('change', () => {
	state.prefs.newOnly = $('newOnly').checked;
	savePrefs();
	renderGroups();
});

$('filter').addEventListener('input', renderGroups);
$('refresh').addEventListener('click', () => loadGroups(true));

function step(delta) {
	const files = visibleFiles();
	if(files.length === 0) {
		return;
	}
	const index = files.findIndex(f => f.path === state.selected);
	const next = index < 0 ? 0 : Math.max(0, Math.min(files.length - 1, index + delta));
	select(files[next].path);
}

document.addEventListener('keydown', e => {
	if(e.metaKey || e.ctrlKey || e.altKey) {
		return;
	}
	if(e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
		if(e.key === 'Escape') {
			e.target.blur();
		} else if(e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
			e.preventDefault();
			step(e.key === 'ArrowUp' ? -1 : 1);
		}
		return;
	}
	if(e.key === 'j') {
		e.preventDefault();
		step(1);
	} else if(e.key === 'k') {
		e.preventDefault();
		step(-1);
	} else if(e.key === '/') {
		e.preventDefault();
		$('filter').focus();
	} else if(e.key === 'e') {
		const anyClosed = document.querySelector('#code .fold:not(.open)') != null;
		setAllFolds(anyClosed);
	} else if(e.key === 'r') {
		toggleRaw();
	}
});

loadGroups();
