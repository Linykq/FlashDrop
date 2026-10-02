import type { SessionUser } from '@flashdrop/contracts';
import { type Db, eq, inArray, SEED_USERS, users } from '@flashdrop/db';

export interface UserStore {
  /** The seeded dev-login accounts that exist, in seed order: the admin first, then the buyers. */
  listDevUsers(): Promise<SessionUser[]>;
  /** A seeded dev-login account; undefined for any other id, including real users. */
  findDevUser(id: string): Promise<SessionUser | undefined>;
  findById(id: string): Promise<SessionUser | undefined>;
}

/**
 * Dev login only ever signs in the seeded accounts (design §5.1, §11). Later milestones add users that must
 * not be reachable this way (k6 sessions, M2), so membership is checked against the seed's own list.
 */
const DEV_USER_ORDER = new Map<string, number>(SEED_USERS.map((user, index) => [user.id, index]));

const userColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
};

export function createPostgresUsers(db: Db): UserStore {
  async function findById(id: string): Promise<SessionUser | undefined> {
    const [user] = await db.select(userColumns).from(users).where(eq(users.id, id)).limit(1);
    return user;
  }

  return {
    async listDevUsers() {
      const rows = await db
        .select(userColumns)
        .from(users)
        .where(inArray(users.id, [...DEV_USER_ORDER.keys()]));
      const position = (user: SessionUser) => DEV_USER_ORDER.get(user.id) ?? Number.MAX_SAFE_INTEGER;
      return rows.sort((a, b) => position(a) - position(b));
    },
    findDevUser: (id) => (DEV_USER_ORDER.has(id) ? findById(id) : Promise.resolve(undefined)),
    findById,
  };
}
