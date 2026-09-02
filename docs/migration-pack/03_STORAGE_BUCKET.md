# Step 03 — Photo-proof storage bucket

**Purpose:** the app stores task photo proof (clinical-space imagery) in a private bucket
and serves it through short-lived signed URLs.

**Preconditions:** step 02 complete.

## Actions

1. Storage → New bucket → name exactly `qcms-proof`.
2. **Public: OFF.** This must stay private — photo proof must never be world-readable.
3. If the bucket already exists: verify it is private, change nothing else.

**Success criteria:** bucket `qcms-proof` exists with public access disabled.
**On failure:** report; do not substitute a public bucket.
