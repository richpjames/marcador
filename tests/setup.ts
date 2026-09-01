// Assigned unconditionally, not with `??=`: Bun auto-loads `.env` before this
// preload runs, so a developer who has a real `.env` for deploying would
// otherwise run the suite against their live password and token, and every
// auth test would fail on their machine but pass in CI.
process.env.MARCADOR_PASSWORD = "test-password";
process.env.MARCADOR_TOKEN = "test-token";
process.env.MARCADOR_SECRET = "test-secret";
process.env.DATABASE_PATH = ":memory:";
// Left unset on purpose: the suite must pass with no Mistral credentials.
delete process.env.MISTRAL_API_KEY;
