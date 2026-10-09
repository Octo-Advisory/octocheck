'use strict';
// Tiny test runner with no dependencies. Each *.test.cjs exports [[name, asyncFn], ...].
const fs = require('fs');
const path = require('path');

(async () => {
  let passed = 0;
  const failed = [];
  for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.cjs')).sort()) {
    for (const [name, fn] of require(path.join(__dirname, file))) {
      try {
        await fn();
        passed += 1;
        console.log(`  ok    ${file}: ${name}`);
      } catch (e) {
        failed.push(`${file}: ${name}`);
        console.log(`  FAIL  ${file}: ${name}\n        ${String(e && e.stack ? e.stack : e).split('\n').slice(0, 4).join('\n        ')}`);
      }
    }
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
