'use strict';
// `fetch`: ask the site what scripts exist, work out which ones need review, and save what
// the review will read. No AI is involved and no tokens are spent. Claude never sees the
// secret: this process reads it and makes the HTTP calls.
//
//   node .claude/scripts/octocheck-site.cjs fetch --site <name> [--profile developer|bot]
//                                                  [--blast-radius <number|off>]
//
// Everything is written under octocheck/cache/sites/<site>/ (decision: state is split by who
// writes it, so an interrupted review can never lose a change):
//
//   manifest.json      written ONLY by fetch: what the site had the last time we looked ("seen")
//   plan.json          written ONLY by fetch: what to review now, and why
//   site-context.json  written ONLY by fetch: Frappe version, apps, API scripts
//   bundles/<slug>.json, contexts/<doctype>.json   written ONLY by fetch, replaced every run
//   entries/<slug>.json   written ONLY by the review ("reviewed": hash, flags, date). fetch
//                         reads these and never writes them.
//
// A script needs review when its hash now differs from the hash in its entry, when it has no
// entry, or when its review is older than review_expiry_days.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const site = require('./octocheck-site.cjs');
const { validateNamed } = require('./octocheck-schema.cjs');

const { UserError } = site;
const DEFAULT_EXPIRY_DAYS = 19;
const DEFAULT_BLAST_RADIUS = 25;
const DEFAULT_PAGE_SIZE = 25;
const MAX_QUERY_CHARS = 3500; // keeps the request line well under typical server limits
const BUNDLE_TIMEOUT_MS = 90000;
const RATE_LIMIT_RETRIES = 2;
const LINK_PRIORITY = { calls_api: 0, saves_doc: 0, same_field: 1, same_event: 2 };
const SHOWN_NAMES = 20;

// --- small helpers ---------------------------------------------------------

/** Script names come from the site and are shown to Claude: strip control characters and
 *  cut long ones, so a name can't carry hidden text into a prompt. */
function clean(text, max = 80) {
  const s = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const keyOf = (doctype, name) => `${doctype}/${name}`;

function slugify(text, max) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

/** A safe, stable file name for a script. The hash suffix keeps names that look alike apart. */
function slugOf(doctype, name) {
  const prefix = doctype === 'Server Script' ? 'server' : 'client';
  const tail = crypto.createHash('sha1').update(`${doctype}\u0000${name}`).digest('hex').slice(0, 8);
  return `${prefix}-${slugify(name, 40) || 'script'}-${tail}`;
}

/** File name for a DocType's context. The hash suffix keeps "A B" and "A-B" apart. */
function contextSlug(doctype) {
  const tail = crypto.createHash('sha1').update(String(doctype)).digest('hex').slice(0, 6);
  return `${slugify(doctype, 40) || 'doctype'}-${tail}`;
}

function deskUrl(origin, doctype, name) {
  return `${origin}/app/${doctype === 'Server Script' ? 'server-script' : 'client-script'}/${encodeURIComponent(name)}`;
}

function stateDirFor(cwd, siteName) {
  return path.join(cwd, 'octocheck', 'cache', 'sites', siteName);
}

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return e.code === 'ENOENT' ? { missing: true } : { broken: true };
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// --- settings (the two numbers fetch needs from octocheck.config.yaml) ----------

/** Read one top-level `key: number` line. Not a YAML parser, on purpose: it understands only a
 *  whole number, or 0/off to switch the setting off, which is all these two settings use. */
function readLimit(configText, key, fallback) {
  const m = String(configText || '').match(new RegExp(`^${key}:[ \\t]*([^#\\r\\n]*)`, 'm'));
  if (!m) return fallback;
  const raw = m[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (raw === 'off') return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  throw new UserError(`octocheck.config.yaml: ${key} must be a whole number, or 0 / off to switch it off (found "${raw}").`);
}

function readSettings(cwd, flags) {
  let text = '';
  try { text = fs.readFileSync(path.join(cwd, 'octocheck.config.yaml'), 'utf8'); } catch (e) { /* defaults */ }
  const settings = {
    review_expiry_days: readLimit(text, 'review_expiry_days', DEFAULT_EXPIRY_DAYS),
    blast_radius_limit: readLimit(text, 'blast_radius_limit', DEFAULT_BLAST_RADIUS),
  };
  if (flags['blast-radius'] !== undefined) {
    const raw = String(flags['blast-radius']).toLowerCase();
    if (raw === 'off') settings.blast_radius_limit = 0;
    else if (/^\d+$/.test(raw)) settings.blast_radius_limit = Number(raw);
    else throw new UserError('--blast-radius must be a whole number, or off.');
  }
  return settings;
}

// --- what was reviewed before ----------------------------------------------

/** Read the review entries (written by the review, never by fetch). */
function readEntries(stateDir) {
  const dir = path.join(stateDir, 'entries');
  const entries = new Map();
  const broken = new Set();
  if (!fs.existsSync(dir)) return { entries, broken };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const slug = file.slice(0, -5);
    const read = readJson(path.join(dir, file));
    const e = read.value;
    if (!e || typeof e !== 'object' || typeof e.h !== 'string' || typeof e.doctype !== 'string' || typeof e.name !== 'string') {
      broken.add(slug);
      continue;
    }
    entries.set(slug, e);
  }
  return { entries, broken };
}

function daysBetween(fromIso, now) {
  const from = Date.parse(fromIso);
  return Number.isFinite(from) ? Math.floor((now - from) / 86400000) : Infinity;
}

/** Label every script and find the removed ones. */
function classify(scripts, entries, broken, settings, now) {
  const items = new Map();
  const warnings = [];
  for (const s of scripts) {
    const key = keyOf(s.doctype, s.name);
    const slug = slugOf(s.doctype, s.name);
    const entry = entries.get(slug);
    let status;
    let reason;
    let flipped = false;
    if (broken.has(slug)) {
      status = 'new';
      reason = 'the saved review entry could not be read';
      warnings.push(`The review entry for "${clean(s.name)}" could not be read, so it is treated as never reviewed.`);
    } else if (!entry) {
      status = 'new';
      reason = 'never reviewed';
    } else if (entry.h !== s.hash) {
      status = 'changed';
      reason = 'changed since its last review';
      flipped = typeof entry.en === 'boolean' && entry.en !== s.enabled;
    } else if (settings.review_expiry_days > 0 && daysBetween(entry.rev, now) > settings.review_expiry_days) {
      status = 'expired';
      reason = `last review is older than ${settings.review_expiry_days} days`;
    } else {
      status = 'unchanged';
      reason = 'unchanged since its last review';
    }
    items.set(key, { key, slug, doctype: s.doctype, name: s.name, enabled: s.enabled, hash: s.hash, status, reason, flipped, entry });
  }
  const present = new Set([...items.values()].map((i) => i.slug));
  const removed = [];
  for (const [slug, e] of entries) {
    if (e.del === true || present.has(slug)) continue;
    removed.push({ slug, doctype: e.doctype, name: e.name, last_reviewed: e.rev || null });
  }
  for (const slug of broken) {
    if (!present.has(slug)) warnings.push(`An unreadable review entry (${slug}.json) belongs to no script on the site and was ignored.`);
  }
  removed.sort((a, b) => keyOf(a.doctype, a.name).localeCompare(keyOf(b.doctype, b.name)));
  return { items, removed, warnings };
}

// --- talking to the connector ----------------------------------------------

function checkSchema(message, definition, endpoint) {
  const errors = validateNamed(message, definition);
  if (errors.length) {
    const more = errors.length > 3 ? ` (and ${errors.length - 3} more)` : '';
    throw new UserError(
      `The answer from ${endpoint} does not match the expected format: ${errors.slice(0, 3).join('; ')}${more}. ` +
      'The connector and this OctoCheck may be different versions. Nothing was changed.'
    );
  }
}

/** Split names into calls that respect the page size and a safe URL length. */
function makeBatches(refs, pageSize, maxChars = MAX_QUERY_CHARS) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const ref of refs) {
    const add = encodeURIComponent(JSON.stringify({ doctype: ref.doctype, name: ref.name })).length + 3;
    if (current.length && (current.length >= pageSize || size + add > maxChars)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(ref);
    size += add;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function fetchBundles(refs, pageSize, call) {
  const out = { scripts: new Map(), doctypes: {}, siteContext: null, missing: [], calls: 0 };
  for (const batch of makeBatches(refs, pageSize)) {
    const message = await call('get_review_bundle', { scripts: JSON.stringify(batch.map((r) => ({ doctype: r.doctype, name: r.name }))) }, BUNDLE_TIMEOUT_MS);
    out.calls += 1;
    checkSchema(message, 'review_bundle', 'get_review_bundle');
    for (const s of message.scripts) out.scripts.set(keyOf(s.doctype, s.name), s);
    for (const [dt, context] of Object.entries(message.doctypes)) if (!(dt in out.doctypes)) out.doctypes[dt] = context;
    if (!out.siteContext) out.siteContext = message.site;
    out.missing.push(...message.not_found.map((n) => keyOf(n.doctype, n.name)));
  }
  return out;
}

// --- neighbours ---------------------------------------------------------------

/**
 * Scripts linked to a script that needs review are re-checked too, one step only (decision 8).
 * Links come from the current bundle AND from the previous fetch, so a link that an edit just
 * removed still counts once. Disabled neighbours cannot run, so they are listed but not fetched.
 */
function pickNeighbours(reviewKeys, fresh, previous, current, limit) {
  const reviewSet = new Set(reviewKeys);
  const found = new Map();
  const note = (neighbourKey, because) => {
    if (reviewSet.has(neighbourKey) || !current.has(neighbourKey)) return;
    if (!found.has(neighbourKey)) found.set(neighbourKey, []);
    found.get(neighbourKey).push(because);
  };
  for (const key of reviewKeys) {
    const script = current.get(key);
    const links = fresh.has(key) ? fresh.get(key).links.map((l) => ({ ...l, source: 'current' })) : [];
    const old = previous && previous.scripts && previous.scripts[key] && previous.scripts[key].links;
    for (const l of old || []) links.push({ doctype: l.doctype, name: l.name, kind: l.kind, reason: 'was linked before this change', source: 'previous' });
    for (const l of links) {
      note(keyOf(l.doctype, l.name), {
        script: clean(script.name), slug: slugOf(script.doctype, script.name), kind: l.kind, reason: clean(l.reason, 160), source: l.source,
      });
    }
  }
  const rows = [...found.entries()].map(([key, because]) => {
    const s = current.get(key);
    const priority = Math.min(...because.map((b) => LINK_PRIORITY[b.kind] === undefined ? 3 : LINK_PRIORITY[b.kind]));
    because.sort((a, b) => a.script.localeCompare(b.script) || a.kind.localeCompare(b.kind));
    return { key, doctype: s.doctype, name: s.name, enabled: s.enabled, slug: slugOf(s.doctype, s.name), because, priority, weight: new Set(because.map((b) => b.script)).size };
  });
  rows.sort((a, b) => a.priority - b.priority || b.weight - a.weight || a.key.localeCompare(b.key));
  const live = rows.filter((r) => r.enabled);
  const disabled = rows.filter((r) => !r.enabled);
  const selected = limit > 0 ? live.slice(0, limit) : live;
  const over = limit > 0 ? live.slice(limit) : [];
  return { selected, over, disabled };
}

// --- writing the results ------------------------------------------------------

/** Build everything first, then swap it in, with plan.json last, so a failure leaves the
 *  previous run's files whole. */
function writeState(stateDir, parts) {
  fs.mkdirSync(stateDir, { recursive: true });
  const staging = path.join(stateDir, `.staging-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(staging, 'bundles'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'contexts'), { recursive: true });
    for (const [name, value] of Object.entries(parts.bundles)) writeJson(path.join(staging, 'bundles', `${name}.json`), value);
    for (const [name, value] of Object.entries(parts.contexts)) writeJson(path.join(staging, 'contexts', `${name}.json`), value);
    writeJson(path.join(staging, 'site-context.json'), parts.siteContext);
    writeJson(path.join(staging, 'manifest.json'), parts.manifest);
    writeJson(path.join(staging, 'plan.json'), parts.plan);
    for (const dir of ['bundles', 'contexts']) {
      fs.rmSync(path.join(stateDir, dir), { recursive: true, force: true });
      fs.renameSync(path.join(staging, dir), path.join(stateDir, dir));
    }
    for (const file of ['site-context.json', 'manifest.json', 'plan.json']) {
      fs.renameSync(path.join(staging, file), path.join(stateDir, file));
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// --- the command --------------------------------------------------------------

async function runFetch(flags, ctx) {
  const { io, cwd, env, home } = ctx;
  const siteName = flags.site;
  const profile = flags.profile || 'developer';
  site.checkSiteName(siteName);
  site.checkProfileName(profile);
  const now = ctx.now ? ctx.now() : new Date();

  const sites = site.readSites(cwd);
  if (!sites[siteName]) throw new UserError(`"${siteName}" is not in ${site.SITES_FILE}. Run setup first.`);
  const { origin } = site.checkUrl(sites[siteName].url, flags['allow-insecure-http']);
  const creds = site.loadCredentials(siteName, profile, env, home);
  const secrets = [creds.key, creds.secret];
  const settings = readSettings(cwd, flags);
  const stateDir = stateDirFor(cwd, siteName);

  const call = (endpoint, query, timeoutMs) => site.callEndpoint(origin, endpoint, query, creds.key, creds.secret, {
    httpGet: ctx.httpGet, sleep: ctx.sleep, retries: RATE_LIMIT_RETRIES, timeoutMs,
    onWait: (s) => io.err(`The site is rate limiting this key. Waiting ${s} seconds, then trying again.`),
  });

  try {
    const info = await site.getInfo(origin, creds.key, creds.secret, ctx.httpGet, { retries: RATE_LIMIT_RETRIES, sleep: ctx.sleep });
    if (profile === 'bot' && info.access_mode !== 'reviewer') {
      throw new UserError(`The bot key belongs to ${info.user}, which got ${info.access_mode} mode. The bot must have ONLY the OctoCheck Reviewer role. Nothing was fetched.`);
    }
    const pageSize = Math.min(Math.max(Number(info.page_size) || DEFAULT_PAGE_SIZE, 1), 100);

    const manifest = await call('get_manifest', {});
    checkSchema(manifest, 'manifest', 'get_manifest');
    const current = new Map(manifest.scripts.map((s) => [keyOf(s.doctype, s.name), s]));

    const { entries, broken } = readEntries(stateDir);
    const { items, removed, warnings } = classify(manifest.scripts, entries, broken, settings, now.getTime());
    const needReview = [...items.values()].filter((i) => i.status !== 'unchanged');
    const reviewKeys = needReview.map((i) => i.key);
    const previousRead = readJson(path.join(stateDir, 'manifest.json'));
    if (previousRead.broken) warnings.push('The previous manifest.json could not be read, so links from before this change are unknown.');
    const previous = previousRead.value || null;

    // Round 1: the scripts that need review.
    const first = await fetchBundles(needReview, pageSize, call);
    const notes = [];
    const unavailable = [];
    const fetched = new Map();
    for (const item of needReview) {
      const bundle = first.scripts.get(item.key);
      if (!bundle) {
        unavailable.push({ doctype: item.doctype, name: item.name, why: 'the connector did not return it (removed or no longer readable since the manifest)' });
        continue;
      }
      if (bundle.hash !== item.hash) {
        notes.push(`"${clean(item.name)}" changed on the site while fetching; the newer version is what will be reviewed.`);
        item.hash = bundle.hash;
        current.get(item.key).hash = bundle.hash;
      }
      fetched.set(item.key, bundle);
    }

    // Round 2: their neighbours.
    const freshLinks = new Map([...fetched].map(([k, b]) => [k, b]));
    const neighbours = pickNeighbours(reviewKeys, freshLinks, previous, current, settings.blast_radius_limit);
    const second = await fetchBundles(neighbours.selected, pageSize, call);
    const impacted = [];
    for (const n of neighbours.selected) {
      const bundle = second.scripts.get(n.key);
      if (!bundle) {
        unavailable.push({ doctype: n.doctype, name: n.name, why: 'the connector did not return it (removed or no longer readable since the manifest)' });
        continue;
      }
      fetched.set(n.key, bundle);
      impacted.push(n);
    }
    const calls = first.calls + second.calls;
    const doctypes = { ...second.doctypes, ...first.doctypes };
    const siteContext = first.siteContext || second.siteContext;

    // Build the files.
    const contextFile = (dt) => (dt && doctypes[dt] ? `contexts/${contextSlug(dt)}.json` : null);
    const bundleFiles = {};
    const contextFiles = {};
    const plainBundle = (key, role, because) => {
      const b = fetched.get(key);
      const slug = slugOf(b.doctype, b.name);
      bundleFiles[slug] = { role, because: because || [], script: b, context: contextFile(b.reference_doctype) };
      if (b.reference_doctype && doctypes[b.reference_doctype]) contextFiles[contextSlug(b.reference_doctype)] = doctypes[b.reference_doctype];
      return `bundles/${slug}.json`;
    };

    const review = [];
    for (const item of needReview) {
      if (!fetched.has(item.key)) continue;
      const b = fetched.get(item.key);
      review.push({
        slug: item.slug, doctype: item.doctype, name: item.name, status: item.status, reason: item.reason,
        enabled: item.enabled, enabled_flipped: item.flipped || undefined, hash: item.hash,
        desk_url: deskUrl(origin, item.doctype, item.name), bundle: plainBundle(item.key, 'review'), context: contextFile(b.reference_doctype),
      });
    }
    const impactedOut = impacted.map((n) => ({
      slug: n.slug, doctype: n.doctype, name: n.name, enabled: n.enabled, because: n.because,
      desk_url: deskUrl(origin, n.doctype, n.name), bundle: plainBundle(n.key, 'impacted', n.because),
      context: contextFile(fetched.get(n.key).reference_doctype),
    }));
    const brief = (n) => ({ slug: n.slug, doctype: n.doctype, name: n.name, because: n.because, desk_url: deskUrl(origin, n.doctype, n.name) });

    const counts = { total: manifest.scripts.length, new: 0, changed: 0, expired: 0, unchanged: 0 };
    for (const i of items.values()) counts[i.status] += 1;
    Object.assign(counts, {
      removed: removed.length, impacted: impactedOut.length, impacted_over_limit: neighbours.over.length,
      impacted_disabled: neighbours.disabled.length, unavailable: unavailable.length, bundle_calls: calls,
    });

    const manifestOut = {
      fetched_at: now.toISOString(), site: siteName, profile,
      scripts: Object.fromEntries([...current].sort(([a], [b]) => a.localeCompare(b)).map(([key, s]) => {
        const b = fetched.get(key);
        const old = previous && previous.scripts && previous.scripts[key];
        const links = b ? b.links.map((l) => ({ doctype: l.doctype, name: l.name, kind: l.kind })) : (old && old.links) || [];
        return [key, {
          doctype: s.doctype, name: s.name, hash: s.hash, enabled: s.enabled, script_type: s.script_type,
          reference_doctype: s.reference_doctype, doctype_event: s.doctype_event, apply_to: s.apply_to, modified: s.modified, links,
        }];
      })),
    };

    const plan = {
      plan_version: 1, site: siteName, profile, url: origin, fetched_at: now.toISOString(),
      connector: { version: info.connector_version, frappe_version: info.frappe_version, user: info.user, access_mode: info.access_mode },
      settings: { review_expiry_days: settings.review_expiry_days, blast_radius_limit: settings.blast_radius_limit, page_size: pageSize },
      counts, review, impacted: impactedOut,
      impacted_over_limit: neighbours.over.map(brief), impacted_disabled: neighbours.disabled.map(brief),
      unchanged: [...items.values()].filter((i) => i.status === 'unchanged').map((i) => ({ slug: i.slug, doctype: i.doctype, name: i.name })),
      removed, unavailable, notes, warnings,
    };

    writeState(stateDir, { bundles: bundleFiles, contexts: contextFiles, siteContext: siteContext || {}, manifest: manifestOut, plan });

    // A short summary: this is what Claude and the user read.
    const where = path.relative(cwd, path.join(stateDir, 'plan.json')) || 'plan.json';
    io.out(`${siteName} as ${profile} (${info.access_mode} mode), Frappe ${info.frappe_version}, connector ${info.connector_version}.`);
    io.out(`${counts.total} scripts on the site: ${counts.new} new, ${counts.changed} changed, ${counts.expired} expired, ${counts.unchanged} unchanged, ${counts.removed} removed.`);
    const names = (list) => list.slice(0, SHOWN_NAMES).map((r) => `  - ${clean(r.name)}${r.status ? ` (${r.status})` : ''}`).concat(list.length > SHOWN_NAMES ? [`  ...and ${list.length - SHOWN_NAMES} more`] : []);
    if (review.length) { io.out(`To review (${review.length}):`); names(review).forEach((l) => io.out(l)); }
    io.out(`Linked scripts to re-check: ${counts.impacted}${counts.impacted_over_limit ? `, plus ${counts.impacted_over_limit} over the limit of ${settings.blast_radius_limit}` : ''}${counts.impacted_disabled ? `, ${counts.impacted_disabled} disabled and skipped` : ''}.`);
    if (impactedOut.length) { names(impactedOut).forEach((l) => io.out(l)); }
    for (const r of removed.slice(0, SHOWN_NAMES)) io.out(`Removed since the last review: ${clean(r.name)}`);
    for (const u of unavailable) io.out(`Not available: ${clean(u.name)} (${u.why})`);
    for (const w of warnings.concat(notes)) io.out(`Note: ${w}`);
    io.out(`Fetched ${fetched.size} script${fetched.size === 1 ? '' : 's'} in ${calls} call${calls === 1 ? '' : 's'}. Plan: ${where}`);
    return plan;
  } catch (e) {
    if (e instanceof UserError) throw new UserError(site.mask(e.message, secrets));
    throw e;
  }
}

module.exports = {
  runFetch, classify, pickNeighbours, makeBatches, slugOf, contextSlug, readLimit, readSettings, readEntries, clean, keyOf, deskUrl, stateDirFor,
};
