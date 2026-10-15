// ARD (Agentic Resource Discovery) manifest, served at /.well-known/ai-catalog.json
// (and /ai-catalog.json). Schema: specVersion "1.0" + an `entries` array; each entry
// would carry an `identifier` URN, `displayName`, `type` (IANA media type) and one of
// `url`/`data`.
//
// OpenKuasa advertises no public agentic resources yet — Taming Sari AI is a
// per-workspace, authenticated assistant, not a public MCP server or A2A agent — so
// `entries` is intentionally empty. This valid manifest clears the "malformed JSON /
// invalid schema" audit; add entries once a public resource exists.
export const AI_CATALOG = {
  specVersion: '1.0',
  host: {
    displayName: 'OpenKuasa OS',
    identifier: 'did:web:openkuasa.com',
  },
  entries: [] as unknown[],
};
