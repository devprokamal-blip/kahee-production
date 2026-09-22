// tools/dbm1/async-codemod.js — DB-M1 CP2. Mechanical sync->async conversion.
// Whole-program: marks every function that (transitively) issues SQL as `async`
// and prefixes every such call with `await`. It changes NOTHING else: no
// identifier, literal, operator, branch or number is touched. Anything it cannot
// convert safely is REPORTED for manual review instead of guessed.
//   node tools/dbm1/async-codemod.js [--write] file...
const fs = require('fs'); const path = require('path');
const acorn = require('acorn'); const walk = require('acorn-walk');
const WRITE = process.argv.includes('--write');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((f) => path.resolve(f));
const ARRAY_CB = new Set(['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'reduce', 'sort', 'flatMap']);
const ALWAYS_ASYNC = new Set(['withTransaction', 'withRetry', 'initDb', 'createTestDatabase', 'migrate', 'assertSchemaCurrent', 'closeDb']);
const isFn = (n) => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

const mods = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 2023, sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  const m = { file, src, ast, fns: new Map(), stmts: new Set(), reqMod: new Map(), reqNamed: new Map(), exports: new Map(), parents: new Map(), calls: [] };
  walk.fullAncestor(ast, (node, _s, anc) => { m.parents.set(node, anc[anc.length - 2]); });
  const resolveReq = (arg) => { if (!arg || arg.type !== 'Literal' || !/^\./.test(arg.value)) return null;
    let p = path.resolve(path.dirname(file), arg.value); if (!p.endsWith('.js')) p += '.js'; return p; };
  walk.simple(ast, {
    FunctionDeclaration(n) { if (n.id) m.fns.set(n.id.name, n); },
    VariableDeclarator(n) {
      if (n.id.type === 'Identifier' && isFn(n.init)) m.fns.set(n.id.name, n.init);
      let init = n.init; if (init && init.type === 'AwaitExpression') init = init.argument;
      if (n.id.type === 'Identifier' && init && init.type === 'CallExpression' && init.callee.type === 'MemberExpression' && init.callee.property.name === 'prepare') m.stmts.add(n.id.name);
      if (init && init.type === 'CallExpression' && init.callee.name === 'require') {
        const p = resolveReq(init.arguments[0]); if (!p) return;
        if (n.id.type === 'Identifier') m.reqMod.set(n.id.name, p);
        if (n.id.type === 'ObjectPattern') for (const pr of n.id.properties) if (pr.value && pr.value.type === 'Identifier') m.reqNamed.set(pr.value.name, [p, pr.key.name]);
      }
    },
    Property(n) { if (isFn(n.value) && n.key.type === 'Identifier') m.fns.set(`.${n.key.name}`, n.value); },
    AssignmentExpression(n) {
      const l = n.left; const src1 = src.slice(l.start, l.end);
      if (src1 === 'module.exports' && n.right.type === 'ObjectExpression') {
        for (const pr of n.right.properties) { if (pr.type !== 'Property') continue;
          if (pr.value.type === 'Identifier') m.exports.set(pr.key.name, pr.value.name); else if (isFn(pr.value)) m.exports.set(pr.key.name, `.${pr.key.name}`); }
      } else if (/^(module\.)?exports\.\w+$/.test(src1)) {
        const name = l.property.name; if (n.right.type === 'Identifier') m.exports.set(name, n.right.name); else if (isFn(n.right)) { m.fns.set(`=${name}`, n.right); m.exports.set(name, `=${name}`); }
      } else if (l.type === 'Identifier' && n.right.type === 'CallExpression' && n.right.callee.type === 'MemberExpression' && n.right.callee.property.name === 'prepare') m.stmts.add(l.name);
    },
  });
  mods.set(file, m);
}
const asyncFns = new Set(); const awaitCalls = new Set(); const asyncParams = new Map(); const report = [];
const enclosingFn = (m, node) => { let p = m.parents.get(node); while (p && !isFn(p)) p = m.parents.get(p); return p || null; };
function targetOf(m, call) {
  const c = call.callee;
  const look = (mm, name) => (mm && mm.fns.get(name)) || null;
  if (c.type === 'Identifier') {
    if (m.reqNamed.has(c.name)) { const [p, n] = m.reqNamed.get(c.name); const mm = mods.get(p); return mm ? look(mm, mm.exports.get(n) || n) : null; }
    return look(m, c.name);
  }
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && !c.computed) {
    let p = null;
    if (c.object.type === 'Identifier' && m.reqMod.has(c.object.name)) p = m.reqMod.get(c.object.name);
    if (c.object.type === 'CallExpression' && c.object.callee.name === 'require' && c.object.arguments[0] && /^\./.test(c.object.arguments[0].value || '')) {
      p = path.resolve(path.dirname(m.file), c.object.arguments[0].value); if (!p.endsWith('.js')) p += '.js'; }
    if (p) { const mm = mods.get(p); return mm ? look(mm, mm.exports.get(c.property.name) || c.property.name) : null; }
  }
  return null;
}
function isSink(m, call) {
  const c = call.callee;
  if (c.type === 'Identifier') { if (ALWAYS_ASYNC.has(c.name)) return true;
    // a callback parameter of ANY enclosing function (wrappers return an inner closure that invokes it)
    for (let fn = enclosingFn(m, call); fn; fn = enclosingFn(m, fn)) { const ps = asyncParams.get(fn); if (ps && ps.has(c.name)) return true; } }
  if (c.type !== 'MemberExpression' || c.computed) return false;
  const prop = c.property.name; const o = c.object;
  if (['get', 'all', 'run'].includes(prop)) {
    if (o.type === 'CallExpression' && o.callee.type === 'MemberExpression' && o.callee.property.name === 'prepare') return true;
    if (o.type === 'Identifier' && m.stmts.has(o.name)) return true;
  }
  if (ALWAYS_ASYNC.has(prop)) return true;
  if (['exec', 'query'].includes(prop) && /(^|\.)(\w*[dD]b|owner|lite)$/.test(m.src.slice(o.start, o.end)) && !/lite$/.test(m.src.slice(o.start, o.end))) return true;
  if (prop === 'drop' && o.type === 'Identifier' && /^(t|fresh|testDb)$/.test(o.name)) return true;
  return false;
}
for (const m of mods.values()) walk.simple(m.ast, { CallExpression(n) { m.calls.push(n); } });
let changed = true;
while (changed) {
  changed = false;
  for (const m of mods.values()) for (const call of m.calls) {
    const tgt = targetOf(m, call);
    if (!awaitCalls.has(call) && (isSink(m, call) || (tgt && asyncFns.has(tgt)))) {
      awaitCalls.add(call); changed = true;
      const fn = enclosingFn(m, call); if (fn && !asyncFns.has(fn)) asyncFns.add(fn);
    }
    // a known function that invokes a parameter which some caller passes an async function for
    if (tgt) call.arguments.forEach((a, i) => {
      const passed = isFn(a) ? a : (a.type === 'Identifier' ? m.fns.get(a.name) : null);
      if (passed && asyncFns.has(passed) && tgt.params[i] && tgt.params[i].type === 'Identifier') {
        const set = asyncParams.get(tgt) || new Set(); if (!set.has(tgt.params[i].name)) { set.add(tgt.params[i].name); asyncParams.set(tgt, set); changed = true; }
      }
    });
  }
}
// ---- emit -------------------------------------------------------------------
let totalAwait = 0; let totalAsync = 0;
for (const m of mods.values()) {
  const edits = []; let topLevel = false;
  for (const call of m.calls) { if (!awaitCalls.has(call)) continue;
    const parent = m.parents.get(call);
    if (parent && parent.type === 'AwaitExpression') continue;
    if (!enclosingFn(m, call)) topLevel = true;
    const needParens = parent && ((parent.type === 'MemberExpression' && parent.object === call) || (parent.type === 'CallExpression' && parent.callee === call) || parent.type === 'ChainExpression');
    edits.push([call.start, needParens ? '(await ' : 'await ']); if (needParens) edits.push([call.end, ')']); totalAwait += 1;
  }
  const local = new Set([...asyncFns].filter((f) => m.parents.has(f) || f === m.ast));
  for (const fn of asyncFns) { if (!m.parents.has(fn)) continue; if (fn.async) continue;
    const parent = m.parents.get(fn); let at = fn.start;
    if (parent && parent.type === 'Property' && parent.method) at = parent.key.start;
    if (parent && parent.type === 'MethodDefinition') { if (parent.kind !== 'method') { report.push(`${m.file}:${fn.start} ${parent.kind} needs DB access — manual`); continue; } at = parent.key.start; }
    edits.push([at, 'async ']); totalAsync += 1;
    if (parent && parent.type === 'CallExpression' && parent.arguments.includes(fn) && parent.callee.type === 'MemberExpression' && ARRAY_CB.has(parent.callee.property.name) && !m.reqMod.has(parent.callee.object.name)) {
      const line = m.src.slice(0, fn.start).split('\n').length; report.push(`${path.relative(process.cwd(), m.file)}:${line} async callback passed to .${parent.callee.property.name}() — manual`);
    }
  }
  void local;
  if (!edits.length) continue;
  if (process.argv.includes('--per-file')) console.log(`  ${edits.length}\t${path.relative(process.cwd(), m.file)}`);
  edits.sort((a, b) => b[0] - a[0] || (a[1] === ')' ? 1 : -1));
  let out = m.src; for (const [pos, text] of edits) out = out.slice(0, pos) + text + out.slice(pos);
  if (topLevel) { report.push(`${path.relative(process.cwd(), m.file)} has top-level SQL — wrapped in an async main`);
    const sheb = out.startsWith('#!') ? out.slice(0, out.indexOf('\n') + 1) : ''; out = out.slice(sheb.length);
    out = `${sheb}(async () => {\n${out}\n})().catch((err) => { console.error(err); process.exit(1); });\n`; }
  try { acorn.parse(out, { ecmaVersion: 2023, sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true }); } catch (e) { report.push(`${m.file}: OUTPUT DOES NOT PARSE: ${e.message}`); continue; }
  if (WRITE) fs.writeFileSync(m.file, out);
}
console.log(`await inserted: ${totalAwait}, functions made async: ${totalAsync}, files: ${mods.size}`);
for (const r of report) console.log('  ! ' + r);
