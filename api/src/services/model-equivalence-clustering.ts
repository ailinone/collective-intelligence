// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model equivalence index: the pure, cooperative core of
 * model-equivalence-service.ts's buildIndex().
 *
 * Two catalog rows are equivalent only when they are the SAME model: one
 * provider's listing of it and another's, or two spellings of its name. The
 * index groups rows by exact equality of equivalenceKey(); there is no
 * similarity score anywhere.
 *
 * Why (2026-09-24): the previous index clustered rows by the average cosine
 * similarity of hashed character n-grams (first fit, threshold 0.85). A version
 * or size token changes only the few n-grams around it, so different models
 * scored 0.86-0.92 and were merged. Measured on the production catalog (118,439
 * active rows): claude-sonnet-4-6 with 4-5 and 4 (group "claude-sonnet", 90
 * rows), llama-3.3-70b-instruct with Llama 3 and a third-party Llama 3
 * fine-tune, gpt-oss-120b with gpt-oss-20b in 11 groups, gemini-2.5-flash with
 * flash-lite and flash-image, and 214 different owners' llama-2-7b-miniguanaco
 * repositories in one 452-member group (the owner was dropped before
 * comparing). 7,120 groups held more than one model name.
 *
 * The key (equivalenceKey), for a model id split on "/":
 *   1. Route prefixes are removed: leading segments that name a catalog
 *      provider and still have a whole "owner/name" id behind them
 *      ("deepinfra/openai/gpt-oss-120b", "anthropic/pioneer/...",
 *      "together_ai/moonshotai/..."). A segment names a provider when its
 *      letters and digits equal those of a provider id present in the catalog
 *      ("x-ai" is "xai", "together_ai" is "togetherai"). Data-derived: no
 *      vendor list.
 *   2. One segment left: an API model name (see "Model names" below).
 *   3. "owner/name" left: the owner joins the bare name only when the catalog
 *      shows it is that name's namespace:
 *        a. the owner is a provider that serves the name itself: it lists the
 *           name with no namespace, or (API sources) under a namespace that is
 *           not its own ("openai/tts-1": openai lists "tts-1"; "phala/
 *           gpt-oss-20b": phala lists "openai/gpt-oss-20b"; "fireworks_ai/
 *           gpt-oss-120b": fireworks-ai lists "accounts/fireworks/models/
 *           gpt-oss-120b"). A listing under the provider's own namespace
 *           ("deepgram/zeus" by deepgram) is how it names its own products,
 *           not evidence that it serves another vendor's model; or
 *        b. the owner is the name's publisher (see below):
 *           "meta-llama/Llama-3.3-70B-Instruct" meets "llama-3.3-70b-instruct".
 *      Otherwise the owner stays in the key, so a provider's own product with
 *      a common name ("inworld/tts-1", "deepgram/zeus", "trustedrouter/zeus",
 *      "openrouter/auto") never meets another vendor's model of that name. A
 *      provider owner is kept by its letters and digits ("x-ai/" is "xai/").
 *   4. Anything else is a repository identity: the remaining path, case
 *      folded, with nothing else removed. Repository hosts distinguish
 *      "naruto_lora_xl" from "naruto-lora-xl" and "...-latest" from "...", and
 *      two owners' copies of one name are two models.
 *
 * Model names: normalizeModelName() folds case and "." / "_" / whitespace
 * separators, and removes snapshot date stamps in the shapes providers use
 * (-YYYY-MM-DD, -YYYYMMDD, @YYYYMMDD, a trailing -MM-YYYY) and a trailing
 * "-latest" alias. Every other token is significant, so versions (4-6 vs 4-5,
 * 3-3 vs 3-1), sizes (120b vs 20b) and variants (lite, mini, image, pro, turbo,
 * preview, -vN, :free, @region) always give different keys. A snapshot stamp
 * joins the undated name only when it is the ONLY snapshot of that name in the
 * catalog (data-derived): "claude-sonnet-4-5-20250929" is claude-sonnet-4-5,
 * but claude-3-5-sonnet-20240620 and -20241022 are two models, so each keeps
 * its stamp ("claude-3-5-sonnet@20240620") and the undated alias and "-latest"
 * form their own group. Providers publish such pairs as distinct models
 * (openai lists gpt-4o-mini-tts-2025-03-20 and -2025-12-15).
 *
 * Publisher of a name (data-derived, no vendor list): among rows from API
 * sources (sourceType native_api, cloud_hub or router; aggregators such as the
 * HuggingFace hub list repositories by owner, which is not evidence of who
 * publishes a name), the namespace listed with that name by strictly more
 * providers than any other namespace, only when some row lists the name with
 * no namespace at all. A provider namespace that does not serve the name (its
 * own product, or a route) also needs two providers listing it: one listing
 * of "deepgram/flux" does not make Deepgram's Flux the "flux" of another
 * vendor. Namespaces of providers that serve the name (3a) already are the
 * bare name and do not compete, so "deepseek-ai/DeepSeek-V4-Pro" meets
 * "deepseek-v4-pro" although "deepseek/deepseek-v4-pro" has more providers.
 * At most one namespace that does not serve the name ever joins it, so two
 * repository owners never share a group. Known limit: a bare name is one
 * model for every provider that lists it bare, even when each means its own
 * product (four routers list a bare "auto"); the id alone cannot tell them
 * apart.
 *
 * The result does not depend on row order (the catalog query has no ORDER
 * BY): members are sorted by source tier (native_api, cloud_hub, router,
 * aggregator, other) then uid.
 *
 * Cost: linear. Passes over the rows (provider ids, namespace evidence,
 * snapshots, keys), one over the namespaced names (publishers) and one over the
 * groups (member sort), each checkpointing every 1,024 items. The work is
 * time-sliced: once `sliceMs` (default 8 ms) has passed, the next checkpoint
 * yields with setImmediate and checks an AbortSignal; the wall-clock deadline
 * is checked at every checkpoint. On the 2026-09-24 production export (118,439
 * rows) a build takes 1.5 to 2.5 s of wall time (3 to 4 s of CPU with GC),
 * against about 170 s of CPU for the n-gram clustering it replaces. Lookups are
 * a map read for an indexed id and one key computation (a few microseconds) for
 * any other id.
 */

const DEFAULT_SLICE_MS = 8;
/** Items processed between two cooperative checkpoints (a power of two). */
const CHECKPOINT_EVERY = 1024;
const CHECKPOINT_MASK = CHECKPOINT_EVERY - 1;
/**
 * A provider namespace that does not serve the name itself (its own product,
 * or a route) is its publisher only with this many providers listing it.
 */
const MIN_PROVIDER_PUBLISHER_LISTINGS = 2;

/**
 * Source types whose namespaces are evidence of who publishes a model name.
 * The values of the SourceType schema enum minus 'aggregator'.
 */
const API_SOURCE_TYPES: ReadonlySet<string> = new Set(['native_api', 'cloud_hub', 'router']);

/** Member order inside a group: native providers first, then hubs and routers. */
const SOURCE_TIER: Readonly<Record<string, number>> = {
  native_api: 0,
  cloud_hub: 1,
  router: 2,
  aggregator: 3,
};
const OTHER_SOURCE_TIER = 9;

// Snapshot date stamps, only in the shapes providers use, and only as whole
// tokens (followed by the end, "-", ":" or "@"): "-2025-04-14", "-20250514",
// "@20250929" (Vertex), and a trailing "-03-2025".
const DAY_STAMP =
  /(?:-(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])|[-@](20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01]))(?=$|[-:@])/g;
const MONTH_STAMP = /-(0[1-9]|1[0-2])-(20\d\d)$/;
const LATEST_ALIAS = /-latest$/;
const SEPARATORS = /[._\s]+/g;
const REPEATED_DASHES = /-{2,}/g;
const NON_ALPHANUMERIC = /[^a-z0-9]/g;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface EquivalenceMember {
  uid: string;
  modelId: string;
  providerId: string;
  provider: string;
  sourceType: string;
}

export interface EquivalenceGroup {
  /** The equivalence key shared by every member. */
  groupId: string;
  /** Model id of the first member (native provider first). */
  canonicalName: string;
  members: EquivalenceMember[];
}

export interface EquivalenceSourceRow {
  uid: string;
  modelId: string;
  providerId: string;
  provider: string;
  sourceType: string;
}

/** Read-only membership test (a Set, or a view over several). */
export interface NameSet {
  has(value: string): boolean;
}

/** Read-only lookup (a Map, or a view over several). */
export interface NameLookup<V> {
  get(key: string): V | undefined;
}

/** What equivalenceKey() needs to know about the catalog. */
export interface EquivalenceKeyContext {
  /** Provider ids present in the catalog, sorted, as the catalog spells them. */
  readonly providerIds: readonly string[];
  /** namespaceToken() of every provider id. */
  readonly providerTokens: ReadonlySet<string>;
  /** `${namespaceToken(providerId)}/${name}` for every name a provider lists with no namespace. */
  readonly hostedNames: NameSet;
  /** normalizeModelName() of a model name -> the owner namespace that joins it (see the header). */
  readonly publisherOfName: ReadonlyMap<string, string>;
  /** normalizeModelName() of a model name -> its only snapshot stamp, or null when it has several. */
  readonly snapshotOfName: NameLookup<string | null>;
}

/** A model name split into its undated form and its snapshot stamp. */
export interface ParsedModelName {
  /** normalizeModelName(): no stamp, no "-latest". */
  base: string;
  /** Canonical stamp ("20250929", "202503" for -03-2025), "" when undated. */
  stamp: string;
}

export interface EquivalenceBuildStats {
  rows: number;
  /** Distinct raw model ids. */
  distinctIds: number;
  /** Distinct keys (= groups). */
  keys: number;
  /** Key resolutions: one per distinct raw id. */
  keyComputations: number;
  providers: number;
  publishers: number;
  /** Names whose snapshots keep their stamp (two or more snapshots in the catalog). */
  multiSnapshotNames: number;
  yields: number;
}

export interface EquivalenceIndex {
  /** Key -> group. Every member of a group has that key. */
  groups: Map<string, EquivalenceGroup>;
  /** Raw model id -> key, for every indexed id. */
  modelToKey: Map<string, string>;
  /** The context the keys were computed with (published with the groups). */
  context: EquivalenceKeyContext;
  /** Rows indexed. */
  models: number;
  stats: EquivalenceBuildStats;
}

export interface EquivalenceBuildOptions {
  /** Aborts the build at the next yield (graceful shutdown). */
  signal?: AbortSignal;
  /** `now()` value after which the build stops at the next checkpoint. */
  deadlineAt?: number;
  /**
   * Time after which the next checkpoint (every 1,024 items) yields to the
   * event loop, in ms; 0 yields at every checkpoint.
   */
  sliceMs?: number;
  /** Monotonic clock in ms; performance.now() when omitted (tests inject one). */
  now?: () => number;
}

export type EquivalenceBuildStopReason = 'aborted' | 'deadline';

export class EquivalenceBuildStoppedError extends Error {
  readonly reason: EquivalenceBuildStopReason;

  constructor(reason: EquivalenceBuildStopReason) {
    super(
      reason === 'deadline'
        ? 'Model equivalence build exceeded its wall-clock budget'
        : 'Model equivalence build aborted'
    );
    this.name = 'EquivalenceBuildStoppedError';
    this.reason = reason;
  }
}

// ─── Key grammar ───────────────────────────────────────────────────────────

/** Letters and digits of a namespace, lowercase: how it is compared with a provider id. */
export function namespaceToken(segment: string): string {
  return segment.toLowerCase().replace(NON_ALPHANUMERIC, '');
}

/**
 * Split a model name into its undated normalized form and its snapshot stamp:
 * case and "." / "_" / whitespace separators are folded, snapshot date stamps
 * and a trailing "-latest" alias removed; nothing else, and the token order is
 * kept. "Claude-Sonnet-4.5-20250929" -> { base: "claude-sonnet-4-5", stamp: "20250929" }.
 */
export function parseModelName(name: string): ParsedModelName {
  let folded = name.trim().toLowerCase().replace(SEPARATORS, '-').replace(REPEATED_DASHES, '-');
  // Runs are collapsed above, so at most one dash sits at each edge.
  if (folded.startsWith('-')) folded = folded.slice(1);
  if (folded.endsWith('-')) folded = folded.slice(0, -1);
  const stamps: string[] = [];
  let base = folded.replace(
    DAY_STAMP,
    (
      _match: string,
      year: string | undefined,
      month: string | undefined,
      day: string | undefined,
      compactYear: string,
      compactMonth: string,
      compactDay: string
    ) => {
      stamps.push(
        year !== undefined && month !== undefined && day !== undefined
          ? `${year}${month}${day}`
          : `${compactYear}${compactMonth}${compactDay}`
      );
      return '';
    }
  );
  const monthYear = MONTH_STAMP.exec(base);
  if (monthYear) {
    stamps.push(`${monthYear[2]}${monthYear[1]}`);
    base = base.slice(0, monthYear.index);
  }
  return { base: base.replace(LATEST_ALIAS, ''), stamp: stamps.join('+') };
}

/**
 * API-name normalization: case, "." / "_" / whitespace separators, snapshot
 * date stamps and a trailing "-latest" alias. Nothing else is removed and the
 * token order is kept. "Claude-Sonnet-4.5-20250929" -> "claude-sonnet-4-5".
 */
export function normalizeModelName(name: string): string {
  return parseModelName(name).base;
}

/** How many leading segments are route prefixes (a provider followed by a whole "owner/name"). */
function routePrefixCount(
  segments: readonly string[],
  providerTokens: ReadonlySet<string>
): number {
  let count = 0;
  while (segments.length - count >= 3 && providerTokens.has(namespaceToken(segments[count]))) {
    count++;
  }
  return count;
}

/** Owner identity used by the publisher election and the key: a provider by its token. */
function ownerIdentity(owner: string, providerTokens: ReadonlySet<string>): string {
  const token = namespaceToken(owner);
  return providerTokens.has(token) ? token : owner.toLowerCase();
}

/**
 * `${providerToken}/${name}` when this listing shows the provider serving the
 * model name itself: with no namespace, or (API sources) under a namespace
 * that is not the provider's own ("openai/gpt-oss-20b" listed by phala, or
 * "accounts/fireworks/models/gpt-oss-120b" listed by fireworks-ai). A listing
 * under the provider's own namespace ("deepgram/zeus" by deepgram) is not:
 * that is how providers name their own products. Null otherwise.
 */
function hostedEntry(
  modelId: string,
  providerToken: string,
  sourceType: string,
  nameOf: (raw: string) => string
): string | null {
  const id = modelId.trim();
  const slash = id.lastIndexOf('/');
  if (slash < 0) return `${providerToken}/${nameOf(id)}`;
  if (!API_SOURCE_TYPES.has(sourceType)) return null;
  const namespace = id.slice(id.lastIndexOf('/', slash - 1) + 1, slash);
  if (namespaceToken(namespace) === providerToken) return null;
  return `${providerToken}/${nameOf(id.slice(slash + 1))}`;
}

/**
 * A context from catalog evidence (tests, and getAllEntriesForModel's
 * fallback). With provider ids only, a namespaced id meets the bare name only
 * as a route prefix, and every snapshot keeps its stamp.
 */
export function createEquivalenceKeyContext(
  providerIds: Iterable<string>,
  evidence: {
    hostedNames?: NameSet;
    publisherOfName?: ReadonlyMap<string, string>;
    snapshotOfName?: NameLookup<string | null>;
  } = {}
): EquivalenceKeyContext {
  const ids = [...new Set(providerIds)].sort();
  return {
    providerIds: ids,
    providerTokens: new Set(ids.map(namespaceToken)),
    hostedNames: evidence.hostedNames ?? new Set<string>(),
    publisherOfName: evidence.publisherOfName ?? new Map<string, string>(),
    snapshotOfName: evidence.snapshotOfName ?? new Map<string, string | null>(),
  };
}

/** Record one snapshot stamp of `name`: the stamp while it is the only one, then null. */
function recordSnapshot(snapshots: Map<string, string | null>, name: string, stamp: string): void {
  const known = snapshots.get(name);
  if (known === undefined) snapshots.set(name, stamp);
  else if (known !== null && known !== stamp) snapshots.set(name, null);
}

/**
 * `context` plus the evidence of some catalog rows that may postdate it (the
 * rows getAllEntriesForModel's fallback query returns): their bare listings
 * host their names, and their snapshot stamps count. Views, nothing is copied.
 */
export function withListingEvidence(
  context: EquivalenceKeyContext,
  rows: ReadonlyArray<{ modelId: string; providerId: string; sourceType: string }>
): EquivalenceKeyContext {
  const hosted = new Set<string>();
  for (const row of rows) {
    const entry = hostedEntry(
      row.modelId,
      namespaceToken(row.providerId),
      row.sourceType,
      normalizeModelName
    );
    if (entry !== null) hosted.add(entry);
  }
  const hostedNames: NameSet = {
    has: (value) => hosted.has(value) || context.hostedNames.has(value),
  };
  const withHosts: EquivalenceKeyContext = { ...context, hostedNames };
  const local = new Map<string, string | null>();
  for (const row of rows) {
    const resolved = resolveId(row.modelId, withHosts);
    if (typeof resolved === 'string' || resolved.stamp === '') continue;
    const known = context.snapshotOfName.get(resolved.base);
    if (known !== undefined && !local.has(resolved.base)) local.set(resolved.base, known);
    recordSnapshot(local, resolved.base, resolved.stamp);
  }
  const snapshotOfName: NameLookup<string | null> = {
    get: (name) => (local.has(name) ? local.get(name) : context.snapshotOfName.get(name)),
  };
  return { ...withHosts, snapshotOfName };
}

/**
 * The model id without its leading provider namespaces, in its original
 * spelling: "deepinfra/openai/gpt-oss-120b" -> "gpt-oss-120b". Only for
 * building candidate spellings; equivalenceKey() decides what is the same model.
 */
export function withoutProviderNamespaces(modelId: string, context: EquivalenceKeyContext): string {
  const segments = modelId.trim().split('/');
  let start = 0;
  while (
    segments.length - start >= 2 &&
    context.providerTokens.has(namespaceToken(segments[start]))
  ) {
    start++;
  }
  return start === 0 ? modelId.trim() : segments.slice(start).join('/');
}

/**
 * Steps 1-4 of the key (see the header): the model name when the id resolves
 * to an API model name, else the repository-style key.
 */
function resolveId(modelId: string, context: EquivalenceKeyContext): ParsedModelName | string {
  const segments = modelId.trim().split('/');
  const start = routePrefixCount(segments, context.providerTokens);
  const remaining = segments.length - start;
  if (remaining === 1) return parseModelName(segments[start]);
  if (remaining === 2) {
    const owner = segments[start];
    const leaf = segments[start + 1];
    const parsed = parseModelName(leaf);
    const token = namespaceToken(owner);
    const isProvider = context.providerTokens.has(token);
    if (isProvider && context.hostedNames.has(`${token}/${parsed.base}`)) return parsed;
    const identity = isProvider ? token : owner.toLowerCase();
    if (context.publisherOfName.get(parsed.base) === identity) return parsed;
    if (isProvider) return `${token}/${leaf.toLowerCase()}`;
  }
  return segments.slice(start).join('/').toLowerCase();
}

/** Key of a resolved model name: undated unless the catalog has another snapshot of it. */
function nameKey(parsed: ParsedModelName, context: EquivalenceKeyContext): string {
  if (parsed.stamp === '' || context.snapshotOfName.get(parsed.base) === parsed.stamp) {
    return parsed.base;
  }
  return `${parsed.base}@${parsed.stamp}`;
}

/**
 * Canonical identity of a model id (see the header). Two ids have the same key
 * only when they name the same model.
 */
export function equivalenceKey(modelId: string, context: EquivalenceKeyContext): string {
  const resolved = resolveId(modelId, context);
  return typeof resolved === 'string' ? resolved : nameKey(resolved, context);
}

/**
 * Key of `modelId` when the index has a group for it, else null. The returned
 * group holds only rows whose key equals the requested id's key: an indexed
 * raw id is O(1), any other spelling costs one key computation. There is no
 * nearest-match fallback: an id the index does not know gets null.
 */
export function resolveEquivalenceKey(index: EquivalenceIndex, modelId: string): string | null {
  const key = index.modelToKey.get(modelId) ?? equivalenceKey(modelId, index.context);
  return index.groups.has(key) ? key : null;
}

// ─── Cooperative scheduling ────────────────────────────────────────────────

class CooperativeClock {
  yields = 0;
  private readonly now: () => number;
  private readonly signal: AbortSignal | undefined;
  private readonly deadlineAt: number | undefined;
  private readonly sliceMs: number;
  private sliceStart: number;

  constructor(options: EquivalenceBuildOptions) {
    this.now = options.now ?? (() => performance.now());
    this.signal = options.signal;
    this.deadlineAt = options.deadlineAt;
    this.sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    this.sliceStart = this.now();
  }

  throwIfStopped(now: number = this.now()): void {
    if (this.signal?.aborted) throw new EquivalenceBuildStoppedError('aborted');
    if (this.deadlineAt !== undefined && now >= this.deadlineAt) {
      throw new EquivalenceBuildStoppedError('deadline');
    }
  }

  /**
   * Call every CHECKPOINT_EVERY items. Checks the deadline every time (one
   * clock read), and yields once the current slice is used up, then checks the
   * abort signal, which only changes while the event loop runs.
   */
  async checkpoint(): Promise<void> {
    const now = this.now();
    if (this.deadlineAt !== undefined && now >= this.deadlineAt) {
      throw new EquivalenceBuildStoppedError('deadline');
    }
    if (now - this.sliceStart < this.sliceMs) return;
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    this.yields++;
    const resumedAt = this.now();
    this.throwIfStopped(resumedAt);
    this.sliceStart = resumedAt;
  }
}

// ─── Build ─────────────────────────────────────────────────────────────────

function compareMembers(a: EquivalenceMember, b: EquivalenceMember): number {
  const tier =
    (SOURCE_TIER[a.sourceType] ?? OTHER_SOURCE_TIER) -
    (SOURCE_TIER[b.sourceType] ?? OTHER_SOURCE_TIER);
  if (tier !== 0) return tier;
  if (a.uid === b.uid) return 0;
  return a.uid < b.uid ? -1 : 1;
}

/**
 * Build the index for `rows` (any order). Rejects with
 * EquivalenceBuildStoppedError when the signal aborts or the deadline passes;
 * never mutates shared state.
 */
export async function buildEquivalenceIndex(
  rows: readonly EquivalenceSourceRow[],
  options: EquivalenceBuildOptions = {}
): Promise<EquivalenceIndex> {
  const clock = new CooperativeClock(options);
  clock.throwIfStopped();
  const n = rows.length;

  // 1. Provider ids present in the catalog.
  const providerIdSet = new Set<string>();
  for (let i = 0; i < n; i++) {
    if ((i & CHECKPOINT_MASK) === 0) await clock.checkpoint();
    providerIdSet.add(rows[i].providerId);
  }
  const providerIds = [...providerIdSet].sort();
  const providerTokens = new Set(providerIds.map(namespaceToken));

  // 2. Namespace evidence: names listed with no namespace, the names each
  //    provider serves itself (hostedEntry), and per name the providers (API
  //    sources only) that list it under each owner namespace.
  const normalizedNames = new Map<string, string>();
  const nameOf = (raw: string): string => {
    let name = normalizedNames.get(raw);
    if (name === undefined) {
      name = normalizeModelName(raw);
      normalizedNames.set(raw, name);
    }
    return name;
  };
  const bareNames = new Set<string>();
  const hostedNames = new Set<string>();
  const coverage = new Map<string, Map<string, Set<string>>>();
  for (let i = 0; i < n; i++) {
    if ((i & CHECKPOINT_MASK) === 0) await clock.checkpoint();
    const row = rows[i];
    const id = row.modelId.trim();
    const hosted = hostedEntry(id, namespaceToken(row.providerId), row.sourceType, nameOf);
    if (hosted !== null) hostedNames.add(hosted);
    if (!id.includes('/')) {
      bareNames.add(nameOf(id));
      continue;
    }
    if (!API_SOURCE_TYPES.has(row.sourceType)) continue;
    const segments = id.split('/');
    const start = routePrefixCount(segments, providerTokens);
    if (segments.length - start !== 2) continue;
    const owner = segments[start];
    if (owner.trim() === '') continue;
    const name = nameOf(segments[start + 1]);
    const identity = ownerIdentity(owner, providerTokens);
    let owners = coverage.get(name);
    if (!owners) {
      owners = new Map<string, Set<string>>();
      coverage.set(name, owners);
    }
    let providers = owners.get(identity);
    if (!providers) {
      providers = new Set<string>();
      owners.set(identity, providers);
    }
    providers.add(row.providerId);
  }
  normalizedNames.clear();

  // 3. Publishers: the strict coverage maximum among the namespaces that are
  //    not already the bare name (providers serving it, 3a), only for names
  //    that are also listed bare. A provider owner's identity is its token, so
  //    hostedNames tells whether it serves the name; a provider namespace that
  //    does not (its own product, or a route) needs two providers listing it.
  const publisherOfName = new Map<string, string>();
  let visited = 0;
  for (const [name, owners] of coverage) {
    if ((visited++ & CHECKPOINT_MASK) === 0) await clock.checkpoint();
    if (!bareNames.has(name)) continue;
    let best: string | null = null;
    let bestCount = 0;
    let secondCount = 0;
    for (const [identity, providers] of owners) {
      if (providerTokens.has(identity) && hostedNames.has(`${identity}/${name}`)) continue;
      const count = providers.size;
      if (count > bestCount) {
        secondCount = bestCount;
        bestCount = count;
        best = identity;
      } else if (count > secondCount) {
        secondCount = count;
      }
    }
    if (best === null || bestCount === secondCount) continue;
    if (providerTokens.has(best) && bestCount < MIN_PROVIDER_PUBLISHER_LISTINGS) continue;
    publisherOfName.set(name, best);
  }
  coverage.clear();
  bareNames.clear();
  const snapshotOfName = new Map<string, string | null>();
  const context: EquivalenceKeyContext = {
    providerIds,
    providerTokens,
    hostedNames,
    publisherOfName,
    snapshotOfName,
  };

  // 4. Resolve every distinct id (steps 1-4 of the key) and count the distinct
  //    snapshot stamps of every resolved model name.
  const resolvedIds = new Map<string, ParsedModelName | string>();
  for (let i = 0; i < n; i++) {
    if ((i & CHECKPOINT_MASK) === 0) await clock.checkpoint();
    const id = rows[i].modelId;
    if (resolvedIds.has(id)) continue;
    const resolved = resolveId(id, context);
    resolvedIds.set(id, resolved);
    if (typeof resolved !== 'string' && resolved.stamp !== '') {
      recordSnapshot(snapshotOfName, resolved.base, resolved.stamp);
    }
  }

  // 5. Keys (one per distinct raw id) and groups.
  const modelToKey = new Map<string, string>();
  const groups = new Map<string, EquivalenceGroup>();
  let keyComputations = 0;
  for (let i = 0; i < n; i++) {
    if ((i & CHECKPOINT_MASK) === 0) await clock.checkpoint();
    const row = rows[i];
    let key = modelToKey.get(row.modelId);
    if (key === undefined) {
      const resolved = resolvedIds.get(row.modelId) ?? resolveId(row.modelId, context);
      key = typeof resolved === 'string' ? resolved : nameKey(resolved, context);
      keyComputations++;
      modelToKey.set(row.modelId, key);
    }
    const member: EquivalenceMember = {
      uid: row.uid,
      modelId: row.modelId,
      providerId: row.providerId,
      provider: row.provider,
      sourceType: row.sourceType,
    };
    const group = groups.get(key);
    if (group) group.members.push(member);
    else groups.set(key, { groupId: key, canonicalName: row.modelId, members: [member] });
  }
  resolvedIds.clear();

  // 6. Deterministic member order, whatever the row order was.
  visited = 0;
  for (const group of groups.values()) {
    if ((visited++ & CHECKPOINT_MASK) === 0) await clock.checkpoint();
    if (group.members.length > 1) {
      group.members.sort(compareMembers);
      group.canonicalName = group.members[0].modelId;
    }
  }

  let multiSnapshotNames = 0;
  for (const stamp of snapshotOfName.values()) if (stamp === null) multiSnapshotNames++;

  return {
    groups,
    modelToKey,
    context,
    models: n,
    stats: {
      rows: n,
      distinctIds: modelToKey.size,
      keys: groups.size,
      keyComputations,
      providers: providerIds.length,
      publishers: publisherOfName.size,
      multiSnapshotNames,
      yields: clock.yields,
    },
  };
}
