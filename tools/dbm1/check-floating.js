// tools/dbm1/check-floating.js — DB-M1 CP2 safety net: finds async work that is
// started but not awaited (async IIFEs, async callbacks handed to array methods).
const fs = require('fs'); const acorn = require('acorn'); const walk = require('acorn-walk');
const ARR = new Set(['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'reduce', 'sort', 'flatMap']);
let n = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, 'utf8'); const ast = acorn.parse(src, { ecmaVersion: 2023, allowHashBang: true, allowReturnOutsideFunction: true });
  walk.ancestor(ast, { CallExpression(node, _s, anc) {
    const parent = anc[anc.length - 2]; const line = src.slice(0, node.start).split('\n').length;
    const c = node.callee;
    if (/Function/.test(c.type) && c.async && parent.type !== 'AwaitExpression' && !(parent.type === 'MemberExpression' && anc.length <= 4)) { n += 1; console.log(`${f}:${line} async IIFE not awaited`); }
    if (c.type === 'MemberExpression' && ARR.has(c.property.name) && node.arguments.some((a) => /Function/.test(a.type) && a.async)) {
      const wrapped = parent.type === 'CallExpression' && /Promise\.all/.test(src.slice(parent.callee.start, parent.callee.end));
      if (!wrapped) { n += 1; console.log(`${f}:${line} async callback in .${c.property.name}()`); }
    }
  } });
}
console.log(`${n} floating async site(s)`);
