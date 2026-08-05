import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * The single place Argon2 parameters live, so raising cost later is a one-line change
 * and cannot drift between the seed and the running app. Parameters are encoded into
 * the hash string, so old hashes keep verifying after a bump.
 *
 * OWASP baseline for Argon2id. memoryCost is deliberately not higher: Render's free
 * tier has 512 MB, and M6's script fires 20 concurrent requests - 19 MiB each is
 * survivable, 64 MiB each is not.
 */
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

// A real Argon2id hash of a value nobody can present. Used to burn the same CPU on an
// unknown email as on a known one, so response time does not disclose which it was.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2VydmljZXMtbWFya2V0cGxhY2U$JmU5rTz0GH1DBM7cVOvvzGtY0DPvNMBqOhBnU9xCoZs';

@Injectable()
export class PasswordService implements OnModuleInit {
  private readonly logger = new Logger(PasswordService.name);

  /**
   * argon2 is a native module. Prove it loads at boot rather than discovering it at
   * the first login attempt on a deployed instance.
   */
  async onModuleInit(): Promise<void> {
    try {
      await argon2.hash('boot-probe', OPTIONS);
    } catch (err) {
      this.logger.error('argon2 native module unavailable - authentication cannot work', err);
      throw err;
    }
  }

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, OPTIONS);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed stored hash must read as "wrong password", not as a 500.
      return false;
    }
  }

  /** Equalises login timing for an email that does not exist. */
  async burn(plain: string): Promise<void> {
    await this.verify(DUMMY_HASH, plain).catch(() => undefined);
  }
}
