# Fix: Transcript PDF won't download

## Root cause

The VPS video engine returns a server-side filesystem path as the PDF URL (e.g. `/tmp/video-output/ju-T6uQNPSg.pdf`), not an HTTPS URL. The frontend renders this as `<a href="/tmp/...">`, which the browser resolves against the Lovable domain and fails — nothing downloadable exists there.

Confirmed by inspecting the `video_jobs` table: the most recent completed job has `pdf_url = /tmp/video-output/ju-T6uQNPSg.pdf`.

## Fix

Route the download through our existing edge function so the browser always hits a valid HTTPS URL, regardless of what the engine returns.

### 1. Edge function `video-to-pdf`

Add a new route:

- `GET /video-to-pdf/download/{jobId}` — auth-checks the user owns the job, fetches the PDF bytes from the VPS engine, streams them back with `Content-Type: application/pdf` and `Content-Disposition: attachment; filename="transcript-{jobId}.pdf"`.

It will try, in order, the most likely engine endpoints to retrieve the file:
1. `GET {VIDEO_ENGINE_URL}/video/{jobId}/pdf`
2. `GET {VIDEO_ENGINE_URL}/video/{jobId}/download`
3. `GET {VIDEO_ENGINE_URL}/files/{basename(pdf_url)}`

The first one that returns 200 wins. If none work, return a clear error so we know to add a real endpoint on the VPS.

### 2. Frontend `VideoTranscript.tsx`

Replace the raw `href={job.pdf_url}` with a computed proxy URL:

```
${VITE_SUPABASE_URL}/functions/v1/video-to-pdf/download/${job.id}?token=...
```

Since `<a>` clicks can't set Authorization headers, the link handler will instead call `fetch` with the auth header, get a blob, and trigger a download via a temporary object URL. Keeps the existing "Download Transcript PDF" button visually identical.

Also update the wiki auto-save block so the markdown PDF link points to the proxy URL too (currently it embeds the same broken `/tmp/...` path).

### 3. No DB or schema change required

`pdf_url` stays as-is for backward compatibility; the proxy ignores it and uses the engine endpoints keyed by `jobId`.

## Open question for you

Do you know which endpoint your VPS engine exposes to serve the generated PDF? If it's something other than the three guesses above (e.g. `/static/{file}.pdf`), tell me the exact path and I'll wire it directly instead of probing.
