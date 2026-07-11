import fs from 'fs';
import path from 'path';
import { makeHttpCtx } from './providers/_http.mjs';

// Import providers
import greenhouse from './providers/greenhouse.mjs';
import ashby from './providers/ashby.mjs';
import lever from './providers/lever.mjs';
import smartrecruiters from './providers/smartrecruiters.mjs';
import recruitee from './providers/recruitee.mjs';
import workday from './providers/workday.mjs';
import workable from './providers/workable.mjs';
import amazon from './providers/amazon.mjs';
import eightfold from './providers/eightfold.mjs';

const COMPANIES_PATH = './companies.json';
const HISTORY_PATH = './jobs-history.json';
const README_PATH = './README.md';

const CONCURRENCY_LIMIT = 10;

const providers = {
  greenhouse,
  ashby,
  lever,
  smartrecruiters,
  recruitee,
  workday,
  workable,
  amazon,
  eightfold,
};

// API / Provider Detection Logic
function detectProvider(company) {
  // 1. Explicit boards-api Greenhouse link in "api" field takes precedence
  if (company.api && (company.api.includes('greenhouse') || company.api.includes('boards-api'))) {
    return providers.greenhouse;
  }

  // 2. Otherwise run each provider's detect logic
  for (const provider of Object.values(providers)) {
    try {
      const hit = provider.detect(company);
      if (hit) return provider;
    } catch {
      // Ignore detection errors
    }
  }
  return null;
}

// Early-career qualifier: internships, co-ops, plus new-grad / entry-level roles.
const EARLY_CAREER = /\bintern(ship)?s?\b|\bco-?ops?\b|\bcoop\b|\bstudent\b|\bfellow(ship)?\b|\bnew[-\s]?grad(uate)?\b|\buniversity (graduate|grad|hire)\b|\bearly[-\s]?(career|talent)\b|\bcampus\b|\bapprentice(ship)?\b|\bworking student\b|\bgraduate (program(me)?|scheme|engineer|developer|analyst)\b|\bentry[-\s]?level\b/i;

// Technical role signal — SWE, ML/AI, data, research, systems, security, hardware, quant.
// Restricts the tracker to engineering/science roles so business internships drop off.
const TECH_ROLE = /\b(software|swe|sde|develop(er|ment)|programmer|full[-\s]?stack|back[-\s]?end|front[-\s]?end|mobile|ios|android|web dev|devops|sre|site reliability|infrastructure|platform|cloud|distributed|embedded|firmware|hardware|silicon|asic|fpga|vlsi|systems?|robotics|autonom(y|ous)|perception|computer vision|nlp|natural language|machine learning|deep learning|ml|ai|artificial intelligence|data scien(ce|tist)|data engineer|data analy(st|tics)|analytics|research scien(ce|tist)|research engineer|applied scien(ce|tist)|quant(itative)?|security|cyber|cryptograph|blockchain|graphics|compiler|network|engineer(ing)?|comput(er|ing) scien|cs)\b/i;

// Non-technical / business roles to drop even when they trip a tech keyword
// (e.g. "Business Development", "Sales Engineer", "Financial Data Analyst").
const BUSINESS_EXCLUDE = /\b(tax|audit|accounting|actuar\w*|wealth|sales|marketing|recruit\w*|human resources|hr|legal|counsel|paralegal|financ\w*|procurement|underwriting|real estate|communications|public relations|administrative|receptionist|talent acquisition|business develop\w*|corporate develop\w*|supply chain|supply planning)\b/i;

// North America tech early-career filter (accepts any open season/year).
function isTechEarlyCareerNA(job) {
  const title = job.title || '';
  const location = (job.location || '').toLowerCase();

  // 1. Must be an early-career role (intern/co-op/new-grad/...) that is technical
  //    and not a business function.
  if (!EARLY_CAREER.test(title)) return false;
  if (!TECH_ROLE.test(title)) return false;
  if (BUSINESS_EXCLUDE.test(title)) return false;

  // 2. Location Check (North America or Remote).
  // Keep postings with no usable city — Workday collapses multi-city roles into
  // "Multiple Locations" or "N Locations", which routinely include NA offices.
  const isUnknownLocation = !location.trim() || /multiple locations|\d+\s+locations?/i.test(location);
  const isNorthAmerica = /united states|usa|\bus\b|canada|remote/i.test(location) ||
                         /toronto|waterloo|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|san francisco|new york|seattle|boston|chicago|austin|palo alto|mountain view|sunnyvale|los angeles|denver|atlanta|dallas|houston/i.test(location);
  if (!isNorthAmerica && !isUnknownLocation) return false;

  return true;
}

// Concurrency queue
async function runConcurrent(tasks, limit) {
  const results = [];
  const executing = new Set();
  
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function main() {
  try {
    console.log("Starting 2027 North America Internship Scraper (using modular providers)...");

    // Load companies
    if (!fs.existsSync(COMPANIES_PATH)) {
      throw new Error(`Companies list not found at ${COMPANIES_PATH}`);
    }
    const companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8')).filter(c => c.enabled);
    console.log(`Loaded ${companies.length} active companies.`);

    // Load history
    let history = [];
    if (fs.existsSync(HISTORY_PATH)) {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
    console.log(`Loaded ${history.length} jobs from history.`);

    const activeJobs = [];
    const scannedCompanies = new Set();
    const ctx = makeHttpCtx();

    // Build scraping tasks
    const tasks = companies.map(company => async () => {
      const provider = detectProvider(company);
      if (!provider) {
        console.warn(`[WARN] Skipping ${company.name}: no provider matched careers_url or api.`);
        return;
      }

      try {
        const parsed = await provider.fetch(company, ctx);
        const filtered = parsed.map(j => ({
          title: j.title || '',
          url: j.url || '',
          company: company.name,
          location: j.location || 'Canada',
        })).filter(isTechEarlyCareerNA);

        activeJobs.push(...filtered);
        scannedCompanies.add(company.name);
        console.log(`[SUCCESS] Scanned ${company.name} via ${provider.id} — found ${filtered.length} matching roles.`);
      } catch (err) {
        console.warn(`[ERROR] Scanning ${company.name} failed: ${err.message}`);
      }
    });

    // Run crawler
    await runConcurrent(tasks, CONCURRENCY_LIMIT);
    console.log(`Finished scanning. Found ${activeJobs.length} active matching jobs.`);

    // Merge with history
    const today = new Date().toISOString().split('T')[0];
    
    // Mark all previously active jobs from scanned companies as Closed if they are not in activeJobs
    history = history.map(job => {
      if (job.status === 'Active' && scannedCompanies.has(job.company)) {
        const isStillActive = activeJobs.some(active => 
          active.url === job.url || (active.company === job.company && active.title === job.title)
        );
        if (!isStillActive) {
          return { ...job, status: 'Closed' };
        }
      }
      return job;
    });

    // Add new active jobs to history
    activeJobs.forEach(active => {
      const exists = history.some(h => 
        h.url === active.url || (h.company === active.company && h.title === active.title)
      );
      if (!exists) {
        history.push({
          ...active,
          status: 'Active',
          date_added: today,
        });
      } else {
        // If it exists, make sure it's marked as Active
        history = history.map(h => {
          if (h.url === active.url || (h.company === active.company && h.title === active.title)) {
            return { ...h, status: 'Active' };
          }
          return h;
        });
      }
    });

    // Sort history (Active first, then by date added descending, then by company name)
    history.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'Active' ? -1 : 1;
      }
      if (a.date_added !== b.date_added) {
        return b.date_added.localeCompare(a.date_added);
      }
      return a.company.localeCompare(b.company);
    });

    // Save history
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
    console.log(`Updated history file. Total records: ${history.length}`);

    // Generate README.md
    generateREADME(history, today);
    console.log("README.md generated successfully!");

  } catch (error) {
    console.error("Crawler failed:", error);
    process.exit(1);
  }
}

function generateREADME(jobs, dateStr) {
  const activeJobs = jobs.filter(j => j.status === 'Active');
  const closedJobs = jobs.filter(j => j.status === 'Closed');

  const activeTable = activeJobs.length > 0
    ? activeJobs.map(j => `| **${j.company}** | ${j.title} | \`${j.location}\` | 🟢 Active | [Apply ↗](${j.url}) | ${j.date_added} |`).join('\n')
    : '| - | *No active postings found yet. Scraper runs every 12 hours!* | - | - | - | - |';

  const closedTable = closedJobs.length > 0
    ? closedJobs.map(j => `| **${j.company}** | ${j.title} | \`${j.location}\` | 🔴 Closed | [Link ↗](${j.url}) | ${j.date_added} |`).join('\n')
    : '| - | *No closed postings yet.* | - | - | - | - |';

  const content = `# 🍁 North America Tech Internships & Co-ops (Rolling)

[![Scraper Status](https://img.shields.io/badge/scraper-automated-blueviolet?style=flat-square)](https://github.com/jerrylin-23/2027-canada-internships/actions)
[![Active Postings](https://img.shields.io/badge/active%20postings-${activeJobs.length}-green?style=flat-square)](#-active-postings-${activeJobs.length})
[![Last Scanned](https://img.shields.io/badge/last%20scanned-${dateStr}-blue?style=flat-square)](https://github.com/jerrylin-23/2027-canada-internships)
[![GitHub stars](https://img.shields.io/github/stars/jerrylin-23/2027-canada-internships?style=social)](https://github.com/jerrylin-23/2027-canada-internships/stargazers)

An automated repository tracking Software Engineering (SWE), Machine Learning (ML), Data Science (DS), Quantitative Research/Trading, and Product Management internships & co-ops in Canada and the United States (Rolling & Year-Round).

> 🤖 **Automated Scraper:** This tracker scans Greenhouse, Lever, Ashby, SmartRecruiters, and Workday job boards — plus direct Big Tech portals (Amazon, NVIDIA, Netflix, Salesforce, Adobe) — for **200+ top tech companies** and updates automatically every 12 hours using GitHub Actions.
> 💡 **Search Tip:** Press \`⌘+F\` or \`Ctrl+F\` to filter by location (e.g., "Toronto", "Vancouver", "Montreal", "San Francisco") or term.

---

## 📈 Active Postings (${activeJobs.length})

| Company | Role | Location | Status | Link | Date Added |
|---------|------|----------|--------|------|------------|
${activeTable}

---

## 🔄 Year-Round & Student Pipelines

Major tech, quant, and finance year-round application portals:

| Company | Portal Link | Description |
|---------|-------------|-------------|
| **Google** | [Google Students ↗](https://buildyourfuture.withgoogle.com/) | Student internships, scholarships, and opportunities |
| **Microsoft** | [Microsoft Students ↗](https://careers.microsoft.com/us/en/student-programs) | Internships and full-time opportunities for students & new grads |
| **Apple** | [Apple Students ↗](https://www.apple.com/careers/us/students.html) | Summer internships and co-op placements |
| **Meta** | [Meta Careers for Students ↗](https://www.metacareers.com/areas-of-work/students/) | Meta University and student internships |
| **Amazon** | [Amazon Student Programs ↗](https://www.amazon.jobs/en/business_categories/student-programs) | Global software development and tech internships |
| **Tesla** | [Tesla Internships ↗](https://www.tesla.com/careers/internships) | Year-round rolling internships (Spring, Summer, Fall) |
| **NVIDIA** | [NVIDIA Students ↗](https://www.nvidia.com/en-us/about-nvidia/careers/students/) | Internship programs in AI, gaming, and deep learning |
| **Bloomberg** | [Bloomberg Early Careers ↗](https://www.bloomberg.com/company/careers/early-careers/) | Tech and software engineering early careers programs |
| **Jane Street** | [Jane Street Positions ↗](https://www.janestreet.com/join-jane-street/position-finder/) | Quantitative trading and engineering rolling applications |
| **Citadel** | [Citadel Student Careers ↗](https://www.citadel.com/careers/students/) | Software engineering and quant internships |

---

## 🔒 Closed Postings (${closedJobs.length})

| Company | Role | Location | Status | Link | Date Added |
|---------|------|----------|--------|------|------------|
${closedTable}

---

## 🛠️ How it Works
This repository uses the same robust, zero-token scraper engine as [career-ops](https://github.com/santifer/career-ops) to query Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Workable, and Workday APIs directly for **200+ North American employers**.

### Run locally
\`\`\`bash
npm install
node crawl.js
\`\`\`

---

## 🤝 Contributing & Requesting Companies
Want to add a company or a missing job board? 
1. Fork this repository.
2. Add the company metadata to [companies.json](./companies.json).
3. Open a Pull Request. The GitHub Action will automatically scan the new company within 12 hours.

*Star the repository to stay updated! ⭐*
`;

  fs.writeFileSync(README_PATH, content);
}

main();