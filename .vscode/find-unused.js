const fs = require('fs');
const path = require('path');

// Exempt only from "never referenced" warnings (dendrynexus needs them).
// Their tags and inline scenes are still checked.
const EXEMPT_IF_UNREFERENCED = new Set(['status', 'root']);

// Dendry's built-in navigation scenes. They have no file, so they are never
// "defined", and they are legitimately used just once (or not at all).
//   prevScene        - always goes to the previous scene
//   jumpScene        - goes to the scene set by the last set-jump
//   backSpecialScene - goes to the scene visited before the last special scene
const BUILTIN_SCENES = new Set(['prevScene', 'jumpScene', 'backSpecialScene']);

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const files = walk('source').filter(f => f.endsWith('.dry'));
const text = Object.fromEntries(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Scene/tag mentions: the name must not be part of a longer word or dotted path
const token = (name, prefix = '') =>
    new RegExp(`${prefix}(?<![\\w-]|\\w\\.)${escapeRe(name)}(?![\\w-]|\\.\\w)`, 'g');

// Quality mentions: Q.name, {! name !}, or a bare name (e.g. in conditions),
// but not "something.name" for other prefixes
const qualityToken = name =>
    new RegExp(`(?:\\bQ\\.|(?<![\\w-]|\\w\\.))${escapeRe(name)}(?![\\w-])`, 'g');

// Print a diagnostic underlining [index, index + length) of a file
const report = (file, index, length, severity, message) => {
    const src = text[file];
    const lineStart = index === 0 ? -1 : src.lastIndexOf('\n', index - 1);
    const col = index - lineStart; // 1-based
    console.log(`${file}:${lineOf(src, index)}:${col}-${col + length}: ${severity}: ${message}`);
};

// Tags declared by "tags: a, b c", with their absolute positions in the file
const getTags = (body, bodyOffset) => {
    const m = body.match(/^tags[ \t]*:[ \t]*(.+)$/m);
    if (!m) return [];
    const base = bodyOffset + m.index + m[0].length - m[1].length;
    return [...m[1].matchAll(/[^\s,]+/g)].map(t => ({ name: t[0], index: base + t.index }));
};

// Split every file into sections: the file's own scene plus one per "@name" header
const HEADER = /^@([\w-]+)[ \t]*$/gm;
const sections = [];
for (const f of files) {
    const src = text[f];
    const isScene = f.endsWith('.scene.dry');
    const parent = isScene ? path.basename(f, '.scene.dry') : null;
    const firstLineLen = Math.max(1, src.split(/\r?\n/)[0].length);

    const bounds = [{ start: 0, end: 0, name: null }];
    for (const m of src.matchAll(HEADER)) {
        bounds.push({ start: m.index, end: m.index + m[0].length, name: m[1] });
    }
    bounds.forEach((b, i) => {
        const next = bounds[i + 1];
        const body = src.slice(b.end, next ? next.start : src.length);
        sections.push({
            file: f,
            body,
            id: !isScene ? null : b.name ? `${parent}.${b.name}` : parent,
            short: b.name || parent,
            tags: isScene ? getTags(body, b.end) : [],
            markStart: b.name ? b.start : 0,
            markLen: b.name ? 1 + b.name.length : firstLineLen,
        });
    });
}

const mentionsIn = (re, except) =>
    sections.filter(s => s !== except).reduce((n, s) => n + (s.body.match(re) || []).length, 0);

// Scenes (file-level and inline) that nothing refers to
for (const s of sections.filter(s => s.id)) {
    const tagReferenced = t => mentionsIn(token(t.name, '#'), s) > 0;

    if (EXEMPT_IF_UNREFERENCED.has(s.id)) {
        for (const t of s.tags.filter(t => !tagReferenced(t))) {
            report(s.file, t.index, t.name.length, 'warning',
                `Tag "${t.name}" on "${s.id}" is never referenced`);
        }
        continue;
    }

    const names = [...new Set([s.short, s.id])];
    if (names.some(n => mentionsIn(token(n), s) > 0)) continue;
    if (s.tags.some(tagReferenced)) continue;

    report(s.file, s.markStart, s.markLen, 'warning',
        `Scene "${s.id}" is never referenced` +
        (s.tags.length ? ` (tags: ${s.tags.map(t => t.name).join(', ')} are not referenced either)` : ''));
}

// Qualities mentioned only once in the whole project
const countAll = re => files.reduce((n, f) => n + (text[f].match(re) || []).length, 0);
const first = {};
for (const f of files) {
    for (const m of text[f].matchAll(/\bQ\.(\w+)|\{!\s*(\w+)\s*!\}/g)) {
        const n = m[1] || m[2];
        if (!first[n]) first[n] = { f, index: m.index + m[0].lastIndexOf(n) };
    }
}
for (const [n, loc] of Object.entries(first)) {
    if (BUILTIN_SCENES.has(n)) continue;
    if (countAll(qualityToken(n)) <= 1) {
        report(loc.f, loc.index, n.length, 'warning', `"${n}" is only mentioned once`);
    }
}

// Every scene that exists: file-level IDs, inline IDs, and inline short names
const known = new Set();
for (const s of sections) {
    if (s.id) { known.add(s.id); known.add(s.short); }
}

// Choices ("- @scene: button text") pointing at scenes that don't exist
const CHOICE = /^[ \t]*[-*+][ \t]*@([\w.-]+)/gm;
for (const f of files) {
    for (const m of text[f].matchAll(CHOICE)) {
        const name = m[1];
        if (known.has(name) || BUILTIN_SCENES.has(name)) continue;
        const index = m.index + m[0].length - name.length - 1; // underline "@name"
        report(f, index, name.length + 1, 'warning',
            `Choice points to scene "${name}", which doesn't exist`);
    }
}