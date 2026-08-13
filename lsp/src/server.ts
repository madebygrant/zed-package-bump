import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  DiagnosticSeverity,
  CodeActionKind,
  type Diagnostic,
  type CodeAction,
  type TextEdit,
  type Range,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const REGISTRY_URL = 'https://registry.npmjs.org';
const AUDIT_URL = `${REGISTRY_URL}/-/npm/v1/security/advisories/bulk`;
const CACHE_TTL_MS = 5 * 60 * 1000;
/* advisories change slowly; cache longer than dist-tags */
const AUDIT_TTL_MS = 60 * 60 * 1000;
const MAX_CONCURRENT = 8;
const MAX_META_CACHE = 500;
/* deprecation notes are free text and can run long — cap before caching
   so 500 packages × every published version stays bounded */
const MAX_DEPRECATION_LEN = 160;

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/* ranges we know how to bump: optional ^/~ prefix + full semver */
const UPDATABLE_RE = /^([\^~]?)(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?$/;

interface TierUpdate {
  level: BumpLevel;
  version: string;
}

interface DepFinding {
  name: string;
  current: string;
  /* highest available update — target of "update all" */
  latest: string;
  /* newest patch / minor / major updates, ascending, deduped */
  tiers: TierUpdate[];
  /* range of the version string between the quotes */
  range: Range;
}

interface CacheEntry {
  latest: string | null;
  /* every published version, ascending — used to find vulnerability fixes */
  versions: string[];
  /* deprecation message per deprecated version, truncated at store */
  deprecated: Map<string, string>;
  /* packument last-modified timestamp (ISO) — publishes, deprecations,
     owner changes all move it */
  modified: string | null;
  ts: number;
}

const metaCache = new Map<string, CacheEntry>();

/* stand-in when a package has no cache entry — read-only by convention */
const NO_DEPRECATIONS: ReadonlyMap<string, string> = new Map();

/* complete: "eslint: 9.39.4 → 10.8.1 (major)"
   compact:  "→ 10.8.1 (major)"
   level:    "major" */
type MessageStyle = 'complete' | 'compact' | 'level';
let messageStyle: MessageStyle = 'compact';
let checkVulnerabilities = true;
/* clients without documentChanges support ignore that form entirely — fall
   back to `changes` rather than shipping an edit they silently drop */
let supportsDocumentChanges = false;

function applySettings(settings: unknown): void {
  const s = settings as
    | { message_style?: string; check_vulnerabilities?: boolean }
    | undefined;
  const style = s?.message_style;
  if (style === 'complete' || style === 'compact' || style === 'level') {
    messageStyle = style;
  }
  if (typeof s?.check_vulnerabilities === 'boolean') {
    checkVulnerabilities = s.check_vulnerabilities;
  }
}

// ---------- semver ----------

function parseSemver(
  v: string,
): [number, number, number, string[] | null] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4]?.split('.') ?? null];
}

/* semver §11: at equal triple, stable > prerelease; identifiers compare
   numerically when both numeric (numeric < alphanumeric), else lexically;
   longer identifier list wins when equal so far */
function comparePre(a: string[] | null, b: string[] | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) - Number(b[i]);
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

function semverCmp(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  }
  return comparePre(pa[3], pb[3]);
}

/* npm advisory ranges: comparators AND-ed by spaces, alternatives OR-ed
   by ||, e.g. ">=4.0.0 <4.17.21", "<1.2.3 || >=2.0.0 <2.1.0", "*" */
function parseComparator(c: string): { op: string; v: string } | null {
  if (c === '*') return { op: '*', v: '' };
  const m = /^(<=|>=|<|>|=)?(.+)$/.exec(c);
  return m && parseSemver(m[2]) ? { op: m[1] ?? '=', v: m[2] } : null;
}

function rangeParseable(range: string): boolean {
  return range.split('||').every((alt) => {
    const comparators = alt.trim().split(/\s+/).filter(Boolean);
    return (
      comparators.length > 0 &&
      comparators.every((c) => parseComparator(c) !== null)
    );
  });
}

function satisfiesRange(version: string, range: string): boolean {
  return range.split('||').some((alt) => {
    const comparators = alt.trim().split(/\s+/).filter(Boolean);
    if (!comparators.length) return false;
    return comparators.every((c) => {
      const parsed = parseComparator(c);
      if (!parsed) return false;
      if (parsed.op === '*') return true;
      const cmp = semverCmp(version, parsed.v);
      switch (parsed.op) {
        case '<':
          return cmp < 0;
        case '<=':
          return cmp <= 0;
        case '>':
          return cmp > 0;
        case '>=':
          return cmp >= 0;
        default:
          return cmp === 0;
      }
    });
  });
}

type BumpLevel = 'major' | 'minor' | 'patch';

/* newest stable update per tier: patch (same major.minor), minor (same
   major), major — only versions above `current` and at or below the
   `latest` dist-tag, so pre-releases published past `latest` stay hidden.
   Deprecated versions are never offered: bumping into one would only earn
   a deprecation warning on the next pass */
function tierUpdates(
  versions: string[],
  current: string,
  latest: string,
  deprecated: ReadonlyMap<string, string>,
): TierUpdate[] {
  const pc = parseSemver(current);
  if (!pc) return [];
  let patch: string | null = null;
  let minor: string | null = null;
  let major: string | null = null;
  for (const v of versions) {
    const p = parseSemver(v);
    if (!p || p[3] || deprecated.has(v)) continue;
    if (semverCmp(v, current) <= 0 || semverCmp(v, latest) > 0) continue;
    if (p[0] === pc[0] && p[1] === pc[1]) {
      if (!patch || semverCmp(v, patch) > 0) patch = v;
    } else if (p[0] === pc[0]) {
      if (!minor || semverCmp(v, minor) > 0) minor = v;
    } else if ((p[0] as number) > (pc[0] as number)) {
      if (!major || semverCmp(v, major) > 0) major = v;
    }
  }
  const tiers: TierUpdate[] = [];
  if (patch) tiers.push({ level: 'patch', version: patch });
  if (minor) tiers.push({ level: 'minor', version: minor });
  if (major) tiers.push({ level: 'major', version: major });

  /* no stable tier but latest is still newer (prerelease-only package, or
     a prerelease bump like rc.1 → rc.2) — offer latest itself */
  const pl = parseSemver(latest);
  if (!tiers.length && pl && !deprecated.has(latest) && semverCmp(latest, current) > 0) {
    const level: BumpLevel =
      pl[0] !== pc[0] ? 'major' : pl[1] !== pc[1] ? 'minor' : 'patch';
    tiers.push({ level, version: latest });
  }
  return tiers;
}

/* color coding via severity: major=Warning, minor=Information,
   patch=Hint — pair with theme overrides for distinct colors if the
   active theme renders these statuses alike */
const SEVERITY_BY_LEVEL: Record<BumpLevel, DiagnosticSeverity> = {
  major: DiagnosticSeverity.Warning,
  minor: DiagnosticSeverity.Information,
  patch: DiagnosticSeverity.Hint,
};

// ---------- registry ----------

function truncateNote(note: string): string {
  return note.length > MAX_DEPRECATION_LEN
    ? `${note.slice(0, MAX_DEPRECATION_LEN - 3)}…`
    : note;
}

async function fetchMeta(name: string): Promise<CacheEntry> {
  const cached = metaCache.get(name);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached;

  let latest: string | null = null;
  let versions: string[] = [];
  const deprecated = new Map<string, string>();
  let modified: string | null = null;
  try {
    const res = await fetch(
      `${REGISTRY_URL}/${encodeURIComponent(name).replace('%40', '@')}`,
      {
        headers: {
          /* abbreviated metadata: dist-tags + versions only, much smaller */
          Accept: 'application/vnd.npm.install-v1+json',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        'dist-tags'?: Record<string, string>;
        versions?: Record<string, { deprecated?: string | boolean }>;
        modified?: string;
      };
      latest = body['dist-tags']?.latest ?? null;
      versions = Object.keys(body.versions ?? {})
        .filter((v) => parseSemver(v) !== null)
        .sort(semverCmp);
      modified = body.modified ?? null;
      for (const [v, manifest] of Object.entries(body.versions ?? {})) {
        const d = manifest?.deprecated;
        if (typeof d === 'string' && d) deprecated.set(v, truncateNote(d));
        else if (d === true) deprecated.set(v, 'deprecated');
      }
    }
  } catch {
    /* network failure → no diagnostic, retry after TTL */
  }
  const entry = { latest, versions, deprecated, modified, ts: Date.now() };
  /* version lists can run to thousands of entries (@types/*) — evict the
     oldest insertions rather than grow without bound */
  if (metaCache.size >= MAX_META_CACHE) {
    for (const key of metaCache.keys()) {
      if (metaCache.size < MAX_META_CACHE) break;
      metaCache.delete(key);
    }
  }
  metaCache.set(name, entry);
  return entry;
}

/* smallest stable, non-deprecated version above `current` that no advisory
   range matches. A range we can't parse means we can't prove any version
   safe — fail closed and suggest nothing rather than guess */
function firstSafeVersion(
  versions: string[],
  current: string,
  advisories: Advisory[],
  deprecated: ReadonlyMap<string, string>,
): string | null {
  if (advisories.some((a) => !rangeParseable(a.vulnerable_versions))) {
    return null;
  }
  for (const v of versions) {
    const p = parseSemver(v);
    if (!p || p[3] || deprecated.has(v)) continue;
    if (semverCmp(v, current) <= 0) continue;
    if (advisories.every((a) => !satisfiesRange(v, a.vulnerable_versions))) {
      return v;
    }
  }
  return null;
}

// ---------- vulnerability audit ----------

interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  vulnerable_versions: string;
}

const SEVERITY_RANK: Record<Advisory['severity'], number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

interface AuditEntry {
  advisories: Advisory[];
  ts: number;
}

/* keyed by `${name}@${version}` */
const auditCache = new Map<string, AuditEntry>();

/* npm's bulk audit endpoint (the one `npm audit` uses): POST
   {name: [version]} → {name: [advisories matching that version]}.
   Matching is server-side, but the response is keyed by name only, so a
   name can appear at most once per request — names with several distinct
   versions in the file go out in separate rounds (slot k carries each
   name's k-th version) to keep the attribution unambiguous */
async function fetchAdvisories(
  pairs: Array<{ name: string; version: string }>,
): Promise<void> {
  const now = Date.now();
  const byName = new Map<string, string[]>();
  for (const { name, version } of pairs) {
    const cached = auditCache.get(`${name}@${version}`);
    if (cached && now - cached.ts < AUDIT_TTL_MS) continue;
    let versions = byName.get(name);
    if (!versions) byName.set(name, (versions = []));
    if (!versions.includes(version)) versions.push(version);
  }
  if (byName.size === 0) return;

  const rounds = Math.max(...[...byName.values()].map((v) => v.length));
  const requests = [];
  for (let slot = 0; slot < rounds; slot++) {
    const body: Record<string, string[]> = {};
    for (const [name, versions] of byName) {
      if (versions[slot] !== undefined) body[name] = [versions[slot]];
    }
    requests.push(
      (async () => {
        try {
          const res = await fetch(AUDIT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return;
          const result = (await res.json()) as Record<string, Advisory[]>;
          for (const name of Object.keys(body)) {
            auditCache.set(`${name}@${body[name][0]}`, {
              advisories: result[name] ?? [],
              ts: Date.now(),
            });
          }
        } catch {
          /* network failure → no vuln diagnostics this round, retry after TTL */
        }
      })(),
    );
  }
  await Promise.all(requests);
}

function advisoriesFor(name: string, version: string): Advisory[] {
  return auditCache.get(`${name}@${version}`)?.advisories ?? [];
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------- package.json analysis ----------

function isPackageJson(uri: string): boolean {
  return /\/package\.json$/.test(uri);
}

/* name → all ranges seen across sections; a dep can appear in several
   sections (e.g. peerDependencies + devDependencies) with different ranges */
function collectDeps(text: string): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return deps;
  }
  for (const section of DEP_SECTIONS) {
    const block = parsed[section];
    if (block && typeof block === 'object') {
      for (const [name, range] of Object.entries(block)) {
        if (typeof range === 'string' && UPDATABLE_RE.test(range)) {
          let ranges = deps.get(name);
          if (!ranges) deps.set(name, (ranges = new Set()));
          ranges.add(range);
        }
      }
    }
  }
  return deps;
}

/* locate the value range of every `"name": "range"` pair matching a known dep */
function findVersionRanges(
  doc: TextDocument,
  deps: Map<string, Set<string>>,
): Array<{ name: string; current: string; range: Range }> {
  const text = doc.getText();
  const out: Array<{ name: string; current: string; range: Range }> = [];
  const pairRe = /"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(text)) !== null) {
    const [, name, value] = m;
    if (!deps.get(name)?.has(value)) continue;
    const valueStart = m.index + m[0].lastIndexOf(value);
    out.push({
      name,
      current: value,
      range: {
        start: doc.positionAt(valueStart),
        end: doc.positionAt(valueStart + value.length),
      },
    });
  }
  return out;
}

// ---------- validation ----------

const pendingValidation = new Map<string, NodeJS.Timeout>();
/* findings per uri, consumed by code actions */
const findingsByUri = new Map<string, DepFinding[]>();
/* vulnerable deps with a known safe version, per uri; `latest` holds the fix */
interface VulnFix {
  name: string;
  current: string;
  latest: string;
  range: Range;
  advisoryCount: number;
}
const vulnFixesByUri = new Map<string, VulnFix[]>();

function scheduleValidation(doc: TextDocument): void {
  const existing = pendingValidation.get(doc.uri);
  if (existing) clearTimeout(existing);
  pendingValidation.set(
    doc.uri,
    setTimeout(() => {
      pendingValidation.delete(doc.uri);
      void validate(doc.uri);
    }, 500),
  );
}

async function validate(uri: string): Promise<void> {
  const doc = documents.get(uri);
  if (!doc || !isPackageJson(uri)) return;

  const version = doc.version;
  const deps = collectDeps(doc.getText());
  const sites = findVersionRanges(doc, deps);

  const uniqueNames = [...new Set(sites.map((s) => s.name))];
  const metaByName = new Map<string, CacheEntry>();
  const auditPairs = sites.map((s) => ({
    name: s.name,
    version: s.current.replace(/^[\^~]/, ''),
  }));
  await Promise.all([
    mapLimit(uniqueNames, MAX_CONCURRENT, async (name) => {
      metaByName.set(name, await fetchMeta(name));
    }),
    checkVulnerabilities ? fetchAdvisories(auditPairs) : Promise.resolve(),
  ]);

  /* document changed while fetching → stale ranges, rerun happens via debounce */
  const fresh = documents.get(uri);
  if (!fresh || fresh.version !== version) return;

  const findings: DepFinding[] = [];
  /* newer versions exist but every one is deprecated, so nothing is
     offerable and no finding is produced — reported separately rather
     than leaving the line silent */
  const withheld: Array<{ site: (typeof sites)[number]; tier: TierUpdate }> =
    [];
  for (const site of sites) {
    const meta = metaByName.get(site.name);
    if (!meta?.latest) continue;
    const bare = site.current.replace(/^[\^~]/, '');
    /* no version list (unusual registry response) → fall back to latest */
    const pool = meta.versions.length ? meta.versions : [meta.latest];
    const tiers = tierUpdates(pool, bare, meta.latest, meta.deprecated);
    if (!tiers.length) {
      const ignored = tierUpdates(pool, bare, meta.latest, NO_DEPRECATIONS);
      const top = ignored[ignored.length - 1];
      if (top) withheld.push({ site, tier: top });
      continue;
    }
    findings.push({
      ...site,
      latest: tiers[tiers.length - 1].version,
      tiers,
    });
  }
  findingsByUri.set(uri, findings);

  const diagnostics: Diagnostic[] = findings.map((f) => {
    const bare = f.current.replace(/^[\^~]/, '');
    const highest = f.tiers[f.tiers.length - 1];
    const list = f.tiers
      .map((t) => `${t.version} (${t.level})`)
      .join(' | ');
    const modified = metaByName.get(f.name)?.modified;
    const published =
      modified && messageStyle === 'complete'
        ? ` — updated ${modified.slice(0, 10)}`
        : '';
    const message =
      messageStyle === 'level'
        ? highest.level
        : messageStyle === 'compact'
          ? `→ ${list}`
          : `${f.name}: ${bare} → ${list}${published}`;
    return {
      range: f.range,
      severity: SEVERITY_BY_LEVEL[highest.level],
      source: 'package-bump',
      message,
      data: { name: f.name, latest: f.latest },
    };
  });

  /* deprecated versions get their own warning regardless of update status */
  for (const site of sites) {
    const bare = site.current.replace(/^[\^~]/, '');
    const note = metaByName.get(site.name)?.deprecated.get(bare);
    if (note === undefined) continue;
    diagnostics.push({
      range: site.range,
      severity: DiagnosticSeverity.Warning,
      source: 'package-bump',
      message:
        messageStyle === 'level'
          ? '⛔ deprecated'
          : messageStyle === 'compact'
            ? `⛔ deprecated: ${note}`
            : `${site.name} ${bare} is deprecated: ${note}`,
    });
  }

  /* informational: there is nothing to click, the point is that the
     silence is deliberate */
  for (const { site, tier } of withheld) {
    const bare = site.current.replace(/^[\^~]/, '');
    diagnostics.push({
      range: site.range,
      severity: DiagnosticSeverity.Information,
      source: 'package-bump',
      message:
        messageStyle === 'level'
          ? '⛔ no update'
          : messageStyle === 'compact'
            ? `⛔ ${tier.version} (${tier.level}) deprecated — no update offered`
            : `${site.name}: ${bare} → ${tier.version} (${tier.level}) is deprecated — no update offered`,
    });
  }

  const vulnFixes: VulnFix[] = [];
  if (checkVulnerabilities) {
    interface VulnSite {
      site: (typeof sites)[number];
      bare: string;
      /* advisories matching the current version — drives the diagnostic */
      matched: Advisory[];
      /* every advisory seen while searching, keyed by id — drives the fix */
      known: Map<number, Advisory>;
      fix: string | null;
      verified: boolean;
    }
    const vulnSites: VulnSite[] = [];
    for (const site of sites) {
      const bare = site.current.replace(/^[\^~]/, '');
      const matched = advisoriesFor(site.name, bare);
      if (!matched.length) continue;
      const meta = metaByName.get(site.name);
      vulnSites.push({
        site,
        bare,
        matched,
        known: new Map(matched.map((a) => [a.id, a])),
        fix: firstSafeVersion(
          meta?.versions ?? [],
          bare,
          matched,
          meta?.deprecated ?? NO_DEPRECATIONS,
        ),
        verified: false,
      });
    }

    /* the candidate was chosen against the CURRENT version's advisories;
       an advisory introduced in a later range is invisible until the
       candidate itself is audited. Audit candidates (one bulk POST per
       round, cached) and walk upward until one comes back clean */
    for (let round = 0; round < 3; round++) {
      const pending = vulnSites.filter((v) => v.fix && !v.verified);
      if (!pending.length) break;
      await fetchAdvisories(
        pending.map((v) => ({ name: v.site.name, version: v.fix as string })),
      );
      for (const v of pending) {
        const extra = advisoriesFor(v.site.name, v.fix as string);
        if (!extra.length) {
          v.verified = true;
          continue;
        }
        for (const a of extra) v.known.set(a.id, a);
        const meta = metaByName.get(v.site.name);
        v.fix = firstSafeVersion(
          meta?.versions ?? [],
          v.bare,
          [...v.known.values()],
          meta?.deprecated ?? NO_DEPRECATIONS,
        );
      }
    }

    for (const { site, bare, matched, fix, verified } of vulnSites) {
      const safe = verified ? fix : null;
      const worst = matched.reduce((a, b) =>
        SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a,
      );
      const n = matched.length;
      if (safe) vulnFixes.push({ ...site, latest: safe, advisoryCount: n });
      const count = `${n} ${n === 1 ? 'vulnerability' : 'vulnerabilities'}`;
      const fixNote = safe ? `, fix: ${safe}` : '';
      const message =
        messageStyle === 'level'
          ? `⚠ ${worst.severity}`
          : messageStyle === 'compact'
            ? `⚠ ${count} (${worst.severity}${fixNote})`
            : `${site.name} ${bare}: ${count} (worst: ${worst.severity}${fixNote}) — ${worst.title}`;
      diagnostics.push({
        range: site.range,
        severity:
          SEVERITY_RANK[worst.severity] >= SEVERITY_RANK.high
            ? DiagnosticSeverity.Error
            : worst.severity === 'moderate'
              ? DiagnosticSeverity.Warning
              : DiagnosticSeverity.Information,
        source: 'package-bump',
        message,
        code: worst.url.split('/').pop(),
        codeDescription: { href: worst.url },
      });
    }
  }
  /* the fix-verification rounds awaited network again — re-check staleness */
  if (documents.get(uri)?.version !== version) return;

  vulnFixesByUri.set(uri, vulnFixes);

  connection.sendDiagnostics({ uri, diagnostics });
}

// ---------- code actions ----------

function bumpEdit(
  f: Pick<DepFinding, 'current' | 'latest' | 'range'>,
  version = f.latest,
): TextEdit {
  const prefix = /^[\^~]/.exec(f.current)?.[0] ?? '';
  return { range: f.range, newText: `${prefix}${version}` };
}

connection.onCodeAction((params) => {
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);
  const cachedFindings = findingsByUri.get(uri) ?? [];
  const cachedVulnFixes = vulnFixesByUri.get(uri) ?? [];
  if (!doc || (!cachedFindings.length && !cachedVulnFixes.length)) return [];

  /* findings were located against the text as of the last validation; the
     document may have changed since (a previous bump, typing). Re-locate
     each version string in the CURRENT text and drop findings that no
     longer exist, so edits can never splice stale offsets. Each fresh site
     is claimed by at most one finding — a name appearing in two sections
     with the same range must not collapse onto one site once the other is
     bumped, or "update all" would emit overlapping edits. `cachedRange` is
     kept because params.context.diagnostics still carries the old ranges */
  const freshSites = findVersionRanges(doc, collectDeps(doc.getText()));
  const relocate = <T extends { name: string; current: string; range: Range }>(
    cached: T[],
  ): Array<T & { cachedRange: Range }> => {
    const claimed = new Set<number>();
    return cached.flatMap((f) => {
      let best = -1;
      let bestDist = Infinity;
      freshSites.forEach((s, i) => {
        if (claimed.has(i) || s.name !== f.name || s.current !== f.current) {
          return;
        }
        const dist = Math.abs(s.range.start.line - f.range.start.line);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      if (best < 0) return [];
      claimed.add(best);
      return [{ ...f, range: freshSites[best].range, cachedRange: f.range }];
    });
  };
  const findings = relocate(cachedFindings);
  const vulnFixes = relocate(cachedVulnFixes);

  const editFor = (edits: TextEdit[]): WorkspaceEdit =>
    supportsDocumentChanges
      ? {
          /* null version = "unknown": relocation above is the real staleness
             guard, so don't make the client drop the edit over a keystroke */
          documentChanges: [{ textDocument: { uri, version: null }, edits }],
        }
      : { changes: { [uri]: edits } };

  const actions: CodeAction[] = [];

  const overlapsCursor = (f: { range: Range }) =>
    f.range.start.line <= params.range.end.line &&
    f.range.end.line >= params.range.start.line;

  const fixLabel = (f: VulnFix) =>
    f.advisoryCount === 1
      ? 'fixes the vulnerability'
      : `fixes all ${f.advisoryCount} vulnerabilities`;

  const vulnInRange = vulnFixes.filter(overlapsCursor);

  /* a vuln fix matching a tier version would duplicate that tier's action —
     skip it here; the tier action below carries the fix label instead */
  for (const f of vulnInRange) {
    const shadowedByBump = findings.some(
      (b) =>
        b.name === f.name &&
        b.range.start.line === f.range.start.line &&
        b.tiers.some((t) => t.version === f.latest),
    );
    if (shadowedByBump) continue;
    actions.push({
      title: `Update ${f.name} to ${f.latest} (${fixLabel(f)})`,
      kind: CodeActionKind.QuickFix,
      diagnostics: params.context.diagnostics.filter(
        (d) =>
          d.source === 'package-bump' &&
          d.code !== undefined &&
          d.range.start.line === f.cachedRange.start.line &&
          d.range.start.character === f.cachedRange.start.character,
      ),
      edit: editFor([bumpEdit(f)]),
    });
  }

  const inRange = findings.filter(overlapsCursor);

  for (const f of inRange) {
    const attached = params.context.diagnostics.filter(
      (d) =>
        d.source === 'package-bump' &&
        (d.data as { name?: string } | undefined)?.name === f.name &&
        d.range.start.line === f.cachedRange.start.line &&
        d.range.start.character === f.cachedRange.start.character,
    );
    const vulnFix = vulnInRange.find(
      (v) =>
        v.name === f.name && v.range.start.line === f.range.start.line,
    );
    /* highest tier first so "update to latest" leads the menu */
    for (const t of [...f.tiers].reverse()) {
      actions.push({
        title:
          vulnFix && vulnFix.latest === t.version
            ? `Update ${f.name} to ${t.version} (${t.level}, ${fixLabel(vulnFix)})`
            : `Update ${f.name} to ${t.version} (${t.level})`,
        kind: CodeActionKind.QuickFix,
        diagnostics: attached,
        edit: editFor([bumpEdit(f, t.version)]),
      });
    }
  }

  if (findings.length > 1) {
    actions.push({
      title: `Update all ${findings.length} outdated packages`,
      kind: CodeActionKind.SourceFixAll,
      edit: editFor(findings.map((f) => bumpEdit(f))),
    });
  }

  return actions;
});

// ---------- lifecycle ----------

connection.onInitialize((params) => {
  applySettings(params.initializationOptions);
  supportsDocumentChanges =
    params.capabilities.workspace?.workspaceEdit?.documentChanges === true;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll],
      },
    },
  };
});

connection.onDidChangeConfiguration((change) => {
  applySettings(change.settings);
  for (const doc of documents.all()) scheduleValidation(doc);
});

documents.onDidOpen((e) => scheduleValidation(e.document));
documents.onDidChangeContent((e) => scheduleValidation(e.document));
documents.onDidClose((e) => {
  findingsByUri.delete(e.document.uri);
  vulnFixesByUri.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
