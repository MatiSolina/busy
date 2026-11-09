# Generated artifact safety

The Hub checks files published by bots before changing their status from `pending` to `ready`. The check uses the stored bot ownership and source; a caller cannot turn a bot artifact into a user upload during completion.

## Publication rules

- Credential-like filenames such as `.env.production` and `credentials.json` are rejected before the Hub issues an upload URL. Example environment files and public PEM certificates can be inspected and delivered normally.
- Bodies up to 5 MiB are inspected as UTF-8 even when a filename or MIME type claims they are binary. The guard recognizes credential assignments, login credentials, known token formats and private-key headers. It does not record the matching value.
- Redacted examples use explicit placeholder markers such as `<your-api-key>` and `[REDACTED]`. Arbitrary angle-bracketed or multiline values are not exempted from inspection.
- A detected credential leaves a `blocked` tombstone. The Hub removes the private Blob and retains its stale pathname for the existing cleanup sweep to retry. Blocked files cannot be downloaded, attached to messages, listed in the library or promoted by an old verification workflow.
- A storage read failure leaves the upload `pending` for a later completion attempt. The Hub does not publish an uninspected small upload or permanently discard a normal file because of a transient read failure.
- Completion changes only a still-pending row to `ready`; retries cannot revive a blocked file. Library promotion requires a ready file without an existing object.

## Scope

This is a bounded guard for accidental publication of recognizable credentials, not a general data-loss-prevention scanner. Declared text over 5 MiB or invalid UTF-8 text is not published. Larger unknown/binary files retain the existing file pipeline. The guard does not extract secrets from PDF, DOCX, archives, encrypted files or arbitrary encodings.

Files intentionally uploaded by the signed-in person retain the existing upload behavior. Existing ready files are not rescanned retroactively.

## Verification

The regression tests exercise the real file-completion and library-promotion paths with a local PostgreSQL-compatible database. They cover credential-shaped JSON, Spanish login text, renamed plaintext, invalid text, unavailable storage, ordinary reports and terminal blocked state.

Assignment and login detection advance through the input with bounded, non-backtracking parsers. An isolated child-process regression checks adversarial repeated labels and whitespace with a fixed timeout, so a scanner regression cannot hang the test runner.

For a production smoke test, use synthetic credentials in the QA bot section. Check the actual `send_file` results, library visibility and the downloaded control file bytes. A model's summary alone does not establish that publication was blocked.
