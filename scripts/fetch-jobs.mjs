// IncomeHub · Real jobs feed
// Pulls open public projects from Freelancer.com for each IncomeHub service,
// filters out spam / expert / off-topic work, adds a short summary and a
// "Practise this brief" question, and writes jobs.json for the app.
// Runs on GitHub Actions every 6 hours (see .github/workflows/jobs.yml).
// No dependencies: Node 20+ (global fetch).
//
// Optional: set the repo secret ANTHROPIC_API_KEY to let Claude write the
// summaries + practice questions. Without it, the built-in rules below do it.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const API = "https://www.freelancer.com/api/projects/0.1";
const MAX_AGE_H = 168;          // only jobs posted in the last 48h
const PER_SERVICE = 25;        // cap per service
const MIN_USD = 5, MAX_USD = 200;

// ---------- services ----------
const SERVICES = {
  wf: {
    skills: ["Flyer Design", "Poster Design", "Brochure Design", "Leaflet Design", "Canva"],
    strong: ["Flyer Design", "Poster Design", "Brochure Design", "Leaflet Design"],
    queries: ["flyer design", "poster design", "event flyer", "canva flyer", "menu design", "leaflet design"],
    must: /\b(flyers?|posters?|leaflets?|menus?|brochures?|banners?|invitations?)\b/i,
    exclude: /\b(powerpoint|presentation|dieline|coreldraw|certificate|3d|animation|animated|video|motion|website|wordpress|shopify|app|logo only|packaging|label|illustrat\w*|book cover|album|mockups? only|developer|scraping|data entry)\b/i,
  },
  cv: {
    skills: ["Resume Writing", "Cover Letter", "CV Writing", "Resumes", "LinkedIn"],
    strong: ["Resume Writing", "Cover Letter", "CV Writing", "Resumes"],
    queries: ["resume writing", "cv writing", "resume", "cover letter", "cv design", "linkedin profile"],
    must: /\b(resumes?|résumé|cv|cvs|curriculum vitae|cover letters?|linkedin profile)\b/i,
    exclude: /\b(add experience|fake|parser|parsing|screening|ats software|developer|app|website|scrap\w*|database|python|recruit\w* platform|job portal|ai tool)\b/i,
  },
  ig: {
    skills: ["Instagram", "Social Media Design", "Canva", "Social Media Post Design", "Facebook Marketing"],
    strong: ["Social Media Post Design", "Social Media Design"],
    queries: ["instagram post", "instagram posts design", "social media post", "social media design", "canva social media", "facebook post design"],
    must: /\b(instagram|social media|facebook|tiktok|canva|carousel|posts?)\b/i,
    exclude: /\b(strategy|strategist|manager|marketer|marketing (strategy|management)|sales|lead gen\w*|customer acquisition|recovery|appeal|disabled|osint|investigat\w*|run your own|ads setup|models?|followers|likes|ads manager|ad campaign|paid ads|grow my|growth hack|seo|website|app|video edit\w*|reels? edit\w*|animation|3d|influencer|bot|automation|developer)\b/i,
  },
};

// scam / unsafe / off-limits
const SCAM = /\b(political|election|candidate|vote for|telegram|whats\s?app me|contact me on|crypto|bitcoin|usdt|forex|betting|casino|adult|nsfw|onlyfans|registration fee|pay (a|the) fee|deposit first|unpaid|for free|free trial task|investment|loan|gift ?card)\b/i;
const EXPERT = /\b(senior|expert only|agency only|10\+ years|5\+ years|top rated only|native .* only)\b/i;

// ---------- helpers ----------
const NON_EN = /\b(necesito|para|publicaciones|nous|vous|pour|avec|recrutement|rémunéré|ich|wir|und|für|precisamos|preciso|cerco|abbiamo|sono)\b/i;
const isEnglish = (t) => !NON_EN.test(t) && (t.match(/[^\x00-\x7F]/g) || []).length < t.length * 0.05;
const DIAG = { searches: [], skills: {}, reasons: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, params) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k + "[]", x));
    else u.searchParams.set(k, v);
  }
  for (let i = 0; i < 3; i++) {
    const r = await fetch(u, { headers: { "User-Agent": "IncomeHub-jobs-feed/1.0 (+https://github.com/Donnalle/incomehub-config)" } });
    if (r.ok) return r.json();
    console.warn(`  ${r.status} on ${u.pathname}${u.search.slice(0, 80)}… retry ${i + 1}`);
    await sleep(2000 * (i + 1));
  }
  throw new Error("Freelancer API failed: " + u);
}
const clean = (s = "") => s.replace(/\s+/g, " ").replace(/[^\S\r\n]+([.,!?])/g, "$1").trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function summarise(desc, title) {
  let t = clean(desc)
    .replace(/^((hi|hello|hey)( there| all| everyone)?|greetings|good (morning|day|afternoon)|dear \w+)[,!.\s-]*/i, "")
    .replace(/^(i am|i'm|we are|we're) (looking for|seeking|in need of) (a |an )?(\w+ )?(graphic )?(designer|freelancer|writer|someone|person|expert|professional)( who can| to)? (make|create|design|write|do|produce|help( me| us)?( with)?)? ?/i, "Needs ")
    .replace(/^(i|we) (need|want|require) (a |an |someone to )?/i, (m) => "Needs " + (/ a /.test(m) ? "a " : / an /.test(m) ? "an " : ""));
  const first = (t.match(/^.{20,}?[.!?](\s|$)/) || [t])[0].trim();
  let s = first.length > 120 ? first.slice(0, 117).replace(/\s+\S*$/, "") + "…" : first;
  if (!s || s.toLowerCase() === title.toLowerCase()) s = t.slice(0, 117) + (t.length > 117 ? "…" : "");
  return cap(s);
}

// ---------- practice question builder (rules) ----------
// Each rule looks for a signal in the brief and returns a question,
// 3 options (right one first; shuffled later), a "why", a "need" line and keys.
const RULES = [
  { test: /\b(a4|a5|a3|(instagram|whatsapp|ig) (story|stories|status)|print and (digital|online|social)|two (sizes|versions|formats)|both sizes|\d+ sizes|multiple sizes)\b/i,
    make: (m) => ({ q: "What's the trap in this brief?", right: "It needs more than one size", wrong: ["The client hasn't paid yet", "There's no theme"],
      why: "More than one size means more than one layout. Say you'll deliver every size, it shows you actually read the brief.",
      need: `I'll deliver every size you need, including ${m[0]}.`, keys: [m[0]] }) },
  { test: /\b(weekly|monthly|ongoing|long[- ]term|regular|every (week|month|day)|recurring|future work|more work)\b/i,
    make: (m) => ({ q: "Why is this job worth more than it pays?", right: "It's ongoing, so it repeats", wrong: ["It's very urgent", "The budget is huge"],
      why: "A repeat client beats a one-off. Build a template once and each new round takes minutes.",
      need: "I'll build you one template so every update is quick.", keys: [m[0], "template"] }) },
  { test: /\b(\d{1,2})\s+(posts?|flyers?|designs?|graphics?|templates?|pages?)\b/i,
    make: (m) => ({ q: "How should you price this?", right: `As one pack for all ${m[1]}`, wrong: ["Per hour", "Ask them to name a price"],
      why: `${m[1]} ${m[2]} is a package. One clear pack price is easier for the client to say yes to.`,
      need: `I'll do all ${m[1]} ${m[2]} as one pack.`, keys: [m[1]] }) },
  { test: /\b(brand colou?rs?|our colou?rs?|black and \w+|\w+ and gold|colou?r scheme|brand guide\w*|logo and colou?rs?)\b/i,
    make: (m) => ({ q: "What will this client judge you on first?", right: "Sticking to their brand colours", wrong: ["How cheap you are", "How many years you've worked"],
      why: "They told you their colours. Anything that ignores them is out in 2 seconds.",
      need: "I'll stick to your brand colours.", keys: [m[0].split(" ")[0], "colour", "color"] }) },
  { test: /\b(grand opening|opening day|launch event|event|party|concert|wedding|church|sale|special offer|discount|black friday|festival|camp|conference|fundraiser)\b/i,
    make: (m) => ({ q: "What's this client's real goal?", right: "Get people to show up or buy", wrong: ["Win a design award", "Get a new logo"],
      why: "The design has one job: bring people in. Lead with the date or the offer, everything else comes second.",
      need: `I'll make the ${m[0].toLowerCase()} details impossible to miss.`, keys: [m[0]] }) },
  { test: /\b(graduate|student|entry[- ]level|no experience|first job|internship)\b/i,
    make: (m) => ({ q: "What should this CV lead with?", right: "Projects and results", wrong: ["A long list of hobbies", "A big photo"],
      why: "Little experience means projects are the experience. Show what they did and what came of it.",
      need: "I'll turn your projects into proof employers notice.", keys: [m[0], "project"] }) },
  { test: /\b(\d) pages?\b|\b(too long|shorten|cut down|condense)\b/i,
    make: (m) => ({ q: "What's the main job here?", right: "Cut it down to what matters", wrong: ["Add more detail", "Make it colourful"],
      why: "Shorter and sharper wins. Say exactly how you'll trim it.",
      need: "I'll cut it down so the best parts jump out.", keys: [m[0], "page", "short"] }) },
  { test: /\b(career change|switch\w* (careers?|industr\w*)|transition\w* (to|into))\b/i,
    make: (m) => ({ q: "What's the hardest part of this CV?", right: "Showing old skills fit the new job", wrong: ["Choosing a font", "Adding a photo"],
      why: "A career change CV translates old experience into the new field. That's what to promise.",
      need: "I'll show how your experience fits the new role.", keys: ["career", "transition", "switch"] }) },
  { test: /\b(ats|applicant tracking)\b/i,
    make: (m) => ({ q: "What does 'ATS-friendly' mean for your work?", right: "Simple layout, the right keywords", wrong: ["Lots of graphics", "Colourful columns"],
      why: "Hiring software reads plain layouts with the job's keywords. Fancy design can get it rejected.",
      need: "I'll keep it ATS-friendly with the right keywords.", keys: ["ats", "keyword"] }) },
  { test: /\b(urgent\w*|asap|today|tonight|tomorrow|within \d+ (hours?|days?)|24 ?h(ours)?|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
    make: (m) => ({ q: "What matters most to this client?", right: "Getting it fast", wrong: ["A fancy portfolio", "The cheapest price"],
      why: "They're in a rush. Lead with when you can deliver, then show quality.",
      need: `I can have it ready ${/^(today|tonight|tomorrow|by )/i.test(m[0]) ? m[0].toLowerCase() : "fast"}.`, keys: [m[0]] }) },
];
const FALLBACK = {
  wf: { q: "What should your pitch mention first?", right: "Exactly what their design is for", wrong: ["Your lowest price", "How long you've designed"], why: "Clients skim pitches. Repeat their exact need in your first line and you're already ahead of most bidders.", need: "I'll design it so the key details jump out first." },
  cv: { q: "What should your pitch mention first?", right: "The job they're applying for", wrong: ["Your favourite CV template", "Your lowest price"], why: "A CV is only as good as the job it's aimed at. Show you noticed theirs.", need: "I'll shape your CV around the exact job you want." },
  ig: { q: "What should your pitch mention first?", right: "Their business and what they post", wrong: ["Your follower count", "Your lowest price"], why: "They want posts that fit their business. Mention it by name in your first line.", need: "I'll make posts that look like your brand and get noticed." },
};
function keyPhrase(title) {
  const t = title.replace(/\b(need(ed)?|looking for|want(ed)?|required?|urgent|a|an|the|for|my|our|to|design(er)?|create|make)\b/gi, " ").replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();
  return t.split(" ").slice(0, 3).join(" ").toLowerCase() || title.toLowerCase();
}
function shuffle3(right, wrong, seed) {
  const opts = [right, ...wrong], pos = seed % 3;
  [opts[0], opts[pos]] = [opts[pos], opts[0]];
  return { options: opts, right: pos };
}
function practiceFor(job, svc) {
  const text = job.title + ". " + job.brief;
  for (const r of RULES) {
    const m = text.match(r.test);
    if (m) {
      const p = r.make(m);
      const { options, right } = shuffle3(p.right, p.wrong, job.seed);
      return { q: p.q, options, right, why: p.why, need: p.need, keys: p.keys.filter(Boolean).map((k) => String(k).toLowerCase()) };
    }
  }
  const f = FALLBACK[svc], kp = keyPhrase(job.title);
  const { options, right } = shuffle3(f.right, f.wrong, job.seed);
  return { q: f.q, options, right, why: f.why, need: f.need, keys: kp.split(" ").filter((w) => w.length > 3).slice(0, 2) };
}

// ---------- optional: Claude writes summary + practice ----------
async function claudeEnrich(job, svc) {
  const key = process.env.ANTHROPIC_API_KEY;
  DIAG.claude = DIAG.claude || { keyPresent: !!key, ok: 0, fail: 0, lastError: null };
  if (!key) return null;
  const prompt = `You help beginners in Africa practise freelancing. Service: ${svc === "wf" ? "WhatsApp/print flyers" : svc === "cv" ? "CV makeovers" : "Instagram posts"}.
Job title: ${job.title}
Brief: ${job.brief.slice(0, 1500)}
Return ONLY JSON: {"fit": true/false (could a beginner who is learning this service realistically do this job? false for hiring/sales/recruiting, account recovery, video/filming, development, research, marketing strategy, anything needing years of experience), "summary": "max 110 chars, plain English, what the client wants", "q": "one short question testing if the reader understood what the client REALLY needs", "options": ["3 short options, max 45 chars each"], "right": 0-2, "why": "max 170 chars, coach tone, no emoji", "need": "one pitch sentence, max 90 chars, starting with I'll, referencing the brief", "keys": ["2-3 lowercase words from the brief the pitch should mention"]}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-haiku-5-5", max_tokens: 500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) { DIAG.claude.fail++; DIAG.claude.lastError = r.status + " " + (await r.text()).slice(0, 300); return null; }
    const d = await r.json();
    const j = JSON.parse(d.content[0].text.match(/\{[\s\S]*\}/)[0]);
    if (!j.summary || !Array.isArray(j.options) || j.options.length !== 3) { DIAG.claude.fail++; DIAG.claude.lastError = "bad json: " + d.content[0].text.slice(0, 200); return null; }
    DIAG.claude.ok++;
    return j;
  } catch (e) { DIAG.claude.fail++; DIAG.claude.lastError = "exception: " + e.message; return null; }
}

// ---------- main ----------
async function main() {
  const now = Date.now() / 1000;
  const fx = { USD: 1, ZAR: 18.2, NGN: 1550, KES: 129, UGX: 3700 };
  try { // live rates for currencies Freelancer supports (exchange_rate = USD per 1 unit)
    const c = await get("/currencies/", {});
    for (const cur of c.result.currencies || []) if (fx[cur.code] && cur.exchange_rate) fx[cur.code] = +(1 / cur.exchange_rate).toFixed(2);
  } catch (e) { console.warn("currencies failed, using defaults"); }

  const out = { diag: DIAG, updated: new Date().toISOString(), source: "freelancer.com", fx, counts: {}, services: {} };
  const seen = new Set();
  const prev = existsSync("jobs.json") ? JSON.parse(readFileSync("jobs.json", "utf8")) : { services: {} };
  const cache = new Map(Object.values(prev.services || {}).flat().filter((j) => j.ai).map((j) => [j.id, j]));

  for (const [svc, conf] of Object.entries(SERVICES)) {
    const jobs = new Map();
    let skillIds = [], strongIds = [];
    try {
      const jd = await get("/jobs/", { job_names: conf.skills });
      skillIds = (jd.result || []).map((j) => j.id).filter(Boolean);
      strongIds = (jd.result || []).filter((j) => conf.strong.includes(j.name)).map((j) => j.id);
      DIAG.skills[svc] = (jd.result || []).map((j) => j.name + "#" + j.id);
    } catch (e) { console.warn(`${svc}: skill lookup failed`); }
    const searches = [...(skillIds.length ? [0, 50, 100, 150].map((offset) => ({ jobs: skillIds, offset })) : []), ...conf.queries.map((query) => ({ query }))];
    for (const extra of searches) {
      const d = await get("/projects/active/", {
        ...extra, limit: 50, sort_field: "time_updated", compact: "true",
        full_description: "true", job_details: "true", user_details: "true", user_country_details: "true", user_location_details: "true",
        project_types: ["fixed"],
      });
      if (!globalThis.__dumped && d.result.projects?.[0]) { globalThis.__dumped = 1; const u0 = Object.values(d.result.users || {})[0]; DIAG.ownerKeys = u0 ? Object.keys(u0) : null; DIAG.ownerLocation = u0?.location || null; DIAG.projectKeys = Object.keys(d.result.projects[0]); }
      DIAG.searches.push({ svc, ...(extra.query ? { q: extra.query } : { skills: extra.jobs.length }), got: (d.result.projects || []).length });
      const users = d.result.users || {};
      if (extra.offset && (d.result.projects || []).length === 0) continue;
      for (const p of d.result.projects || []) {
        if (jobs.has(p.id) || seen.has(p.id)) continue;
        const title = clean(p.title), brief = clean(p.description || p.preview_description || "");
        const text = title + " " + brief;
        const ageH = (now - (p.time_submitted || 0)) / 3600;
        const rate = p.currency?.exchange_rate || 1;
        const min = Math.round((p.budget?.minimum || 0) * rate), max = Math.round((p.budget?.maximum || p.budget?.minimum || 0) * rate);
        const head = title + " " + brief.slice(0, 160);
        const pj = (p.jobs || []).map((j) => j.id);
        const skillHit = pj.some((id) => skillIds.includes(id)), strongHit = pj.some((id) => strongIds.includes(id));
        const why = ageH > MAX_AGE_H ? "old" : !(strongHit || conf.must.test(title) || (skillHit && conf.must.test(head))) ? "off-topic" : !isEnglish(text) ? "not english" : conf.exclude.test(text) ? "excluded" : SCAM.test(text) ? "scam" :
          EXPERT.test(text) ? "expert" : max < MIN_USD ? "too cheap" : min > MAX_USD ? "too big" : p.status !== "active" ? "closed" : brief.length < 40 ? "thin" : null;
        DIAG.reasons[why || "kept"] = (DIAG.reasons[why || "kept"] || 0) + 1;
        if (why) continue;
        const owner = users[p.owner_id] || users[String(p.owner_id)];
        const bids = p.bid_stats?.bid_count ?? 0;
        jobs.set(p.id, {
          id: String(p.id), title, brief: brief.slice(0, 700), min, max: Math.max(min, max), cur: "USD",
          bids, posted: new Date((p.time_submitted || now) * 1000).toISOString(),
          country: owner?.location?.country?.name || owner?.location?.country?.code || "",
          url: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
          beginner: max <= 80 && !/\b(experienced|professional only|portfolio required)\b/i.test(text),
          seed: Number(String(p.id).slice(-3)) || 0,
        });
      }
      await sleep(700);
    }
    const list = [...jobs.values()].sort((a, b) => b.posted.localeCompare(a.posted)).slice(0, PER_SERVICE);
    for (const j of list) {
      seen.add(Number(j.id));
      const hit = cache.get(j.id);
      const ai = hit ? null : await claudeEnrich(j, svc);
      if (hit) { j.summary = hit.summary; j.practice = hit.practice; j.ai = true; }
      else if (ai && ai.fit === false) { j.drop = true; continue; }
      else if (ai) { j.ai = true;
        j.summary = ai.summary;
        j.practice = { q: ai.q, options: ai.options, right: Math.max(0, Math.min(2, +ai.right || 0)), why: ai.why, need: ai.need, keys: (ai.keys || []).map((k) => String(k).toLowerCase()) };
      } else {
        j.summary = summarise(j.brief, j.title);
        j.practice = practiceFor(j, svc);
      }
      delete j.seed;
    }
    out.services[svc] = list.filter((j) => !j.drop);
    out.counts[svc] = out.services[svc].length;
    console.log(`${svc}: ${jobs.size} kept → ${list.length} published`);
  }

  // never wipe a good feed with an empty one (e.g. API hiccup)
  const total = Object.values(out.counts).reduce((a, b) => a + b, 0);
  if (total === 0 && existsSync("jobs.json")) {
    const prev = JSON.parse(readFileSync("jobs.json", "utf8"));
    if (Object.values(prev.counts || {}).some((n) => n > 0)) { console.log("Empty run, keeping previous jobs.json"); return; }
  }
  writeFileSync("jobs.json", JSON.stringify(out, null, 1) + "\n");
  console.log("jobs.json written:", out.counts);
}

main().catch((e) => { console.error(e); process.exit(1); });
