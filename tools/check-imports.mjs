// Проверка соответствия импортов и экспортов между ES-модулями.
// Запуск: node tools/check-imports.mjs <корень js>
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const root = resolve(process.argv[2] || 'js');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(root);

const exportsOf = new Map();
const importsOf = new Map();
const problems = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const names = new Set();

  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default/m.test(src)) names.add('default');
  exportsOf.set(file, names);

  const list = [];
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const clause = m[1];
    const spec = m[2];
    const target = resolve(dirname(file), spec);
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) list.push({ name, target });
      }
    }
    const def = clause.match(/^([A-Za-z0-9_$]+)\s*(?:,|$)/);
    if (def && !clause.trim().startsWith('{')) list.push({ name: 'default', target });
  }
  importsOf.set(file, list);
}

for (const [file, list] of importsOf) {
  for (const { name, target } of list) {
    const available = exportsOf.get(target);
    if (!available) {
      problems.push(`${relative(root, file)} → ${relative(root, target)}: файл не найден`);
    } else if (!available.has(name)) {
      problems.push(`${relative(root, file)} → ${relative(root, target)}: нет экспорта "${name}"`);
    }
  }
}

if (problems.length) {
  console.log('Проблемы импортов:');
  for (const p of problems) console.log(' • ' + p);
  process.exit(1);
}
console.log(`OK: ${files.length} файлов, все импорты разрешаются`);