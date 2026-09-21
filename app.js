const $ = (id) => document.getElementById(id);

let currentParsed = null;
let currentFileBase = 'extension';

function setStatus(msg, isError) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function handleFile(file) {
  $('fname').textContent = file.name;
  currentFileBase = (file.name || 'extension').replace(/\.vsix$/i, '');
  setStatus('Reading and parsing…');
  ['identityCard', 'contributesCard', 'filesCard', 'warningsCard'].forEach((id) => { $(id).style.display = 'none'; });
  currentParsed = null;
  try {
    const buf = await file.arrayBuffer();
    const parsed = VsixParser.parseVsixBuffer(buf);
    currentParsed = parsed;
    render(parsed);
    setStatus(`Parsed ${parsed.entries.length} file(s) inside this package.`);
  } catch (err) {
    setStatus((err && err.message) || String(err), true);
  }
}

function render(parsed) {
  renderIdentity(parsed);
  renderContributes(parsed);
  renderFiles(parsed);
  if (parsed.warnings.length) {
    $('warningsCard').style.display = '';
    $('warningsList').innerHTML = parsed.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  }
}

function renderIdentity(parsed) {
  const m = parsed.manifest;
  $('identityCard').style.display = '';
  const iconHtml = parsed.icon ? `<img src="${parsed.icon.dataUri}" alt="" class="icon-preview">` : '';
  const idLine = m.identity ? `${escapeHtml(m.identity.id)} v${escapeHtml(m.identity.version)}` : '(no Identity element)';
  const publisher = m.identity && m.identity.publisher ? escapeHtml(m.identity.publisher) : '(unknown)';
  const targets = m.installationTargets.map((t) => escapeHtml(t.id)).join(', ') || '(none listed)';
  const engineProp = m.properties.find((p) => p.id === 'Microsoft.VisualStudio.Code.Engine');
  const pkg = parsed.packageJson;

  $('identityBody').innerHTML = `
    <div class="identity-row">
      ${iconHtml}
      <div>
        <div class="identity-name">${escapeHtml(m.displayName || (pkg && pkg.displayName) || '(untitled)')}</div>
        <div class="identity-sub">${idLine} &middot; publisher: ${publisher}</div>
      </div>
    </div>
    ${m.description ? `<p class="desc">${escapeHtml(m.description)}</p>` : ''}
    <table class="kv">
      <tr><td>Installs into</td><td>${targets}</td></tr>
      ${engineProp ? `<tr><td>Requires VS Code</td><td>${escapeHtml(engineProp.value)}</td></tr>` : ''}
      ${m.categories.length ? `<tr><td>Categories</td><td>${m.categories.map(escapeHtml).join(', ')}</td></tr>` : ''}
      ${m.tags.length ? `<tr><td>Tags</td><td>${m.tags.map(escapeHtml).join(', ')}</td></tr>` : ''}
      ${pkg && pkg.activationEvents ? `<tr><td>Activation events</td><td>${pkg.activationEvents.slice(0, 12).map(escapeHtml).join('<br>')}${pkg.activationEvents.length > 12 ? `<br>&hellip; ${pkg.activationEvents.length - 12} more` : ''}</td></tr>` : ''}
    </table>
  `;
}

const CONTRIBUTE_LABELS = {
  commands: 'Commands',
  configuration: 'Settings',
  keybindings: 'Keybindings',
  languages: 'Languages',
  grammars: 'Syntax grammars',
  themes: 'Color themes',
  iconThemes: 'Icon themes',
  productIconThemes: 'Product icon themes',
  snippets: 'Snippets',
  views: 'Views',
  viewsContainers: 'View containers',
  menus: 'Menu entries',
  debuggers: 'Debuggers',
  breakpoints: 'Breakpoint types',
  taskDefinitions: 'Task types',
  walkthroughs: 'Walkthroughs',
  customEditors: 'Custom editors',
  jsonValidation: 'JSON schema validations',
  colors: 'Theme colors',
  semanticTokenTypes: 'Semantic token types',
  semanticTokenScopes: 'Semantic token scopes',
};

function renderContributes(parsed) {
  if (!parsed.contributesSummary.length) return;
  $('contributesCard').style.display = '';
  $('contributesBody').innerHTML = parsed.contributesSummary
    .map((row) => `<tr><td>${escapeHtml(CONTRIBUTE_LABELS[row.key] || row.key)}</td><td>${row.count}</td></tr>`)
    .join('');
}

function renderFiles(parsed) {
  $('filesCard').style.display = '';
  $('fileCount').textContent = `${parsed.entries.length} file(s), ${VsixParser.formatBytes(parsed.totalUncompressedBytes)} uncompressed`;
  $('filesBody').innerHTML = parsed.entries
    .map((e) => `<tr><td>${escapeHtml(e.path)}</td><td class="size-cell">${VsixParser.formatBytes(e.size)}</td></tr>`)
    .join('');
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvEscape(s) {
  const str = s == null ? '' : String(s);
  if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function exportJson() {
  if (!currentParsed) return;
  download(`${currentFileBase}-files.json`, JSON.stringify(VsixParser.toRows(currentParsed), null, 2), 'application/json');
}

function exportCsv() {
  if (!currentParsed) return;
  const rows = VsixParser.toRows(currentParsed);
  const lines = ['path,size', ...rows.map((r) => [r.path, r.size].map(csvEscape).join(','))];
  download(`${currentFileBase}-files.csv`, lines.join('\r\n') + '\r\n', 'text/csv');
}

function bindDrop() {
  const dz = $('dropzone');
  const input = $('fileInput');
  const setDrag = (on) => dz.classList.toggle('drag', on);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(true); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); setDrag(false); }));
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) handleFile(input.files[0]);
    input.value = '';
  });
}

bindDrop();
$('exportJsonBtn').addEventListener('click', exportJson);
$('exportCsvBtn').addEventListener('click', exportCsv);
