import * as dblurt from '@beblurt/dblurt';
import { Blockchain } from '../blockchain';

/**
 * module/player_blurt/sponsored-campaigns.ts
 *
 * Chain-data layer for the sponsored-content player plugin. No player/UI
 * knowledge lives here — just: fetch transfers to SPONSOR_ACCOUNT, parse
 * their memo as a campaign spec, compute BPS, and expose the currently
 * active ones. See sponsored-plugin.ts for how this is used.
 *
 * Memo contract (what an advertiser must send along with the BLURT transfer):
 *   {
 *     "url":   "https://youtu.be/xxxx",  // required, http(s) link
 *     "sec":   30,                        // required, seconds before forced skip (clamped 1-120)
 *     "start": "2025-10-10",              // required, ISO date (no time-of-day)
 *     "days":  3                          // optional, default 1, clamped 1-7
 *   }
 */

export interface SponsoredCampaign {
  /** Stable id derived from the transfer's account_history sequence number. */
  id: string;
  /** Blurt account that sent the transfer (i.e. who is sponsoring this ad). */
  from: string;
  url: string;
  /** Seconds the player forces before advancing, already clamped to [SEC_MIN, SEC_MAX]. */
  sec: number;
  /** Campaign start, ms epoch (UTC midnight of the given ISO date). */
  start: number;
  /** Campaign length in days, already clamped to [DAYS_MIN, DAYS_MAX]. */
  days: number;
  /** Campaign end, ms epoch. */
  end: number;
  /** Transfer amount in BLURT. */
  amount: number;
  /** amount / days / sec — the weight used for weighted-random selection. */
  bps: number;
}

const SPONSOR_ACCOUNT = 'dotevo'; // TODO: swap for a dedicated account once this is proven out
const WINDOW_DAYS = 14; // max 7 days delay + max 7 days duration
const SEC_MIN = 1;
const SEC_MAX = 120;
const DAYS_MIN = 1;
const DAYS_MAX = 7;
const PAGE_SIZE = 500;
const MAX_PAGES = 20; // safety cap (~10k ops) so a pathological history can't loop forever
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let cache: SponsoredCampaign[] = [];
let lastFetchedAt = 0;
let inFlight: Promise<SponsoredCampaign[]> | null = null;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * Parses a date-only ISO string ("YYYY-MM-DD") as UTC midnight. Deliberately
 * rejects anything with a time component — the campaign spec only needs
 * day-level precision.
 */
const parseIsoDate = (raw: unknown): number | null => {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
};

const parseMemo = (memo: string, amount: number, id: string, from: string): SponsoredCampaign | null => {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!from) return null;

  let data: any;
  try {
    data = JSON.parse(memo);
  } catch {
    return null; // not our format, silently ignore (could be a regular tip/transfer)
  }
  if (!data || typeof data !== 'object') return null;

  if (typeof data.url !== 'string' || !/^https?:\/\//i.test(data.url)) return null;

  const start = parseIsoDate(data.start);
  if (start === null) return null;

  const secRaw = Number(data.sec);
  if (!Number.isFinite(secRaw) || secRaw <= 0) return null;
  const sec = clamp(Math.round(secRaw), SEC_MIN, SEC_MAX);

  const daysRaw = data.days === undefined ? 1 : Number(data.days);
  if (!Number.isFinite(daysRaw) || daysRaw <= 0) return null;
  const days = clamp(Math.round(daysRaw), DAYS_MIN, DAYS_MAX);

  const end = start + days * 86_400_000;
  const bps = amount / days / sec;

  return { id, from, url: data.url, sec, start, days, end, amount, bps };
};

/** Extracts valid sponsored campaigns from a page of account_history ops. */
const extractCampaigns = (ops: any[]): SponsoredCampaign[] => {
  const out: SponsoredCampaign[] = [];
  for (const entry of ops) {
    const seq = entry?.[0];
    const op = entry?.[1]?.op;
    if (!op || op[0] !== 'transfer') continue;

    const data = op[1];
    if (!data || data.to !== SPONSOR_ACCOUNT) continue;

    const [amountRaw, currency] = String(data.amount || '').split(' ');
    if (currency !== 'BLURT') continue;

    const campaign = parseMemo(data.memo || '', parseFloat(amountRaw), String(seq), data.from);
    if (campaign) out.push(campaign);
  }
  return out;
};

/**
 * Fetches enough account_history pages for SPONSOR_ACCOUNT to cover the last
 * WINDOW_DAYS days, parses valid campaigns and replaces the in-memory cache.
 */
export const fetchCampaigns = async (client: any): Promise<SponsoredCampaign[]> => {
  const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
  const bitmask = dblurt.utils.makeBitMaskFilter(
    [dblurt.utils.operationOrders['transfer' as keyof typeof dblurt.utils.operationOrders]]
  ) as [number, number];

  const collected: SponsoredCampaign[] = [];
  let start = -1;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await Blockchain.getAccountHistory(client, SPONSOR_ACCOUNT, start, PAGE_SIZE, bitmask);
      if (!batch || batch.length === 0) break;

      collected.push(...extractCampaigns(batch));

      // account_history pages come back oldest-first; batch[0] is the oldest
      // entry in this page, used to page further back on the next iteration.
      const oldest = batch[0];
      const oldestSeq = oldest[0];
      const oldestTs = Date.parse(`${oldest[1].timestamp}Z`);

      if (Number.isNaN(oldestTs) || oldestTs <= cutoff || oldestSeq <= 0) break;
      start = oldestSeq - 1;
    }
  } catch (e) {
    console.warn('[SponsoredCampaigns] fetch failed:', e);
    // keep whatever was in cache before rather than wiping it on a transient error
    return cache;
  }

  cache = collected;
  lastFetchedAt = Date.now();
  return cache;
};

/** First-call bootstrap: fetches once, memoizes concurrent callers onto the same promise. */
export const ensureCampaigns = async (client: any): Promise<SponsoredCampaign[]> => {
  if (lastFetchedAt === 0) {
    if (!inFlight) inFlight = fetchCampaigns(client).finally(() => { inFlight = null; });
    return inFlight;
  }
  return cache;
};

/** Call once from the plugin's install(). Re-fetches every 6h for long-lived tabs. */
export const startAutoRefresh = (client: any): void => {
  setInterval(() => { fetchCampaigns(client).catch(() => {}); }, REFRESH_INTERVAL_MS);
};

/** Full cache as of the last fetch — used by the market/prices modal, which shows
 *  upcoming and expired campaigns too, not just ones active right now. */
export const getAllCampaigns = (): SponsoredCampaign[] => cache;

/** Alias kept for callers that want an explicit "trigger a refresh now" name (e.g. the modal's refresh button). */
export const refreshCampaignsNow = fetchCampaigns;

export const getActiveCampaigns = (now: number = Date.now()): SponsoredCampaign[] =>
  cache.filter(c => now >= c.start && now <= c.end);

/**
 * Weighted-random pick proportional to `bps`. Higher BPS = higher chance to
 * win, never a guarantee — this is a lottery, not a first-price auction.
 */
export const pickWeightedCampaign = (campaigns: SponsoredCampaign[]): SponsoredCampaign | null => {
  if (!campaigns.length) return null;
  const totalWeight = campaigns.reduce((sum, c) => sum + c.bps, 0);
  if (totalWeight <= 0) return campaigns[Math.floor(Math.random() * campaigns.length)];

  let r = Math.random() * totalWeight;
  for (const c of campaigns) {
    r -= c.bps;
    if (r <= 0) return c;
  }
  return campaigns[campaigns.length - 1];
};
