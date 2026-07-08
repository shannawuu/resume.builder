# Resume Tailor

Paste a link to a job posting → get a recruiter-graded, ATS-safe, **one-page** resume and a tailored cover letter — generated from *your* resume and CV, with zero invented facts.

A single static page (no build, no server) that runs entirely in your browser and calls the Claude API directly with your own key. Perfect for GitHub Pages.

## What it does

1. **Senior-recruiter analysis** — match score /100, top 5 missing keywords, and the 3 red flags a hiring manager spots in under 10 seconds.
2. **Experience rewrite** — pulls the most valuable experiences from your resume *and* extended CV, rewrites bullets with the Google XYZ formula ("Accomplished X as measured by Y by doing Z"), and weaves in the missing keywords naturally. **It never makes data up** — when it needs a real metric it shows clickable question cards and waits for your answers (blank = skip, it proceeds without that data).
3. **ATS filter + skimming hiring manager pass** — flags sections that would get skipped, rewrites them to stop the scroll, and outputs the final single-column, one-page resume.
4. **Tailored cover letter** — under 350 words, hooked on your strongest proof point.

Afterwards the resume and cover letter are **fully editable in place**, with a live "fits on one page" badge, a **Re-score my edits** button (the recruiter grades your edited version), copy/`.txt` download, and **Print / Save PDF** in US Letter format.

## Two ways to run it

- **Claude Pro / free chat mode (default, $0):** the site prepares each prompt; you copy-paste it into your own [claude.ai](https://claude.ai) chat and paste the reply back. Uses your existing Pro (or free) subscription — no API key, no extra cost. Keep the whole run in one claude.ai chat; if you uploaded a PDF, attach it to the first message there.
- **API key mode (automatic):** enter an Anthropic API key and the pipeline runs itself (~$0.30–$1.00 per job). Note: API credits are separate from a Claude Pro subscription.

## Setup

1. Open the site and pick a mode in **step 0**. For API mode, get a key at [platform.claude.com](https://platform.claude.com/) (stored only in your browser's localStorage).
3. **Upload your resume as PDF or Word (.docx)** — or paste the text — in **step 1** (optionally also a longer CV). PDFs are sent to Claude natively so it sees your actual layout; .docx files are text-extracted in the browser and their real font names/sizes are read from the file as style hints.
4. Paste a job link in **step 2**, hit **Fetch posting** (or paste the description manually — some sites like LinkedIn block automatic fetching), then **Tailor my resume**.

**Formatting matching:** the final resume is rendered in typography matched to your original document — closest web-safe font stack, font sizes, heading casing/underlines, and accent color — while staying single-column and ATS-safe. Pasted-text-only runs get a clean professional default.

Job-link fetching uses the free [r.jina.ai](https://r.jina.ai) reader to get around browser CORS limits.

## Deploy to GitHub Pages

```bash
# from this folder
gh repo create resume-tailor --public --source=. --push
gh api repos/{owner}/resume-tailor/pages -X POST \
  -f "source[branch]=main" -f "source[path]=/"
```

Or in the GitHub UI: create a repo, push these files, then **Settings → Pages → Deploy from a branch → main / (root)**. Your site will be at `https://<username>.github.io/resume-tailor/`.

To run locally: `python3 -m http.server 4173` in this folder, then open `http://localhost:4173`.

## Privacy & cost notes

- Your resume, CV, and API key never leave your browser except for calls to `api.anthropic.com` (and the job-page fetch through `r.jina.ai`).
- **Don't enter your API key on a shared/public computer** — it sits in localStorage.
- Each full tailoring run makes 4–7 Claude Opus 4.8 calls; expect roughly $0.30–$1.00 per job depending on document length.

## Stack

Vanilla HTML/CSS/JS + the official [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) loaded from esm.sh with `dangerouslyAllowBrowser` (fine here — the key is the user's own, entered client-side). Model: `claude-opus-4-8` with adaptive thinking and structured outputs (JSON schema) for every pipeline stage.
