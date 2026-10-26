// Bundles src/ into dist/ so setup is two pastes: Code.gs and appsscript.json.
// src/Setup.html is built into Code.gs as the SETUP_HTML string.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const ORDER = ['Main.gs', 'Email.gs', 'Extract.gs', 'Music.gs', 'Poll.gs', 'Setup.gs'];

fs.mkdirSync(DIST, { recursive: true });
const header = '// Psalm Poll Script - generated from src/ by build.js. Edit the files in src/, not this one.\n';
const code = ORDER.map(f => `// ===== ${f} =====\n` + fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
const html = fs.readFileSync(path.join(SRC, 'Setup.html'), 'utf8');
const setupHtml = `// ===== Setup.html =====\nconst SETUP_HTML = ${JSON.stringify(html)};\n`;
fs.writeFileSync(path.join(DIST, 'Code.gs'), header + '\n' + code + '\n' + setupHtml);
fs.copyFileSync(path.join(SRC, 'appsscript.json'), path.join(DIST, 'appsscript.json'));
fs.rmSync(path.join(DIST, 'Setup.html'), { force: true }); // no longer pasted separately
console.log('Built dist/Code.gs and dist/appsscript.json');
