import type { Identity } from "spacetimedb";
import { sendPersonalMail } from "./dev-review-mail";

/** Days a President can be away before their guild passes to a member who still plays. */
export const GUILD_LEADER_AWAY_DAYS = 7;
const DAY_MICROS = 86_400_000_000n;

type Ctx = any;

/** When a player last played: now while they are in the world, otherwise when their last session began. */
function lastPlayedMicros(ctx: Ctx, identity: Identity): bigint {
  if (ctx.db.player.identity.find(identity)) return ctx.timestamp.microsSinceUnixEpoch;
  return ctx.db.playerLifetime.identity.find(identity)?.sessionStartedAt.microsSinceUnixEpoch ?? 0n;
}

/**
 * Checked as a member enters the world. A President away GUILD_LEADER_AWAY_DAYS hands the guild to the Vice
 * President if they have played since, otherwise to the longest-serving member who has (at the latest, the one
 * entering). Both are told by letter. Returns the new President, or null when nothing changed.
 */
export function passLeadershipIfAway(ctx: Ctx, entering: Identity): Identity | null {
  const seat = ctx.db.guildMember.identity.find(entering);
  const guild = seat && ctx.db.guild.id.find(seat.guildId);
  if (!guild || guild.leader.equals(entering)) return null;
  const cutoff = ctx.timestamp.microsSinceUnixEpoch - BigInt(GUILD_LEADER_AWAY_DAYS) * DAY_MICROS;
  if (lastPlayedMicros(ctx, guild.leader) >= cutoff) return null;
  const playing = [...ctx.db.guildMember.guildId.filter(guild.id)]
    // The member entering is playing now, whatever their last session says.
    .filter((member: any) => !member.identity.equals(guild.leader)
      && (member.identity.equals(entering) || lastPlayedMicros(ctx, member.identity) >= cutoff))
    .sort((a: any, b: any) => Number(b.vicePresident) - Number(a.vicePresident)
      || (a.joinedAt < b.joinedAt ? -1 : a.joinedAt > b.joinedAt ? 1 : a.identity.toHexString().localeCompare(b.identity.toHexString())));
  const next = playing[0];
  if (!next) return null;
  const away = guild.leader;
  ctx.db.guild.id.update({ ...guild, leader: next.identity });
  if (next.vicePresident) ctx.db.guildMember.identity.update({ ...next, vicePresident: false });
  // Invitations were the old President's to send.
  for (const row of ctx.db.socialGuildInvite.guildId.filter(guild.id)) ctx.db.socialGuildInvite.id.delete(row.id);
  const key = `guild-succession-${guild.id}-${ctx.timestamp.microsSinceUnixEpoch}`;
  sendPersonalMail(ctx, { key: `${key}-new`, identity: next.identity, title: `${guild.name}: You Are President`,
    body: `${guild.name}'s President had not played for ${GUILD_LEADER_AWAY_DAYS} days, so the guild is yours to lead now.` });
  sendPersonalMail(ctx, { key: `${key}-away`, identity: away, title: `${guild.name}: New President`,
    body: `You had not played for ${GUILD_LEADER_AWAY_DAYS} days, so ${ctx.db.playerProfile.identity.find(next.identity)?.displayName ?? next.name} leads ${guild.name} now. You are still a member.` });
  return next.identity;
}
