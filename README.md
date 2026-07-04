# Blackline

**Blackline — permanently redact sensitive info from your PDFs, 100% in your
browser. Nothing you upload ever leaves your device.**

A zero-trust PDF redaction tool. Upload a resume, ID, or bank statement, draw
black boxes over anything sensitive, and download a copy where that content is
**permanently removed** — not just visually covered. **Your file never leaves
the browser**: rendering (pdf.js), box-drawing, and the rebuild (pdf-lib) all
happen client-side. On export, every page is flattened to a raster image with
the boxes burned in, so the text under a box isn't hidden behind a rectangle —
it simply doesn't exist in the output file. Copy-paste over it, strip the
rectangle, inspect the file: there's nothing there.

## Tech stack

- **Frontend:** Vanilla HTML/CSS/JS, no build step (deployable to GitHub Pages) — pdf.js for rendering, pdf-lib for rebuilding the redacted file
- **Backend:** Spring Boot 3 on Java 17, packaged as a runnable JAR / Docker image (deployable to Render) — serves `GET /api/ping` for keep-alive **and nothing else**; it has no endpoint that accepts a request body, so file bytes can't reach it even by mistake

## Project layout

```
docs/            Static client — viewer, box-drawing UI, and redaction engine
redactor-api/    Spring Boot service — GET /api/ping only (keep-alive)
```

## Run locally

**Frontend** (any static server works; VS Code Live Server is easiest):

```bash
cd docs
# open index.html with Live Server, or:
python -m http.server 5500
```

Then visit `http://localhost:5500`. A sample PDF with fake personal data lives
at `docs/assets/sample-resume.pdf` if you want something safe to practice on.

**Backend** (optional — the frontend is fully standalone and makes zero API calls):

```bash
cd redactor-api
./mvnw spring-boot:run
```

Verify it's up:

```bash
curl http://localhost:8080/api/ping     # {"status":"ok","service":"pdf-redactor-api"}
```

## How the redaction is permanent

1. The PDF is read with the FileReader API and rendered page-by-page with pdf.js — in the tab, never uploaded.
2. Redaction boxes are tracked per page in memory, in page-space coordinates (so zoom doesn't shift them).
3. On export, each page is re-rendered to a canvas at 2× resolution, the boxes are painted as opaque black pixels, and the flattened image becomes the page of a brand-new PDF built with pdf-lib.
4. The original text layer, fonts, attachments, and metadata are never copied to the new file. What's under a box isn't recoverable because it was never written.

Verify it yourself: DevTools → Network tab → load, redact, export. Zero outbound
requests carry your file. Then try selecting text over a black box in the output.

## Live Demo

Coming soon — same deployment pattern as ENV Vault Checker (GitHub Pages front,
Render keep-alive back).
