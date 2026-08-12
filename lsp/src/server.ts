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
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const REGISTRY_URL = 'https://registry.npmjs.org';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT = 8;

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/* ranges we know how to bump: optional ^/~ prefix + full semver */
const UPDATABLE_RE = /^([\^~]?)(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?$/;

interface DepFinding {
  name: string;
  current: string;
  latest: string;
  /* range of the version string between the quotes */
  range: Range;
}

interface CacheEntry {
  latest: string | null;
  ts: number;
}

const latestCache = new Map<string, CacheEntry>();

/* complete: "eslint: 9.39.4 → 10.8.1 (major)"
   compact:  "→ 10.8.1 (major)"
   level:    "major" */
type MessageStyle = 'complete' | 'compact' | 'level';
let messageStyle: MessageStyle = 'complete';

function applySettings(settings: unknown): void {
  const style = (settings as { message_style?: string } | undefined)
    ?.message_style;
  if (style === 'complete' || style === 'compact' || style === 'level') {
    messageStyle = style;
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

function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) > (pb[i] as number);
  }
  return comparePre(pa[3], pb[3]) > 0;
}

type BumpLevel = 'major' | 'minor' | 'patch';

function bumpLevel(current: string, latest: string): BumpLevel {
  const pc = parseSemver(current);
  const pl = parseSemver(latest);
  if (!pc || !pl) return 'patch';
  if (pl[0] !== pc[0]) return 'major';
  if (pl[1] !== pc[1]) return 'minor';
  return 'patch';
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

async function fetchLatest(name: string): Promise<string | null> {
  const cached = latestCache.get(name);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.latest;

  let latest: string | null = null;
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
      };
      latest = body['dist-tags']?.latest ?? null;
    }
  } catch {
    /* network failure → no diagnostic, retry after TTL */
  }
  latestCache.set(name, { latest, ts: Date.now() });
  return latest;
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
  const latestByName = new Map<string, string | null>();
  await mapLimit(uniqueNames, MAX_CONCURRENT, async (name) => {
    latestByName.set(name, await fetchLatest(name));
  });

  /* document changed while fetching → stale ranges, rerun happens via debounce */
  const fresh = documents.get(uri);
  if (!fresh || fresh.version !== version) return;

  const findings: DepFinding[] = [];
  for (const site of sites) {
    const latest = latestByName.get(site.name);
    if (!latest) continue;
    const bare = site.current.replace(/^[\^~]/, '');
    if (semverGt(latest, bare)) {
      findings.push({ ...site, latest });
    }
  }
  findingsByUri.set(uri, findings);

  const diagnostics: Diagnostic[] = findings.map((f) => {
    const bare = f.current.replace(/^[\^~]/, '');
    const level = bumpLevel(bare, f.latest);
    const message =
      messageStyle === 'level'
        ? level
        : messageStyle === 'compact'
          ? `→ ${f.latest} (${level})`
          : `${f.name}: ${bare} → ${f.latest} (${level})`;
    return {
      range: f.range,
      severity: SEVERITY_BY_LEVEL[level],
      source: 'package-bump',
      message,
      data: { name: f.name, latest: f.latest },
    };
  });

  connection.sendDiagnostics({ uri, diagnostics });
}

// ---------- code actions ----------

function bumpEdit(f: DepFinding): TextEdit {
  const prefix = /^[\^~]/.exec(f.current)?.[0] ?? '';
  return { range: f.range, newText: `${prefix}${f.latest}` };
}

connection.onCodeAction((params) => {
  const uri = params.textDocument.uri;
  const findings = findingsByUri.get(uri);
  if (!findings?.length) return [];

  const actions: CodeAction[] = [];

  const inRange = findings.filter(
    (f) =>
      f.range.start.line <= params.range.end.line &&
      f.range.end.line >= params.range.start.line,
  );

  for (const f of inRange) {
    actions.push({
      title: `Update ${f.name} to ${f.latest}`,
      kind: CodeActionKind.QuickFix,
      diagnostics: params.context.diagnostics.filter(
        (d) =>
          d.source === 'package-bump' &&
          (d.data as { name?: string } | undefined)?.name === f.name &&
          d.range.start.line === f.range.start.line &&
          d.range.start.character === f.range.start.character,
      ),
      edit: { changes: { [uri]: [bumpEdit(f)] } },
    });
  }

  if (findings.length > 1) {
    actions.push({
      title: `Update all ${findings.length} outdated packages`,
      kind: CodeActionKind.SourceFixAll,
      edit: { changes: { [uri]: findings.map(bumpEdit) } },
    });
  }

  return actions;
});

// ---------- lifecycle ----------

connection.onInitialize((params) => {
  applySettings(params.initializationOptions);
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
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
