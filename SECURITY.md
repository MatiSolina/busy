# Security

Report suspected vulnerabilities through the repository's **Security → Report a
vulnerability** page. Do not put credentials, private files, or exploitable
details in a public issue. If private reporting is unavailable, open an issue
asking for a private reporting channel without including sensitive details.

Each installation supplies its own accounts, database, keys, tokens, domains,
and Vercel projects. Keep `.env.local` and Vercel's local project files private.
Use the example environment files and the setup guide; never copy another
installation's credentials. If a credential is exposed, revoke it at its
provider and replace it in the affected installation.

Before publishing a change, review the staged files and scan the Git snapshot
with Gitleaks using redacted output. Synthetic credentials in tests must remain
clearly recognizable as fixtures.
