import { bootstrapSuperAdmin } from "../services/bootstrap.js";
import { loadConfig } from "../config.js";

/**
 * Secure first-run Super Admin bootstrap (CLI):
 *   pnpm bootstrap --email deepak.sharma@dejoiy.com --password '...'
 *
 * The bootstrap secret comes from BOOTSTRAP_SECRET in .env. The password is
 * read from the --password flag or BOOTSTRAP_PASSWORD env (never source code).
 */
async function main(): Promise<void> {
  loadConfig();
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const email = flag("email") ?? process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = flag("password") ?? process.env.BOOTSTRAP_PASSWORD;
  const fullName = flag("full-name") ?? "Super Admin";

  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.error(
      "Usage: pnpm bootstrap --email <email> --password <password>\n" +
      "Set BOOTSTRAP_SECRET in .env before running."
    );
    process.exit(1);
  }

  const result = await bootstrapSuperAdmin({
    email,
    password,
    fullName,
    bootstrapSecret: process.env.BOOTSTRAP_SECRET ?? ""
  });

  // eslint-disable-next-line no-console
  console.log(
    `Super Admin bootstrapped:\n  user:  ${result.email}\n  id:    ${result.userNumber}\n  state: ${result.passwordResetRequired ? "PASSWORD_RESET_REQUIRED (change password on first sign-in)" : "active"}`
  );
  // eslint-disable-next-line no-console
  console.log("Next: enroll MFA (required for privileged operations) and remove BOOTSTRAP_SECRET from .env.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Bootstrap failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
