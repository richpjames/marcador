/**
 * Environment is read once, at import time, so a misconfigured container fails
 * loudly on boot rather than on the first request.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env (or set it in Coolify) before starting.`,
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databasePath: process.env.DATABASE_PATH ?? "./data/marcador.db",

  /** Web login. */
  password: required("MARCADOR_PASSWORD"),
  /** Bearer token for the Share Extension and any Shortcuts you point at it. */
  token: required("MARCADOR_TOKEN"),
  /**
   * Cookie signing key. Deriving it from the password when unset keeps the
   * required config to two secrets; the cost is that a password change
   * invalidates every existing session, which is the behaviour you want anyway.
   */
  secret: process.env.MARCADOR_SECRET || `derived:${required("MARCADOR_PASSWORD")}`,

  /**
   * Cap on an uploaded PDF. Generous enough for a scanned manual — the Olympus
   * one that prompted this is 5 MB — without letting a stray upload fill the
   * volume the database also lives on.
   */
  maxUploadBytes: Number(process.env.MARCADOR_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),

  mistralApiKey: process.env.MISTRAL_API_KEY ?? "",
  mistralModel: process.env.MISTRAL_MODEL ?? "mistral-small-latest",

  /** Sessions last a month; this is a personal bookmark box, not a bank. */
  sessionMaxAgeSeconds: 60 * 60 * 24 * 30,
} as const;
