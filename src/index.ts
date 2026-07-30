interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Texas DMV MCP — statewide vehicle, pickup and motorcycle registration totals by fiscal
 * year, from TxDMV's own published series. Keyless.
 *
 * One pack per state agency: Texas publishes exactly one machine-readable registration
 * series and it is a single statewide row per fiscal year. That grain has nothing in common
 * with California's ZIP × make × fuel snapshot or Connecticut's vehicle-level EV file, so
 * Texas gets its own tool with arguments that are all real, instead of a union schema where
 * `county` and `zip` exist but are silently ignored.
 *
 * Source (verified live 2026-07-29):
 *   data.texas.gov Socrata cbmj-zeje — "Passenger Vehicle, Motorcycle, and Pickup Truck
 *   Registrations by Year", 21 rows covering fiscal years 2001 through 2021.
 *
 * The dataset was last refreshed 2023-03-06 and stops at FY2021, so `as_of` and a `note`
 * carry the vintage on every response rather than letting a caller read FY2021 as current.
 *
 * Every tool resolves to a shaped object and never throws; a query Texas cannot answer at
 * this grain comes back as { found: false, reason, hint } naming a state that can.
 */


const UA = 'pipeworx-mcp-tx-dmv/1.0 (+https://pipeworx.io)';
const DOMAIN = 'data.texas.gov';
const RESOURCE = 'cbmj-zeje';
const SOURCE = `data.texas.gov — TxDMV Passenger Vehicle, Motorcycle, and Pickup Truck Registrations by Year (${RESOURCE})`;

/** Published coverage, checked live. Stated positively so the routing text carries it. */
const FIRST_FISCAL_YEAR = 2001;
const LAST_FISCAL_YEAR = 2021;
const STALE_NOTE =
  `TxDMV last refreshed this series on 2023-03-06 and it ends at fiscal year ${LAST_FISCAL_YEAR}; ` +
  'treat every figure as a historical fiscal-year total rather than a current fleet count.';

/** Arguments that only a finer-grained state can honour. */
const GEO_ARGS = ['county', 'zip', 'city', 'make', 'model', 'model_year', 'fuel_type'];

interface TxRow {
  fiscal_year?: string;
  total_passenger_vehicles?: string;
  total_trucks_1_ton_or_less?: string;
  total_motorcycles?: string;
  total_all_vehicles_registered?: string;
  passenger_of_all_vehicles?: string;
  trucks_of_all_vehicles?: string;
  motorcycles_of_all_vehicles?: string;
}

/** Published ratios are fractions of 1; report them as percentages. */
function ratioPct(v: unknown): number | null {
  const n = govNumber(v);
  return n === null ? null : Math.round(n * 1000) / 10;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'tx_dmv_vehicle_registrations',
    description:
      'Count vehicles registered in Texas from the Texas DMV (TxDMV) registration series: total vehicles registered statewide in a fiscal year, split into passenger cars, pickup trucks of one ton or less, and motorcycles, each with its share of the fleet. Answers "how many vehicles are registered in Texas", "how many motorcycles are registered in Texas", "how many pickup trucks are registered in Texas", and growth questions across years such as how the Texas fleet changed from 2001 to 2021. TxDMV publishes this series as one statewide row per fiscal year, covering fiscal years 2001 through 2021, so every response reports its fiscal year and vintage. For a ZIP-code or county breakdown of a registered fleet, ca_dmv_vehicle_registrations covers California at ZIP × make × model-year × fuel grain.',
    inputSchema: {
      type: 'object',
      properties: {
        fiscal_year: {
          type: 'string',
          description: `Texas state fiscal year, ${FIRST_FISCAL_YEAR}–${LAST_FISCAL_YEAR}, e.g. "2021". Omit for the most recent years, newest first.`,
        },
        limit: {
          type: ['number', 'string'],
          description: 'Max fiscal years to return, newest first (default 10, max 21).',
        },
      },
    },
  },
];

async function vehicleRegistrations(args: Record<string, unknown>): Promise<unknown> {
  const unsupported = GEO_ARGS.filter((k) => govString(args, k));
  if (unsupported.length) {
    return govNotFound(
      'grain_unavailable',
      `TxDMV publishes this registration series as one statewide row per fiscal year, so ${unsupported.join(' and ')} cannot be applied. Call tx_dmv_vehicle_registrations with just fiscal_year for the Texas total; for a finer breakdown of a registered fleet, ca_dmv_vehicle_registrations covers California by ZIP, make, model year and fuel.`,
      { requested_filters: unsupported, texas_grain: 'statewide, one row per fiscal year' },
    );
  }

  // `fiscal_year` is the natural name; accept `year` too, because that is what callers type.
  const requested = govString(args, 'fiscal_year') ?? govString(args, 'year');
  if (requested && !/^\d{4}$/.test(requested)) {
    return govNotFound('bad_fiscal_year', `Pass a four-digit Texas fiscal year between ${FIRST_FISCAL_YEAR} and ${LAST_FISCAL_YEAR}, e.g. fiscal_year="2021".`, {
      requested_fiscal_year: requested,
    });
  }

  const limit = govLimit(args.limit, 10, LAST_FISCAL_YEAR - FIRST_FISCAL_YEAR + 1);
  const rows = await soqlRows<TxRow>(
    DOMAIN,
    RESOURCE,
    {
      where: requested ? `fiscal_year='${soqlEscape(requested)}'` : undefined,
      order: 'fiscal_year DESC',
      limit: requested ? 1 : limit,
    },
    { userAgent: UA },
  );

  if (!rows.length) {
    return govNotFound(
      'fiscal_year_unavailable',
      `TxDMV publishes fiscal years ${FIRST_FISCAL_YEAR}–${LAST_FISCAL_YEAR} in this series. Retry with one of those, or omit fiscal_year for the most recent years.`,
      {
        requested_fiscal_year: requested ?? null,
        available_fiscal_years: `${FIRST_FISCAL_YEAR}-${LAST_FISCAL_YEAR}`,
      },
    );
  }

  const shaped = rows.map((r) => ({
    fiscal_year: r.fiscal_year ?? null,
    vehicles: govNumber(r.total_all_vehicles_registered),
    passenger_vehicles: govNumber(r.total_passenger_vehicles),
    light_trucks: govNumber(r.total_trucks_1_ton_or_less),
    motorcycles: govNumber(r.total_motorcycles),
    passenger_share_pct: ratioPct(r.passenger_of_all_vehicles),
    light_trucks_share_pct: ratioPct(r.trucks_of_all_vehicles),
    motorcycles_share_pct: ratioPct(r.motorcycles_of_all_vehicles),
  }));

  return {
    state: 'TX',
    grain: requested
      ? `statewide registration totals for Texas fiscal year ${requested}`
      : 'statewide registration totals, one row per fiscal year, newest first',
    as_of: await soqlUpdatedAt(DOMAIN, RESOURCE, { userAgent: UA }),
    source: SOURCE,
    covers_fiscal_years: `${FIRST_FISCAL_YEAR}-${LAST_FISCAL_YEAR}`,
    // Each row is already the whole Texas fleet for its year, so a single-year request has a
    // genuine denominator. Rows from different years are cumulative snapshots of largely the
    // same vehicles, so they are deliberately not summed — a "sum of returned rows" across
    // fiscal years would double-count every car that stayed registered.
    ...(requested && shaped[0].vehicles !== null ? { total_vehicles: shaped[0].vehicles } : {}),
    returned_fiscal_years: shaped.length,
    truncated: !requested && shaped.length >= limit,
    rows: shaped,
    note: STALE_NOTE,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'tx_dmv_vehicle_registrations': return await vehicleRegistrations(args);
      default:
        return govNotFound('unknown_tool', `tx-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `tx-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'data.texas.gov timed out. Retry once, and lower `limit` or pass a single fiscal_year to reduce the work upstream.'
        : 'data.texas.gov refused the request or changed shape. Retry once; if it persists the dataset may have been republished under a new Socrata id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
