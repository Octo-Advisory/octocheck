'use strict';
// A small JSON-schema checker, so the runner can validate what the connector sends without
// installing any package. It mirrors octocheck_connector/schema_check.py (decision 7: the
// schema is checked by both sides) and supports only what bundle_schema_v1.json uses:
// type (single or list), const, enum, required, properties, additionalProperties (false or a
// schema), items, pattern and local $ref ("#/$defs/name").
//
// bundle_schema_v1.json next to this file is a copy of the connector's
// octocheck_connector/schemas/bundle_schema_v1.json. The connector is the source of truth.

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'bundle_schema_v1.json');

const TYPES = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function loadSchema(file = SCHEMA_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validate(instance, node, root, at = '$') {
  let errors = [];
  if (node.$ref) {
    let target = root;
    for (const part of node.$ref.replace(/^#\//, '').split('/')) target = target[part];
    return validate(instance, target, root, at);
  }
  if ('const' in node && !same(instance, node.const)) {
    errors.push(`${at}: expected ${JSON.stringify(node.const)}, got ${JSON.stringify(instance)}`);
  }
  if (node.enum && !node.enum.some((e) => same(e, instance))) {
    errors.push(`${at}: ${JSON.stringify(instance)} is not one of ${JSON.stringify(node.enum)}`);
  }
  if (node.type) {
    const allowed = Array.isArray(node.type) ? node.type : [node.type];
    if (!allowed.some((t) => TYPES[t](instance))) {
      errors.push(`${at}: expected ${allowed.join('/')}, got ${typeName(instance)}`);
      return errors; // deeper checks would only add noise
    }
  }
  if (node.pattern && typeof instance === 'string' && !new RegExp(node.pattern).test(instance)) {
    errors.push(`${at}: ${JSON.stringify(instance)} does not match ${node.pattern}`);
  }
  if (TYPES.object(instance)) {
    for (const key of node.required || []) {
      if (!(key in instance)) errors.push(`${at}: missing required key '${key}'`);
    }
    const props = node.properties || {};
    const extra = 'additionalProperties' in node ? node.additionalProperties : true;
    for (const [key, value] of Object.entries(instance)) {
      if (key in props) errors = errors.concat(validate(value, props[key], root, `${at}.${key}`));
      else if (extra === false) errors.push(`${at}: unexpected key '${key}'`);
      else if (TYPES.object(extra)) errors = errors.concat(validate(value, extra, root, `${at}.${key}`));
    }
  }
  if (Array.isArray(instance) && node.items) {
    instance.forEach((item, i) => { errors = errors.concat(validate(item, node.items, root, `${at}[${i}]`)); });
  }
  return errors;
}

/** Validate against a named definition ('info', 'manifest', 'review_bundle', ...).
 *  Returns a list of error strings; an empty list means valid. */
function validateNamed(instance, name, schema = loadSchema()) {
  if (!schema.$defs || !schema.$defs[name]) throw new Error(`The schema has no definition named "${name}".`);
  return validate(instance, schema.$defs[name], schema);
}

module.exports = { validate, validateNamed, loadSchema, SCHEMA_PATH };
