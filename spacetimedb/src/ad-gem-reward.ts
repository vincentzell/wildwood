import { SenderError, table, t } from "spacetimedb/server";
import {
  AD_GEM_REWARD,
  AD_WATCH_MIN_SECONDS,
  adGemRefusal,
  adGemRewardStatus,
  mergeAdGemRewardRecords,
  type AdGemRewardRecord,
} from "../../shared/ad-gem-reward";

/**
 * The rewarded ad's Gem claims: when this account last claimed, and how many
 * times on its current UTC day. The rules live in shared/ad-gem-reward.ts; the
 * claim_ad_gems reducer and the caller-scoped my_ad_gem_reward view are
 * declared in index.ts and call in here.
 *
 * Its own private table rather than columns on the wallet or the daily bonus:
 * a column on a table every session reads would strand every open tab on
 * publish. No row means the account has never claimed.
 */
export const playerAdReward = table({ name: "player_ad_reward", public: false }, {
  identity: t.identity().primaryKey(),
  lastClaimAt: t.timestamp(),
  /** The UTC day `claimsToday` counts, keyed like daily_gem_bonus. */
  dayKey: t.string(),
  claimsToday: t.u32(),
});

/** The ad the account has playing: started on the server, so a claim can tell it was watched. Gone once claimed. */
export const playerAdWatch = table({ name: "player_ad_watch", public: false }, {
  identity: t.identity().primaryKey(),
  startedAt: t.timestamp(),
});

type GemGrant = (ctx: any, input: { identity: any; delta: bigint; kind: string; note: string; externalReference: string }) => unknown;
type Row = { identity: any; lastClaimAt: any; dayKey: string; claimsToday: number };

const millis = (timestamp: { microsSinceUnixEpoch: bigint }) => Number(timestamp.microsSinceUnixEpoch / 1000n);
const recordOf = (row: Row): AdGemRewardRecord => ({ lastClaimAtMs: millis(row.lastClaimAt), dayKey: row.dayKey, claimsToday: row.claimsToday });

/** An ad starting: only when one is due, so the watch can only begin once the cooldown is over. */
export function startAdWatch(ctx: { db: any; sender: any; timestamp: any }) {
  const previous: Row | null = ctx.db.playerAdReward.identity.find(ctx.sender) ?? null;
  const status = adGemRewardStatus(previous && recordOf(previous), millis(ctx.timestamp));
  const refusal = adGemRefusal(status);
  if (refusal || status.kind !== "ready") throw new SenderError(refusal ?? "Ad reward unavailable.");
  const row = { identity: ctx.sender, startedAt: ctx.timestamp };
  if (ctx.db.playerAdWatch.identity.find(ctx.sender)) ctx.db.playerAdWatch.identity.update(row);
  else ctx.db.playerAdWatch.insert(row);
}

/**
 * Pays one watched ad, or refuses with when the next one is due. A supporter's
 * one-tap claim comes through here too: they skip the ad, not the limits.
 * Everyone else needs an ad started (startAdWatch) AD_WATCH_MIN_SECONDS before;
 * a claim with none pays nothing and says nothing, so a script polling it
 * gains nothing and fills no log.
 *
 * The ledger reference carries the claim's own instant. Thirty minutes apart
 * means no two claims share one, so a retried transaction cannot pay twice.
 */
export function claimAdGemReward(ctx: { db: any; sender: any; timestamp: any }, applyGemBalanceChange: GemGrant, supporter = false) {
  const watch = supporter ? null : ctx.db.playerAdWatch.identity.find(ctx.sender);
  if (!supporter && !watch) return false;
  if (watch && millis(ctx.timestamp) - millis(watch.startedAt) < AD_WATCH_MIN_SECONDS * 1000) throw new SenderError("Finish the ad first.");
  const previous: Row | null = ctx.db.playerAdReward.identity.find(ctx.sender) ?? null;
  const status = adGemRewardStatus(previous && recordOf(previous), millis(ctx.timestamp));
  const refusal = adGemRefusal(status);
  if (refusal || status.kind !== "ready") throw new SenderError(refusal ?? "Ad reward unavailable.");

  applyGemBalanceChange(ctx, {
    identity: ctx.sender,
    delta: BigInt(AD_GEM_REWARD),
    kind: "ad_reward",
    note: "Rewarded ad watched.",
    externalReference: `ad-gems:${ctx.sender.toHexString()}:${ctx.timestamp.microsSinceUnixEpoch}`,
  });
  const row = { identity: ctx.sender, lastClaimAt: ctx.timestamp, dayKey: status.dayKey, claimsToday: status.claimsToday + 1 };
  if (previous) ctx.db.playerAdReward.identity.update(row);
  else ctx.db.playerAdReward.insert(row);
  if (watch) ctx.db.playerAdWatch.identity.delete(ctx.sender);
  return true;
}

/**
 * A guest signing in to an account. Unlike a setting, neither side wins
 * outright: the later claim and the higher count on the later day are kept,
 * so signing in can neither shorten a cooldown nor hand out a fresh day. The
 * guest row never survives.
 */
export function mergeAdGemReward(ctx: { db: any }, guest: any, account: any) {
  const guestRow: Row | null = ctx.db.playerAdReward.identity.find(guest) ?? null;
  if (!guestRow) return;
  const accountRow: Row | null = ctx.db.playerAdReward.identity.find(account) ?? null;
  if (!accountRow) {
    ctx.db.playerAdReward.insert({ ...guestRow, identity: account });
  } else {
    const merged = mergeAdGemRewardRecords(recordOf(accountRow), recordOf(guestRow));
    const later = millis(guestRow.lastClaimAt) > millis(accountRow.lastClaimAt) ? guestRow : accountRow;
    ctx.db.playerAdReward.identity.update({ identity: account, lastClaimAt: later.lastClaimAt, dayKey: merged.dayKey, claimsToday: merged.claimsToday });
  }
  ctx.db.playerAdReward.identity.delete(guest);
}

export function removeAdGemReward(ctx: { db: any }, identity: any) {
  if (ctx.db.playerAdReward.identity.find(identity)) ctx.db.playerAdReward.identity.delete(identity);
  if (ctx.db.playerAdWatch.identity.find(identity)) ctx.db.playerAdWatch.identity.delete(identity);
}
