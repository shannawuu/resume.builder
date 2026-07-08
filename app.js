// Resume Tailor — browser-only pipeline against the Claude API.
// Uses the official Anthropic TypeScript/JS SDK (browser build via esm.sh).
import Anthropic from "https://esm.sh/@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";
const MAX_QUESTION_ROUNDS = 3;

const $ = (id) => document.getElementById(id);

// ── persisted inputs ────────────────────────────────────────────
const store = {
  get: (k) => localStorage.getItem("rt_" + k) || "",
  set: (k, v) => localStorage.setItem("rt_" + k, v),
};

for (const [id, key] of [["apiKey", "apiKey"], ["resumeText", "resume"], ["cvText", "cv"]]) {
  $(id).value = store.get(key);
  $(id).addEventListener("change", () => store.set(key, $(id).value));
}
updateKeyStatus();
if (store.get("apiKey")) $("settingsCard").open = false;

$("saveKey").addEventListener("click", () => {
  store.set("apiKey", $("apiKey").value.trim());
  updateKeyStatus();
});

// ── run mode: "manual" (Claude Pro / free chat, copy-paste) or "api" ──
function runMode() { return store.get("mode") || "manual"; }
function updateModeUI() {
  const manual = runMode() === "manual";
  $("modeManual").checked = manual;
  $("modeApi").checked = !manual;
  $("apiKeyRow").hidden = manual;
  $("manualModeHint").hidden = !manual;
}
for (const id of ["modeManual", "modeApi"]) {
  $(id).addEventListener("change", (e) => {
    if (e.target.checked) store.set("mode", e.target.value);
    updateModeUI();
  });
}
updateModeUI();

function updateKeyStatus() {
  $("keyStatus").textContent = store.get("apiKey")
    ? "✓ Key saved in this browser."
    : "No key saved yet.";
}

function makeClient() {
  const apiKey = store.get("apiKey") || $("apiKey").value.trim();
  if (!apiKey) throw new UserError("Add your Anthropic API key in Settings (step 0) first.");
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

class UserError extends Error {}

// ── system prompt ───────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an elite resume writer who works as three personas in sequence: a senior recruiter at the target company, a professional resume writer, and an ATS (applicant tracking system) auditor.

Non-negotiable rules:
- NEVER invent employers, job titles, dates, metrics, numbers, technologies, certifications, or accomplishments that are not in the candidate's materials or answers. If a quantified claim would strengthen a bullet but the data is missing, ask for it through the questions mechanism instead of guessing. If the candidate leaves a question unanswered, write the bullet without that data.
- Rewrite achievement bullets with the Google XYZ formula: "Accomplished X, as measured by Y, by doing Z" — but keep them natural, not formulaic-sounding.
- Weave the job description's keywords in naturally. Never keyword-stuff; ATS systems and humans both penalize it.
- Keep the resume ATS-safe: single column, standard section headings (Summary, Experience, Skills, Education, etc.), no tables, no text boxes, no images, no icons, standard punctuation.
- The resume must fit ONE US Letter page at ~10.5pt. Be ruthless about cutting weaker or less relevant material — pull the MOST valuable, most job-relevant experiences from everything the candidate provided (resume AND CV) and drop the rest.
- Write in the candidate's voice; no clichés ("results-driven", "team player", "passionate").`;

// ── JSON schemas for structured outputs ─────────────────────────
const SCHEMA_ANALYSIS = {
  type: "object",
  properties: {
    company_name: { type: "string", description: "Company name from the job description, or 'the company' if not stated" },
    role_title: { type: "string" },
    match_score: { type: "integer", description: "0-100 match score of the CURRENT resume against this job" },
    score_rationale: { type: "string" },
    missing_keywords: { type: "array", items: { type: "string" }, description: "The top 5 missing keywords" },
    red_flags: {
      type: "array",
      description: "The 3 red flags a hiring manager would spot in under 10 seconds",
      items: {
        type: "object",
        properties: { title: { type: "string" }, explanation: { type: "string" } },
        required: ["title", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["company_name", "role_title", "match_score", "score_rationale", "missing_keywords", "red_flags"],
  additionalProperties: false,
};

const SCHEMA_REWRITE = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: "Questions for the candidate when real data is missing. Empty array when you have everything you need.",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          why: { type: "string", description: "One line on why this data strengthens the resume" },
        },
        required: ["question", "why"],
        additionalProperties: false,
      },
    },
    rewritten_experience: {
      type: "string",
      description: "The rewritten experience section as plain text. Empty string while questions are still outstanding.",
    },
    changes_summary: { type: "array", items: { type: "string" } },
  },
  required: ["questions", "rewritten_experience", "changes_summary"],
  additionalProperties: false,
};

const RESUME_HTML_SPEC = `Format resume_html using ONLY these tags (ATS-safe, single column):
<h1> candidate name </h1>
<p class="contact"> city · phone · email · linkedin/site </p>
<h2> SECTION HEADING </h2>
<h3> Job Title — Company </h3>
<p class="meta"> Location · Start – End </p>
<ul><li> bullets </li></ul>
<p> for summary/other prose </p>
<strong>/<em> sparingly. No other tags, no styles, no tables, no columns.`;

const SCHEMA_FINAL = {
  type: "object",
  properties: {
    skipped_sections: {
      type: "array",
      description: "Sections the ATS or a skimming hiring manager would skip, and why",
      items: {
        type: "object",
        properties: { section: { type: "string" }, reason: { type: "string" } },
        required: ["section", "reason"],
        additionalProperties: false,
      },
    },
    ats_notes: { type: "array", items: { type: "string" }, description: "What was changed to stop the scroll / pass the ATS" },
    resume_html: { type: "string", description: "The complete final one-page resume as simple HTML per the given spec" },
    style_spec: {
      type: "object",
      description: "Typography matching the candidate's ORIGINAL resume document as closely as possible with web-safe fonts. If the original was plain pasted text with no file, use a clean professional default.",
      properties: {
        font_family_css: { type: "string", description: "CSS font-family stack closest to the original body font, e.g. 'Garamond, \"Times New Roman\", serif' or 'Calibri, Arial, sans-serif'" },
        heading_font_family_css: { type: "string", description: "CSS stack for the name + section headings; same as body if the original uses one font" },
        base_font_pt: { type: "number", description: "Body font size in pt, typically 9.5-11.5" },
        name_font_pt: { type: "number", description: "Candidate-name font size in pt" },
        heading_font_pt: { type: "number", description: "Section-heading size in pt" },
        line_height: { type: "number", description: "Unitless line-height, typically 1.15-1.4" },
        heading_uppercase: { type: "boolean", description: "true if the original's section headings are ALL-CAPS" },
        heading_underline: { type: "boolean", description: "true if the original uses horizontal rules / underlined section headings" },
        accent_color: { type: "string", description: "Hex color used for name/headings in the original, or '#111111' if black-and-white" },
      },
      required: ["font_family_css", "heading_font_family_css", "base_font_pt", "name_font_pt", "heading_font_pt", "line_height", "heading_uppercase", "heading_underline", "accent_color"],
      additionalProperties: false,
    },
  },
  required: ["skipped_sections", "ats_notes", "resume_html", "style_spec"],
  additionalProperties: false,
};

const SCHEMA_COVER = {
  type: "object",
  properties: {
    cover_letter: { type: "string", description: "Complete cover letter, plain text, paragraphs separated by blank lines. Max ~350 words." },
  },
  required: ["cover_letter"],
  additionalProperties: false,
};

const SCHEMA_RECHECK = {
  type: "object",
  properties: {
    match_score: { type: "integer" },
    remaining_issues: { type: "array", items: { type: "string" }, description: "Concrete remaining problems, empty if clean" },
  },
  required: ["match_score", "remaining_issues"],
  additionalProperties: false,
};

// ── file uploads (PDF sent to Claude natively; DOCX text-extracted) ──
const uploads = { resume: null, cv: null }; // {kind:'pdf',name,base64} | {kind:'docx',name,styleHints}

for (const slot of ["resume", "cv"]) {
  $(slot + "File").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) handleUpload(slot, f);
    e.target.value = ""; // allow re-selecting the same file
  });
}

function setUploadStatus(slot, msg, cls = "") {
  const el = $(slot + "UploadStatus");
  el.textContent = msg;
  el.className = "upload-status " + cls;
}

async function handleUpload(slot, file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const ta = $(slot + "Text");
  try {
    if (ext === "pdf") {
      if (file.size > 25 * 1024 * 1024) throw new Error("PDF is over 25 MB — export a smaller one.");
      setUploadStatus(slot, "Reading PDF…");
      const base64 = await fileToBase64(file);
      uploads[slot] = { kind: "pdf", name: file.name, base64 };
      ta.value = "";
      store.set(slot === "resume" ? "resume" : "cv", "");
      ta.placeholder = `📄 ${file.name} attached — the AI reads the PDF directly, including its fonts and layout. Add optional extra notes here.`;
      setUploadStatus(slot, `✓ ${file.name} attached — formatting will be matched`, "ok");
    } else if (ext === "docx") {
      setUploadStatus(slot, "Extracting text from Word file…");
      const buf = await file.arrayBuffer();
      const [{ default: mammoth }, { default: JSZip }] = await Promise.all([
        import("https://esm.sh/mammoth"),
        import("https://esm.sh/jszip"),
      ]);
      const { value: text } = await mammoth.extractRawText({ arrayBuffer: buf });
      if (!text.trim()) throw new Error("No text found in that .docx.");
      const styleHints = await sniffDocxStyles(JSZip, buf);
      uploads[slot] = { kind: "docx", name: file.name, styleHints };
      ta.value = text.trim();
      store.set(slot === "resume" ? "resume" : "cv", ta.value);
      setUploadStatus(slot, `✓ ${file.name} extracted${styleHints ? " — fonts detected: " + styleHints.fonts.join(", ") : ""}`, "ok");
    } else if (ext === "txt") {
      ta.value = (await file.text()).trim();
      store.set(slot === "resume" ? "resume" : "cv", ta.value);
      uploads[slot] = null;
      setUploadStatus(slot, `✓ ${file.name} loaded`, "ok");
    } else {
      throw new Error("Use .pdf, .docx, or .txt (old binary .doc isn't supported — re-save as .docx).");
    }
  } catch (err) {
    uploads[slot] = null;
    setUploadStatus(slot, "✗ " + err.message, "err");
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("Couldn't read the file."));
    r.readAsDataURL(file);
  });
}

// pull real font names + sizes out of the docx XML as style hints
async function sniffDocxStyles(JSZip, buf) {
  try {
    const zip = await JSZip.loadAsync(buf);
    const xml =
      ((await zip.file("word/styles.xml")?.async("string")) || "") +
      ((await zip.file("word/document.xml")?.async("string")) || "");
    const count = {};
    for (const m of xml.matchAll(/w:ascii="([^"]+)"/g)) count[m[1]] = (count[m[1]] || 0) + 1;
    const fonts = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
    const sizes = [...new Set([...xml.matchAll(/w:sz w:val="(\d+)"/g)].map((m) => +m[1] / 2))]
      .filter((s) => s >= 7 && s <= 30).sort((a, b) => a - b);
    if (!fonts.length && !sizes.length) return null;
    return { fonts, sizes };
  } catch { return null; }
}

function pdfBlock(upload, title) {
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: upload.base64 },
    title,
  };
}

function styleHintText() {
  const parts = [];
  for (const slot of ["resume", "cv"]) {
    const u = uploads[slot];
    if (u?.kind === "docx" && u.styleHints) {
      parts.push(`The original ${slot} .docx uses font(s): ${u.styleHints.fonts.join(", ") || "unknown"}${u.styleHints.sizes?.length ? "; font sizes (pt): " + u.styleHints.sizes.join(", ") : ""}.`);
    }
  }
  return parts.join("\n");
}

// ── conversation state ──────────────────────────────────────────
let client = null;
let messages = [];
let analysis = null;

let manualSystemSent = false;

async function callClaude(schema) {
  return runMode() === "manual" ? manualCall(schema) : apiCall(schema);
}

async function apiCall(schema) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    messages,
    output_config: { format: { type: "json_schema", schema } },
  });
  if (resp.stop_reason === "refusal") {
    throw new UserError("The model declined this request" +
      (resp.stop_details?.explanation ? ": " + resp.stop_details.explanation : "."));
  }
  // pass full content (incl. thinking blocks) back on later turns
  messages.push({ role: "assistant", content: resp.content });
  const text = resp.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Empty response from the model.");
  return JSON.parse(text);
}

// ── manual mode: the user relays prompts through their own claude.ai chat ──
async function manualCall(schema) {
  const last = messages[messages.length - 1];
  const bodyText = typeof last.content === "string"
    ? last.content
    : last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

  let prompt = bodyText;
  if (!manualSystemSent) {
    prompt = SYSTEM_PROMPT + "\n\n---\n\n" + prompt;
  }
  prompt += `\n\nIMPORTANT: Reply with ONLY a single JSON object — no prose before or after, no markdown code fences — that validates against this JSON Schema:\n${JSON.stringify(schema)}`;

  const parsed = await collectManualReply(prompt, !manualSystemSent);
  manualSystemSent = true;
  messages.push({ role: "assistant", content: JSON.stringify(parsed) });
  return parsed;
}

function collectManualReply(prompt, isFirstStep) {
  return new Promise((resolve) => {
    $("manualPrompt").value = prompt;
    $("manualReply").value = "";
    $("manualError").hidden = true;
    $("manualAttachHint").hidden = !(isFirstStep && (uploads.resume?.kind === "pdf" || uploads.cv?.kind === "pdf"));
    $("manualPanel").hidden = false;
    $("manualPanel").scrollIntoView({ behavior: "smooth" });

    const btn = $("manualContinue");
    const handler = () => {
      try {
        const parsed = parseLooseJson($("manualReply").value);
        btn.removeEventListener("click", handler);
        $("manualPanel").hidden = true;
        resolve(parsed);
      } catch {
        $("manualError").hidden = false;
        $("manualError").textContent =
          "That doesn't look like the JSON reply — paste Claude's entire response (it should start with { and end with }). If Claude answered in prose, tell it: \"reply with only the JSON object\" and paste the new reply.";
      }
    };
    btn.addEventListener("click", handler);
  });
}

// tolerate code fences / stray prose around the JSON object
function parseLooseJson(raw) {
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s === -1 || e <= s) throw new Error("no JSON object found");
  return JSON.parse(raw.slice(s, e + 1));
}

$("copyManualPrompt").addEventListener("click", () => {
  navigator.clipboard.writeText($("manualPrompt").value);
  $("copyManualPrompt").textContent = "✓ Copied";
  setTimeout(() => ($("copyManualPrompt").textContent = "Copy prompt"), 1500);
});

// ── fetch job description from a link ──────────────────────────
$("fetchJd").addEventListener("click", async () => {
  const url = $("jobUrl").value.trim();
  if (!url) return setFetchStatus("Paste a job posting URL first.", true);
  setFetchStatus("Fetching page text…");
  $("fetchJd").disabled = true;
  try {
    // r.jina.ai is a free CORS-friendly reader that returns page text/markdown
    const r = await fetch("https://r.jina.ai/" + url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const text = (await r.text()).trim();
    if (text.length < 200) throw new Error("Page returned almost no text.");
    $("jdText").value = text;
    setFetchStatus("✓ Fetched. Skim it below and trim anything irrelevant (cookie banners etc.), then hit Tailor.");
  } catch (e) {
    setFetchStatus("Couldn't fetch that page (" + e.message + "). Some sites (e.g. LinkedIn) block readers — paste the job description manually below.", true);
  } finally {
    $("fetchJd").disabled = false;
  }
});

function setFetchStatus(msg, isErr = false) {
  const el = $("fetchStatus");
  el.textContent = msg;
  el.style.color = isErr ? "var(--error)" : "";
}

// ── pipeline ────────────────────────────────────────────────────
$("tailorBtn").addEventListener("click", runPipeline);
$("resetBtn").addEventListener("click", () => location.reload());

function setStage(name, state) {
  const li = $("stage-" + name);
  li.classList.remove("running", "done");
  if (state) li.classList.add(state);
}

function showError(err) {
  console.error(err);
  const el = $("pipelineError");
  el.hidden = false;
  if (err instanceof UserError) el.textContent = err.message;
  else if (err?.status === 401) el.textContent = "Authentication failed — check your API key in Settings.";
  else if (err?.status === 429) el.textContent = "Rate limited by the API — wait a minute and try again.";
  else el.textContent = "Something went wrong: " + (err?.message || err);
}

async function runPipeline() {
  $("pipelineError").hidden = true;
  const resume = $("resumeText").value.trim();
  const cv = $("cvText").value.trim();
  const jd = $("jdText").value.trim();

  try {
    if (!resume && !uploads.resume) throw new UserError("Upload or paste your resume in step 1 first.");
    if (!jd) throw new UserError("Fetch or paste the job description in step 2 first.");
    if (runMode() === "api") client = makeClient();
  } catch (e) { return showError(e); }

  store.set("resume", resume);
  store.set("cv", cv);

  // reset state + UI
  messages = [];
  manualSystemSent = false;
  $("pipelineCard").hidden = false;
  $("outputCard").hidden = true;
  for (const p of ["analysisPanel", "questionsPanel", "atsPanel", "recheckPanel", "manualPanel"]) $(p).hidden = true;
  for (const s of ["analyze", "rewrite", "ats", "cover"]) setStage(s, null);
  $("tailorBtn").disabled = true;
  $("pipelineCard").scrollIntoView({ behavior: "smooth" });

  try {
    // ── Stage 1: senior recruiter analysis ──
    setStage("analyze", "running");
    const blocks = [];
    if (uploads.resume?.kind === "pdf") blocks.push(pdfBlock(uploads.resume, "Candidate's resume — ORIGINAL FILE. Note its fonts, heading style, and layout: the final resume must match this formatting."));
    if (uploads.cv?.kind === "pdf") blocks.push(pdfBlock(uploads.cv, "Candidate's extended CV — original file"));
    const hints = styleHintText();
    blocks.push({
      type: "text",
      text:
`Here are my materials.

<resume>
${uploads.resume?.kind === "pdf" ? "(attached to this message as a PDF — my original resume file; note its formatting)" + (resume ? "\nExtra notes: " + resume : "") : resume}
</resume>

<cv_extended>
${uploads.cv?.kind === "pdf" ? "(attached to this message as a PDF)" + (cv ? "\nExtra notes: " + cv : "") : (cv || "(none provided — use the resume only)")}
</cv_extended>
${hints ? "\n<original_formatting_hints>\n" + hints + "\n</original_formatting_hints>\n" : ""}
<job_description>
${jd}
</job_description>

Act as a senior recruiter for the company in the job description. Analyze my resume against the job description and give me a match score out of 100, the top 5 missing keywords, and the 3 red flags a hiring manager would spot in under 10 seconds.`,
    });
    messages.push({ role: "user", content: blocks });
    analysis = await callClaude(SCHEMA_ANALYSIS);
    renderAnalysis(analysis);
    setStage("analyze", "done");

    // ── Stage 2: XYZ rewrite, with clarifying-question loop ──
    setStage("rewrite", "running");
    messages.push({
      role: "user",
      content:
`Rewrite my experience section to naturally include those missing keywords and remove the red flags. Pull the most valuable, most relevant experiences from BOTH my resume and my extended CV. Use the Google XYZ formula: Accomplished X as measured by Y by doing Z. Do not make any information up — if you need real data (metrics, team sizes, outcomes, dates, tools), return questions instead of guessing.`,
    });
    let s2 = await callClaude(SCHEMA_REWRITE);
    let rounds = 0;
    while (s2.questions?.length && rounds < MAX_QUESTION_ROUNDS) {
      rounds++;
      const answers = await collectAnswers(s2.questions);
      messages.push({
        role: "user",
        content:
`My answers:
${answers}

For anything I left blank or don't know, proceed WITHOUT that data — do not invent it. If you now have what you need, return the rewritten experience section and an empty questions array.`,
      });
      s2 = await callClaude(SCHEMA_REWRITE);
    }
    $("questionsPanel").hidden = true;
    setStage("rewrite", "done");

    // ── Stage 3: ATS filter + hiring manager scan → final resume ──
    setStage("ats", "running");
    messages.push({
      role: "user",
      content:
`Now act as an ATS filter and a hiring manager reading 200 resumes in one sitting. Scan my new resume and tell me which sections would get skipped, then rewrite them so they actually stop the scroll.

Then produce the COMPLETE final resume — every section, not just experience — selecting the most valuable content so it fits on one US Letter page.

${RESUME_HTML_SPEC}

Also fill style_spec so the final resume LOOKS like my original document: if my resume was attached as a PDF, study its typography (serif vs sans, font identity, sizes, all-caps vs title-case headings, rules/underlines, any accent color) and pick the closest widely-available CSS font stack. If font hints from a .docx were provided, use those font names first in the stack. If I only pasted plain text, choose a clean professional default.`,
    });
    const s3 = await callClaude(SCHEMA_FINAL);
    renderAts(s3);
    applyStyleSpec(s3.style_spec);
    renderResume(s3.resume_html);
    setStage("ats", "done");

    // ── Stage 4: cover letter ──
    setStage("cover", "running");
    messages.push({
      role: "user",
      content:
`Finally, write a tailored cover letter for this role at ${analysis.company_name}. Hook the reader in the first two lines with my strongest, most relevant proof point. Mirror the job description's language naturally, keep it under 350 words, confident but human, no clichés, and do not restate the whole resume. Address it appropriately given what the posting reveals.`,
    });
    const s4 = await callClaude(SCHEMA_COVER);
    renderCover(s4.cover_letter, analysis);
    setStage("cover", "done");

    $("outputCard").hidden = false;
    $("outputCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    document.querySelectorAll(".stages li.running").forEach((li) => li.classList.remove("running"));
    showError(e);
  } finally {
    $("tailorBtn").disabled = false;
  }
}

// ── clarifying questions UI ────────────────────────────────────
function collectAnswers(questions) {
  return new Promise((resolve) => {
    const list = $("questionsList");
    list.innerHTML = "";
    questions.forEach((q, i) => {
      const card = document.createElement("div");
      card.className = "question-card";
      card.innerHTML = `
        <div class="q">${esc(q.question)}</div>
        <div class="why">Why it helps: ${esc(q.why)}</div>
        <textarea data-idx="${i}" placeholder="Your answer — or leave blank to skip"></textarea>`;
      list.appendChild(card);
    });
    $("questionsPanel").hidden = false;
    $("questionsPanel").scrollIntoView({ behavior: "smooth" });

    const btn = $("submitAnswers");
    const handler = () => {
      btn.removeEventListener("click", handler);
      $("questionsPanel").hidden = true;
      const answers = questions
        .map((q, i) => {
          const a = list.querySelector(`textarea[data-idx="${i}"]`).value.trim();
          return `Q: ${q.question}\nA: ${a || "(no answer — proceed without this data)"}`;
        })
        .join("\n\n");
      resolve(answers);
    };
    btn.addEventListener("click", handler);
  });
}

// ── rendering ───────────────────────────────────────────────────
function renderAnalysis(a) {
  $("matchScore").textContent = a.match_score;
  $("missingKeywords").innerHTML = a.missing_keywords
    .map((k) => `<span class="chip">${esc(k)}</span>`).join("");
  $("redFlags").innerHTML = a.red_flags
    .map((r) => `<li><span class="rf-title">${esc(r.title)}:</span> ${esc(r.explanation)}</li>`).join("");
  $("analysisPanel").hidden = false;
}

function renderAts(s3) {
  const items = [
    ...s3.skipped_sections.map((s) => `<li><strong>Would get skipped — ${esc(s.section)}:</strong> ${esc(s.reason)}</li>`),
    ...s3.ats_notes.map((n) => `<li>${esc(n)}</li>`),
  ];
  $("atsNotes").innerHTML = items.join("");
  $("atsPanel").hidden = false;
}

function renderResume(html) {
  $("resumePage").innerHTML = sanitize(html);
  requestAnimationFrame(updateFitBadge);
}

// apply the model's typography spec (matched to the uploaded original) to the page
function applyStyleSpec(spec) {
  if (!spec) return;
  const cleanFont = (s) => String(s).replace(/[^\w\s,"'-]/g, "").slice(0, 120);
  const pt = (n, lo, hi, fb) => (typeof n === "number" && n >= lo && n <= hi ? n : fb);
  const vars = {
    "--body-font": cleanFont(spec.font_family_css),
    "--head-font": cleanFont(spec.heading_font_family_css),
    "--base-pt": pt(spec.base_font_pt, 8, 13, 10.5) + "pt",
    "--name-pt": pt(spec.name_font_pt, 12, 26, 17) + "pt",
    "--h2-pt": pt(spec.heading_font_pt, 9, 15, 11) + "pt",
    "--lh": pt(spec.line_height, 1, 1.7, 1.32),
    "--h2-transform": spec.heading_uppercase ? "uppercase" : "none",
    "--h2-border": spec.heading_underline ? "1px solid #555" : "none",
    "--doc-accent": /^#[0-9a-fA-F]{3,8}$/.test(spec.accent_color || "") ? spec.accent_color : "#111",
  };
  for (const page of [$("resumePage"), $("coverPage")]) {
    for (const [k, v] of Object.entries(vars)) page.style.setProperty(k, v);
  }
  // cover letter: inherit the body font but keep letter sizing
  $("coverPage").style.setProperty("--base-pt", "11pt");
  $("coverPage").style.setProperty("--lh", "1.45");
}

function renderCover(text, a) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const paras = text.split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
  $("coverPage").innerHTML = `<p>${esc(today)}</p><p><strong>Re: ${esc(a.role_title)} — ${esc(a.company_name)}</strong></p>${paras}`;
}

// strip anything unsafe from model-generated HTML
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,link,meta,img,svg").forEach((n) => n.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const bad = /^on/i.test(attr.name) ||
        (attr.name === "href" && /^\s*javascript:/i.test(attr.value)) ||
        (attr.name !== "class" && attr.name !== "href");
      if (bad) el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── one-page fit badge (live while editing) ────────────────────
function updateFitBadge() {
  const page = $("resumePage");
  const badge = $("fitBadge");
  const over = page.scrollHeight - page.clientHeight;
  if (over > 2) {
    badge.textContent = `✗ Over one page by ~${Math.ceil(over / 14)} lines — trim it`;
    badge.className = "fit-badge over";
  } else {
    badge.textContent = "✓ Fits on one page";
    badge.className = "fit-badge ok";
  }
}
$("resumePage").addEventListener("input", () => requestAnimationFrame(updateFitBadge));

// ── re-score edited resume ──────────────────────────────────────
$("recheckBtn").addEventListener("click", async () => {
  if (!messages.length || (runMode() === "api" && !client)) return;
  $("recheckBtn").disabled = true;
  $("recheckBtn").textContent = "Scoring…";
  try {
    messages.push({
      role: "user",
      content:
`I've hand-edited the resume. Here is the current text:

<edited_resume>
${$("resumePage").innerText}
</edited_resume>

As the senior recruiter again: re-score it out of 100 against the job description and list any concrete remaining issues (missing keywords, weak bullets, red flags, anything I broke while editing). Be strict.`,
    });
    const r = await callClaude(SCHEMA_RECHECK);
    $("recheckScore").textContent = r.match_score;
    $("recheckIssues").innerHTML = r.remaining_issues.length
      ? r.remaining_issues.map((i) => `<li>${esc(i)}</li>`).join("")
      : "<li>No remaining issues found. 🎉</li>";
    $("recheckPanel").hidden = false;
  } catch (e) {
    showError(e);
  } finally {
    $("recheckBtn").disabled = false;
    $("recheckBtn").textContent = "Re-score my edits";
  }
});

// ── tabs, copy, download, print ────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("tab-resume").hidden = tab.dataset.tab !== "resume";
    $("tab-cover").hidden = tab.dataset.tab !== "cover";
  });
});

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
function printPage(id) {
  const el = $(id);
  el.classList.add("printing");
  window.print();
  el.classList.remove("printing");
}

$("copyResume").addEventListener("click", () => navigator.clipboard.writeText($("resumePage").innerText));
$("copyCover").addEventListener("click", () => navigator.clipboard.writeText($("coverPage").innerText));
$("downloadResume").addEventListener("click", () => download("resume.txt", $("resumePage").innerText));
$("downloadCover").addEventListener("click", () => download("cover-letter.txt", $("coverPage").innerText));
$("printResume").addEventListener("click", () => printPage("resumePage"));
$("printCover").addEventListener("click", () => printPage("coverPage"));
