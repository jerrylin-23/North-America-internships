import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isTechEarlyCareerNA, mergeHistory, uniqueBoards, detectProvider, runConcurrent } from '../crawl.js';
import greenhouse from '../providers/greenhouse.mjs';
import lever from '../providers/lever.mjs';
import workday from '../providers/workday.mjs';
import { parseSmartRecruitersResponse } from '../providers/smartrecruiters.mjs';

for (const location of ['Toronto, ON', 'Montréal, QC', 'San Mateo, CA', 'Remote - Canada', 'United States', 'Pittsburgh, PA', 'U.S. Remote']) {
  test(`accepts technical internship in ${location}`, () => assert.ok(isTechEarlyCareerNA({title:'Software Engineering Intern',location})));
}
for (const location of ['India, Multiple Locations', '2 Locations', '', 'Remote - Germany', 'Remote', 'London, UK']) {
  test(`rejects unconfirmed Canada/US location: ${location}`, () => assert.equal(isTechEarlyCareerNA({title:'Software Engineering Intern',location}),false));
}
test('role filters exclude campus security and include product internships', () => {
  for(const title of ['Global Security Manager, Campus Security','Sales Engineer Intern','Senior Software Engineer']) assert.equal(isTechEarlyCareerNA({title,location:'Toronto'}),false);
  for(const title of ['Product Management Intern','Software Developer - New Graduate']) assert.ok(isTechEarlyCareerNA({title,location:'Toronto'}));
});
test('merge uses URLs, updates metadata, reopens roles, and preserves failed boards', () => {
  const old=[{company:'A',title:'Intern',url:'https://a/1',location:'Old',status:'Closed',date_added:'2026-01-01'}, {company:'B',url:'https://b/1',status:'Active'}, {company:'A',url:'https://a/gone',status:'Active'}];
  const fresh=[{company:'A',title:'Intern',url:'https://a/1',location:'Toronto'}, {company:'A',title:'Intern',url:'https://a/2',location:'Vancouver'}];
  const merged=mergeHistory(old,[...fresh,...fresh],new Set(['A']),'2026-09-20');
  assert.equal(merged.length,4);
  assert.equal(merged[0].status,'Active');
  assert.equal(merged[0].date_added,'2026-01-01');
  assert.equal(merged[0].location,'Toronto');
  assert.equal(merged[1].status,'Active');
  assert.equal(merged[2].status,'Closed');
  assert.equal(merged[3].date_added,'2026-09-20');
});
test('same Ashby board in two URL formats is scanned once', () => {
  assert.equal(uniqueBoards([{careers_url:'https://jobs.ashbyhq.com/cohere'}, {careers_url:'https://cohere.ashbyhq.com/'}]).length,1);
});
test('configured boards are unique and added boards have providers', () => {
  const companies=JSON.parse(fs.readFileSync(new URL('../companies.json',import.meta.url)));
  assert.equal(uniqueBoards(companies).length,companies.length);
  for(const company of companies.slice(-33)) assert.ok(detectProvider(company),company.name);
});
test('malformed responses do not look like empty boards', async () => {
  const ctx={fetchJson:async()=>({error:'unavailable'})};
  await assert.rejects(greenhouse.fetch({careers_url:'https://job-boards.greenhouse.io/test'},ctx),/invalid response/);
  await assert.rejects(lever.fetch({careers_url:'https://jobs.lever.co/test'},ctx),/invalid response/);
  await assert.rejects(workday.fetch({careers_url:'https://test.wd1.myworkdayjobs.com/External'},ctx),/invalid response/);
});
test('Workday stops at reported total, but rejects a truncated scan', async () => {
  let calls=0;
  const entry={careers_url:'https://test.wd1.myworkdayjobs.com/External'};
  const jobPostings=Array.from({length:20},(_,i)=>({externalPath:`/job/${i}`}));
  assert.equal((await workday.fetch(entry,{fetchJson:async()=>{calls++;return {jobPostings,total:20};}})).length,20);
  assert.equal(calls,1);
  await assert.rejects(workday.fetch(entry,{fetchJson:async()=>({jobPostings,total:1001})}),/incomplete scan/);
});
test('Workday keeps the first-page total when later pages report zero', async () => {
  let calls = 0;
  const jobPostings = Array.from({ length: 20 }, (_, i) => ({ externalPath: `/job/${i}` }));
  const jobs = await workday.fetch({ careers_url: 'https://test.wd1.myworkdayjobs.com/External' }, {
    fetchJson: async () => ({ jobPostings, total: calls++ === 0 ? 60 : 0 }),
  });
  assert.equal(calls, 3);
  assert.equal(jobs.length, 60);
});

test('concurrency stays within the limit', async () => {
  let running=0, peak=0;
  const result=await runConcurrent(Array.from({length:12},(_,i)=>async()=>{running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,2));running--;return i;}),3);
  assert.equal(peak,3); assert.equal(result.length,12);
});

test('SmartRecruiters links use the public posting path', () => {
  const [job] = parseSmartRecruitersResponse({ content: [{
    id: '123', name: 'Software Intern',
    ref: 'https://api.smartrecruiters.com/v1/companies/ServiceNow/postings/123',
    location: { city: 'Toronto', country: 'Canada' },
  }] }, 'ServiceNow');
  assert.equal(job.url, 'https://jobs.smartrecruiters.com/ServiceNow/123');
});
