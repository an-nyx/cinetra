/* Reports likely hardcoded JSX copy and validates translation pairs. Review output alongside rendered states. */
const fs = require('fs');
const ts = require('typescript');
const path = require('path');
const phrases = require('../src/i18n/phrases.json');
let issues = 0;
for (const [key, translations] of Object.entries(phrases)) {
  if (!Array.isArray(translations) || translations.length !== 2 || translations.some(value => typeof value !== 'string' || !value.trim())) {
    console.log(`Missing translation: ${key}`); issues++;
  }
}
function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(file);
    else if (entry.name.endsWith('.tsx')) yield file;
  }
}
for (const file of sourceFiles('src')) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if (ts.isJsxText(node) && !(ts.isJsxElement(node.parent) && node.parent.openingElement.tagName.getText(tree) === "T")) {
      const text = node.getText(tree).trim();
      if (/[a-z]{2}/i.test(text) && !/^[\W\d]+$/.test(text)) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        console.log(`${file}:${line + 1}: ${text.replace(/\s+/g, ' ')}`); issues++;
      }
    }
    if (ts.isJsxAttribute(node) && ['aria-label', 'placeholder', 'title'].includes(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer) && /[a-z]{2}/i.test(node.initializer.text)) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree)); console.log(`${file}:${line + 1}: ${node.name.text}="${node.initializer.text}"`); issues++;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
console.log(`Potential issues: ${issues}. Dynamic expressions and rendered states also require review.`);
process.exitCode = issues ? 1 : 0;
