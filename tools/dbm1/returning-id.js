// tools/dbm1/returning-id.js — DB-M1 CP2. SQLite exposed the generated key as
// `.lastInsertRowid`; PostgreSQL returns it with `INSERT … RETURNING id`. For every
// `.lastInsertRowid` read, find the INSERT it belongs to and append ` RETURNING id`
// to that SQL text. Unresolvable sites are reported, never guessed.
const fs = require('fs'); const acorn = require('acorn'); const walk = require('acorn-walk');
let done = 0; const report = [];
for (const file of process.argv.slice(2)) {
  let src = fs.readFileSync(file, 'utf8'); if (!src.includes('lastInsertRowid')) continue;
  const ast = acorn.parse(src, { ecmaVersion: 2023, allowHashBang: true, allowReturnOutsideFunction: true });
  const parents = new Map(); walk.fullAncestor(ast, (n, _s, a) => parents.set(n, a[a.length - 2]));
  const unwrap = (n) => { while (n && (n.type === 'AwaitExpression' || n.type === 'ParenthesizedExpression')) n = n.argument || n.expression; return n; };
  const decls = []; walk.simple(ast, { VariableDeclarator(n) { decls.push(n); }, AssignmentExpression(n) { decls.push({ id: n.left, init: n.right, start: n.start }); } });
  const findInit = (name, before) => { const c = decls.filter((d) => d.id.type === 'Identifier' && d.id.name === name && d.start < before && d.init); return c.length ? unwrap(c[c.length - 1].init) : null; };
  const sqlArgOf = (runCall, at) => { // runCall: X.run(...)
    if (!runCall || runCall.type !== 'CallExpression' || runCall.callee.type !== 'MemberExpression' || runCall.callee.property.name !== 'run') return null;
    let o = unwrap(runCall.callee.object);
    if (o.type === 'Identifier') o = findInit(o.name, at);
    if (o && o.type === 'CallExpression' && o.callee.type === 'MemberExpression' && o.callee.property.name === 'prepare') return o.arguments[0];
    return null; };
  const targets = new Set();
  walk.simple(ast, { MemberExpression(n) {
    if (n.computed || n.property.name !== 'lastInsertRowid') return;
    let o = unwrap(n.object); let arg = null;
    if (o.type === 'CallExpression') arg = sqlArgOf(o, n.start);
    else if (o.type === 'Identifier') arg = sqlArgOf(findInit(o.name, n.start), n.start);
    const line = src.slice(0, n.start).split('\n').length;
    if (!arg || !['TemplateLiteral', 'Literal'].includes(arg.type)) { report.push(`${file}:${line} cannot resolve INSERT for lastInsertRowid — manual`); return; }
    targets.add(arg);
  } });
  const edits = [];
  for (const arg of targets) { const text = src.slice(arg.start, arg.end);
    if (/RETURNING\s+id/i.test(text)) continue;
    if (!/^\s*.\s*INSERT/i.test(text)) { report.push(`${file}: statement is not an INSERT: ${text.slice(0, 50)}`); continue; }
    const body = text.slice(0, -1); const trimmed = body.replace(/[\s;]+$/, '');
    edits.push([arg.start, arg.end, `${trimmed} RETURNING id${body.slice(trimmed.length).replace(/;/g, '')}${text.slice(-1)}`]); }
  edits.sort((a, b) => b[0] - a[0]); for (const [s, e, t] of edits) { src = src.slice(0, s) + t + src.slice(e); done += 1; }
  fs.writeFileSync(file, src);
}
console.log(`RETURNING id appended to ${done} INSERT statements`); for (const r of report) console.log('  ! ' + r);
