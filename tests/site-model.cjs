'use strict';
// A tiny model of a Frappe site's UI scripts that answers like the connector does, so fetch can
// be tested against many shapes of site. Everything it produces must pass bundle_schema_v1.json;
// fetch validates it, so a mistake here shows up as a failing test, not a silent pass.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const keyOf = (doctype, name) => `${doctype}/${name}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

class SiteModel {
  constructor() {
    this.scripts = new Map();
    this.links = [];
    this.hidden = new Set(); // in the manifest but missing from bundles (removed or unreadable meanwhile)
    this.bundleHash = new Map(); // name -> a newer hash the bundle reports (edited during the fetch)
    this.version = 0;
  }

  add(name, opts = {}) {
    const doctype = opts.doctype || 'Server Script';
    const script = {
      name, doctype, type: opts.type || (doctype === 'Client Script' ? null : 'DocType Event'),
      dt: opts.dt === undefined ? 'ToDo' : opts.dt, event: opts.event || 'Before Save', api: opts.api || null,
      enabled: opts.enabled !== false, text: opts.text || 'pass\n',
    };
    script.hash = sha(`${name}\u0000${script.text}\u0000${script.enabled}`);
    this.scripts.set(keyOf(doctype, name), script);
    return this;
  }

  find(name) {
    const found = [...this.scripts.values()].filter((s) => s.name === name);
    if (found.length !== 1) throw new Error(`test model: expected exactly one script named ${name}, found ${found.length}`);
    return found[0];
  }

  edit(name, text) {
    const s = this.find(name);
    s.text = text;
    s.hash = sha(`${name}\u0000${s.text}\u0000${s.enabled}`);
    return this;
  }

  setEnabled(name, enabled) {
    const s = this.find(name);
    s.enabled = enabled;
    s.hash = sha(`${name}\u0000${s.text}\u0000${s.enabled}`);
    return this;
  }

  remove(name) {
    const s = this.find(name);
    this.scripts.delete(keyOf(s.doctype, s.name));
    this.links = this.links.filter((l) => l.a !== name && l.b !== name);
    return this;
  }

  link(a, b, kind = 'same_field', reason) {
    this.find(a);
    this.find(b);
    this.links.push({ a, b, kind, reason: reason || `test link (${kind})` });
    return this;
  }

  unlink(a, b) {
    this.links = this.links.filter((l) => !((l.a === a && l.b === b) || (l.a === b && l.b === a)));
    return this;
  }

  entry(s) {
    const client = s.doctype === 'Client Script';
    return {
      name: s.name, doctype: s.doctype, script_type: client ? null : s.type,
      reference_doctype: s.type === 'API' ? null : s.dt, doctype_event: !client && s.type === 'DocType Event' ? s.event : null,
      event_frequency: null, cron_format: null, api_method: s.type === 'API' ? s.api : null, allow_guest: false,
      apply_to: client ? 'Form' : null, enabled: s.enabled, module: null, modified: '2026-10-08 10:00:00', hash: s.hash,
    };
  }

  manifest() {
    const entries = [...this.scripts.values()].sort((a, b) => keyOf(a.doctype, a.name).localeCompare(keyOf(b.doctype, b.name))).map((s) => this.entry(s));
    return { bundle_version: 1, generated_at: '2026-10-09 08:00:00', user: 'x', access_mode: 'developer', count: entries.length, scripts: entries };
  }

  linksOf(s) {
    const out = [];
    for (const l of this.links) {
      const otherName = l.a === s.name ? l.b : l.b === s.name ? l.a : null;
      if (!otherName) continue;
      const o = this.find(otherName);
      out.push({ doctype: o.doctype, name: o.name, enabled: o.enabled, kind: l.kind, direction: 'both', reason: l.reason });
    }
    return out;
  }

  bundle(requested) {
    const scripts = [];
    const notFound = [];
    const doctypes = {};
    for (const r of requested) {
      const s = this.scripts.get(keyOf(r.doctype, r.name));
      if (!s || this.hidden.has(s.name)) { notFound.push({ doctype: r.doctype, name: r.name }); continue; }
      scripts.push({
        ...this.entry(s), hash: this.bundleHash.get(s.name) || s.hash, language: s.doctype === 'Server Script' ? 'python' : 'javascript',
        script: s.text, fields_used: [], links: this.linksOf(s), unknown_links: [], external_calls: [],
      });
      const dt = this.entry(s).reference_doctype;
      if (dt && !doctypes[dt]) {
        doctypes[dt] = {
          exists: true, is_submittable: false, is_child_table: false, fields: [], child_tables: {}, standard_fields: ['name'],
          app_doc_events: [], workflows: [], notifications: [],
          scripts: [...this.scripts.values()].filter((o) => this.entry(o).reference_doctype === dt)
            .map((o) => ({ doctype: o.doctype, name: o.name, script_type: this.entry(o).script_type, doctype_event: this.entry(o).doctype_event, apply_to: this.entry(o).apply_to, enabled: o.enabled })),
        };
      }
    }
    return {
      bundle_version: 1, generated_at: '2026-10-09 08:00:00', user: 'x', access_mode: 'developer', requested: requested.length,
      scripts, not_found: notFound, doctypes,
      site: { frappe_version: '15.0.0', apps: { frappe: '15.0.0' }, api_scripts: [] },
    };
  }
}

/** The eight real test scripts, exactly as the connector's own Python code produced them. */
class FixtureSite {
  constructor() {
    const dir = path.join(__dirname, 'fixtures');
    this.m = JSON.parse(fs.readFileSync(path.join(dir, 'real-manifest.json'), 'utf8'));
    this.b = JSON.parse(fs.readFileSync(path.join(dir, 'real-bundle.json'), 'utf8'));
    this.hidden = new Set();
  }

  setHash(name, hash) {
    for (const s of this.m.scripts) if (s.name === name) s.hash = hash;
    for (const s of this.b.scripts) if (s.name === name) s.hash = hash;
  }

  manifest() { return clone(this.m); }

  bundle(requested) {
    const want = new Set(requested.map((r) => keyOf(r.doctype, r.name)));
    const scripts = this.b.scripts.filter((s) => want.has(keyOf(s.doctype, s.name)) && !this.hidden.has(s.name));
    const have = new Set(scripts.map((s) => keyOf(s.doctype, s.name)));
    const doctypes = {};
    for (const s of scripts) if (s.reference_doctype) doctypes[s.reference_doctype] = this.b.doctypes[s.reference_doctype];
    return clone({
      ...this.b, requested: requested.length, scripts,
      not_found: requested.filter((r) => !have.has(keyOf(r.doctype, r.name))).map((r) => ({ doctype: r.doctype, name: r.name })), doctypes,
    });
  }
}

module.exports = { SiteModel, FixtureSite, sha };
