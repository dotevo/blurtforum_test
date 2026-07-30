/**
 * modules/device-profiles/types.ts
 *
 * "Device profiles" are a local, per-device concept for the TV app only —
 * unrelated to logging into Blurt. Think Netflix/Disney+ profile picker:
 * several people share one TV/box, each gets their own profile (own PEGI
 * cap, own toggles, own PIN), and each profile can have zero or more
 * already-logged-in Blurt accounts linked to it. A profile is NOT a Blurt
 * account, and a Blurt account is NOT owned by a profile — the actual
 * login/key material stays exactly where useAuth.ts already keeps it
 * (auth.accounts); a profile only stores which usernames it's allowed to
 * show/use, by reference.
 *
 * Deliberately named "DeviceProfile" (not "Profile") and living in its own
 * `device-profiles/` module, not `profiles/` — the codebase already has an
 * unrelated `useProfile.ts` (a Blurt user's public forum profile page).
 * Reusing the word in a second, unrelated sense right next to it would be
 * an easy mix-up for anyone (including future-us) grepping the codebase.
 */

export type PegiRating = 'PEGI_3' | 'PEGI_7' | 'PEGI_12' | 'PEGI_16' | 'PEGI_18';

/** Coarser-to-finer order, matching the real PEGI scale — used to compare "is this content's rating within the profile's cap". */
export const PEGI_ORDER: PegiRating[] = ['PEGI_3', 'PEGI_7', 'PEGI_12', 'PEGI_16', 'PEGI_18'];

export interface DeviceProfile {
  id: string;                 // uuid, local to this device -- never sent anywhere
  name: string;
  avatarColor: string;        // a CSS color -- no dependency on a Blurt avatar image
  isAdmin: boolean;            // can open "manage profiles"; only admins can change WebTorrent storage/network settings
  pinHash: string | null;      // null = no PIN set (profile opens immediately)
  pinSalt: string | null;      // hex, paired with pinHash -- see pin-hash.ts
  maxRating: PegiRating | null; // null = no cap (adult default). Enforcement lands in a later stage -- see filterByRating in content.ts, a no-op until content actually carries a rating.
  showVotes: boolean;
  showComments: boolean;
  dailyLimitMinutes: number | null; // null = no daily limit. Enforcement lands in a later stage.
  linkedUsernames: string[];   // subset of auth.accounts[].username this profile is allowed to use
  createdAt: number;           // epoch ms
}

/** On-disk shape (see native/device-profile-store.ts) -- versioned from day one so a future field change never has to guess what an old blob looked like. */
export interface DeviceProfilesFile {
  version: 1;
  profiles: DeviceProfile[];
  activeProfileId: string | null;
}

export type NewDeviceProfileInput = Pick<DeviceProfile, 'name' | 'avatarColor'> & Partial<
  Pick<DeviceProfile, 'maxRating' | 'showVotes' | 'showComments' | 'dailyLimitMinutes' | 'linkedUsernames'>
>;
