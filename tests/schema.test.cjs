'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateNamed, loadSchema } = require('../.claude/scripts/octocheck-schema.cjs');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `real-${name}.json`), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

module.exports = [
  ['what the connector\'s own Python code produced is valid', async () => {
    assert.deepStrictEqual(validateNamed(fixture('manifest'), 'manifest'), []);
    assert.deepStrictEqual(validateNamed(fixture('bundle'), 'review_bundle'), []);
    assert.deepStrictEqual(validateNamed(fixture('info'), 'info'), []);
  }],

  ['a missing, extra or wrongly typed key is caught, with the path to it', async () => {
    let m = clone(fixture('manifest'));
    delete m.scripts[0].hash;
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes("$.scripts[0]: missing required key 'hash'")));

    m = clone(fixture('manifest'));
    m.scripts[1].surprise = 1;
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes("unexpected key 'surprise'")));

    m = clone(fixture('manifest'));
    m.scripts[0].enabled = 'yes';
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes('$.scripts[0].enabled: expected boolean')));

    m = clone(fixture('manifest'));
    m.count = 1.5;
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes('$.count: expected integer')));
  }],

  ['patterns, enums, constants and null handling', async () => {
    let m = clone(fixture('manifest'));
    m.scripts[0].hash = 'sha256:nothex';
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes('does not match')));

    m = clone(fixture('manifest'));
    m.scripts[0].doctype = 'User';
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes('is not one of')));

    m = clone(fixture('manifest'));
    m.bundle_version = 2;
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes('expected 1, got 2')));

    m = clone(fixture('manifest'));
    m.scripts[0].name = null; // name must be a string; module may be null
    assert.ok(validateNamed(m, 'manifest').some((e) => e.includes('$.scripts[0].name: expected string, got null')));
    m = clone(fixture('manifest'));
    m.scripts[0].module = null;
    assert.deepStrictEqual(validateNamed(m, 'manifest'), []);
  }],

  ['nested definitions are followed (bundle -> script -> link)', async () => {
    const b = clone(fixture('bundle'));
    b.scripts[0].links = [{ doctype: 'Server Script', name: 'x', enabled: true, kind: 'invented', direction: 'both', reason: 'r' }];
    assert.ok(validateNamed(b, 'review_bundle').some((e) => e.includes('$.scripts[0].links[0].kind')));
    const c = clone(fixture('bundle'));
    c.doctypes.ToDo.fields = 'not a list';
    assert.ok(validateNamed(c, 'review_bundle').some((e) => e.includes('$.doctypes.ToDo.fields: expected array')));
  }],

  ['a wrong shape stops at the type error instead of piling up noise', async () => {
    assert.strictEqual(validateNamed('hello', 'manifest').length, 1);
    assert.strictEqual(validateNamed(null, 'review_bundle').length, 1);
    assert.strictEqual(validateNamed([], 'manifest').length, 1);
  }],

  ['an unknown definition name is a programming error, not a pass', async () => {
    assert.throws(() => validateNamed({}, 'nonsense'), /no definition named/);
  }],

  ['the schema copy in the runner declares the bundle version this runner understands', async () => {
    const schema = loadSchema();
    assert.strictEqual(schema.bundle_version, 1);
    for (const name of ['info', 'manifest', 'review_bundle', 'script_entry', 'link']) assert.ok(schema.$defs[name], name);
  }],
];
