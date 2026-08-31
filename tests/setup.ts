process.env.MARCADOR_PASSWORD ??= "test-password";
process.env.MARCADOR_TOKEN ??= "test-token";
process.env.MARCADOR_SECRET ??= "test-secret";
process.env.DATABASE_PATH ??= ":memory:";
// Left unset on purpose: the suite must pass with no Mistral credentials.
delete process.env.MISTRAL_API_KEY;
