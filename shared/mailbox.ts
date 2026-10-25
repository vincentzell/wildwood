import mailboxCopy from "./mailbox-copy.json";
export const REBALANCE_MAIL_ID = "stats-explained-2026-09-17";
export const REBALANCE_MAIL_GEMS = 75n;
export const REBALANCE_MAIL_TITLE = mailboxCopy.title;
export const REBALANCE_MAIL_BODY = mailboxCopy.body;

/**
 * A make-good for slot upgrades that went missing, wiped by a prestige or
 * thrown away mid-run by a sweep or sign-in.
 */
export const SLOT_UPGRADE_MAIL_ID = "slot-upgrades-restored-2026-09-22";
export const SLOT_UPGRADE_MAIL_GEMS = 50n;
export const SLOT_UPGRADE_MAIL_TITLE = "Sorry about your slot upgrades";
export const SLOT_UPGRADE_MAIL_BODY = [
  "Slot upgrades were not surviving. A prestige wiped every slot tier, and an upgrade left running on the bench was being thrown away the next time the world swept or you signed in \u2014 which is why a slot would not move past the tier it started the day with.",
  "",
  "Both are fixed. Slot tiers now survive a prestige, the way your research does, and an upgrade on the bench runs to the end.",
  "",
  "Take 50 gems for the trouble.",
].join("\n");

export type MailboxMessage = {
  id: string;
  title: string;
  body: string;
  gems: bigint;
  itemIds?: string[];
  upgradeLevel?: number;
  createdAtMs: number;
  read: boolean;
  claimed: boolean;
};

/** The graded-gear release: old gear melted into gold, and gems for the fresh start. */
export const GEAR_OVERHAUL_MAIL_ID = "gear-overhaul-2026-10-19";
export const GEAR_OVERHAUL_MAIL_GEMS = 150n;
export const GEAR_OVERHAUL_MAIL_TITLE = "New Gear, Fresh Start";
export const GEAR_OVERHAUL_MAIL_BODY = [
  "Gear now comes in 15 grades that last, from Crude to Eternal. Your old gear was melted down into gold.",
  "",
  "Buy new gear from the Weapon and Armor Sellers in Town, or craft it at the Smith. Your weapon school's Mastery opens higher grades as you fight, and the Archery Range, Sword Hall and Mage Tower show your progress.",
  "",
  "Here are 150 gems to say thanks for playing.",
].join("\n");
