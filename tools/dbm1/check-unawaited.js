// tools/dbm1/check-unawaited.js — DB-M1 CP2 safety net: statement calls (.run/.all/.get
// on something that is, or may be, a prepared statement) that are not awaited.
const fs = require('fs'); const acorn = require('acorn'); const walk = require('acorn-walk');
let n = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8'); const ast = acorn.parse(src, { ecmaVersion: 2023, allowHashBang: true, allowReturnOutsideFunction: true });
  const stmtNames = new Set();
  walk.simple(ast, { VariableDeclarator(d) { if (d.id.type === 'Identifier' && d.init && /\.prepare\(|^set\(|Stmt|stmt/.test(src.slice(d.init.start, d.init.end).slice(0, 400))) stmtNames.add(d.id.name); } });
  walk.ancestor(ast, { CallExpression(node, _s, anc) {
    const c = node.callee; if (c.type !== 'MemberExpression' || c.computed) return;
    const prop = c.property.name; if (!['run', 'all', 'get'].includes(prop)) return;
    const objSrc = src.slice(c.object.start, c.object.end);
    const isStmt = /\.prepare\(/.test(objSrc) || (c.object.type === 'Identifier' && stmtNames.has(c.object.name));
    if (!isStmt) return;
    let p = anc[anc.length - 2]; if (p.type === 'AwaitExpression') return;
    if (p.type === 'ReturnStatement' || (p.type === 'ArrowFunctionExpression' && p.body === node)) return; // returned promise: caller awaits
    if (p.type === 'MemberExpression' && ['then', 'catch'].includes(p.property.name)) return;
    n += 1; console.log(`${f}:${src.slice(0, node.start).split('\n').length} ${src.slice(node.start, node.start + 70).replace(/\s+/g, ' ')}`);
  } });
}
console.log(`${n} un-awaited statement call(s)`);
