import { describe, expect, it } from 'vitest';
import { approvalDetail, approvalTitle, collectNames, knownOnFile, nameIn, withoutPoolSide } from '@/lib/chat/change-titles';

const ID = '33333333-3333-4333-8333-333333333333';
const names = collectNames([{ tool: 'listJobs', output: { total: 1, jobs: [{ id: ID, name: 'Sales Executive' }] } }]);
const find = (id: unknown, kind?: string) => names[`${kind}:${id}`] ?? null;

describe('approval titles for jobs', () => {
  it('names a job from an earlier listJobs', () => {
    expect(names[`job:${ID}`]).toBe('Sales Executive');
  });
  it('says what will happen', () => {
    expect(approvalTitle('createJob', { title: 'Barista' }, find as never)).toBe('Create job “Barista” as a draft?');
    expect(approvalTitle('updateJob', { id: ID }, find as never)).toBe('Save changes to job “Sales Executive”?');
    expect(approvalTitle('setJobStatus', { id: ID, status: 'open' }, find as never)).toBe('Open job “Sales Executive”?');
    expect(approvalTitle('setJobStatus', { id: ID, status: 'paused' }, find as never)).toBe('Pause job “Sales Executive”?');
    expect(approvalTitle('setJobStatus', { id: ID, status: 'closed' }, find as never)).toBe('Close job “Sales Executive”?');
    expect(approvalTitle('deleteJob', { id: ID }, find as never)).toBe('Delete job “Sales Executive”?');
    expect(approvalTitle('deleteJob', { id: 'unknown' }, find as never)).toBe('Delete this job?');
  });
  it('warns that a delete cannot be undone', () => {
    expect(approvalDetail('deleteJob')).toBe('This cannot be undone.');
  });
  it('has no changes line without a usable input, and leaves other tools alone', () => {
    expect(approvalDetail('updateJob')).toBeNull();
    expect(approvalDetail('updateJob', undefined)).toBeNull();
    expect(approvalDetail('updateJob', null)).toBeNull();
    expect(approvalDetail('updateJob', 'text')).toBeNull();
    expect(approvalDetail('deleteCampaign')).toBe('This cannot be undone.');
  });
  it('lists what an edit changes, with the salary and the closing date it would save', () => {
    expect(approvalDetail('updateJob', { id: ID, title: 'x', salary_min_cents: 300_000, salary_max_cents: 450_000, closes_on: '2026-10-31' }))
      .toBe('Changes: title, salary (RM 3,000 – RM 4,500 a month), closing date (31 Oct 2026)');
    expect(approvalDetail('updateJob', { id: ID, headcount: 2, show_salary: true })).toBe('Changes: salary visibility, headcount');
    expect(approvalDetail('updateJob', { id: ID })).toBeNull();
  });
  it('says when an edit clears the closing date or the salary', () => {
    expect(approvalDetail('updateJob', { id: ID, closes_on: null })).toBe('Changes: closing date (none)');
    expect(approvalDetail('updateJob', { id: ID, salary_min_cents: null, salary_max_cents: null })).toBe('Changes: salary (not stated)');
    // One bound alone: the other stays as stored, so the card does not claim the whole salary is gone.
    expect(approvalDetail('updateJob', { id: ID, salary_min_cents: null })).toBe('Changes: salary (no minimum)');
    expect(approvalDetail('updateJob', { id: ID, salary_max_cents: 450_050 })).toBe('Changes: salary (up to RM 4,500.50 a month)');
  });
  it('shows the salary and closing date of a new job', () => {
    expect(approvalDetail('createJob', {
      title: 'Barista', department: 'Operations', location: 'Shah Alam',
      salary_min_cents: 300_000, salary_max_cents: 450_000, closes_on: '2026-10-31',
    })).toBe('Operations · Shah Alam · RM 3,000 – RM 4,500 a month · closes 31 Oct 2026');
    expect(approvalDetail('createJob', { title: 'Barista', salary_min_cents: 300_000 })).toBe('from RM 3,000 a month');
    expect(approvalDetail('createJob', { title: 'Barista', salary_max_cents: 1_000_000_000, closes_on: '2026-01-05' }))
      .toBe('up to RM 10,000,000 a month · closes 5 Jan 2026');
  });
  it('has no second line for a new job with nothing extra, or without a usable input', () => {
    expect(approvalDetail('createJob', { title: 'Barista' })).toBeNull();
    expect(approvalDetail('createJob', { title: 'Barista', department: ' ', salary_min_cents: null, closes_on: null })).toBeNull();
    expect(approvalDetail('createJob')).toBeNull();
    expect(approvalDetail('createJob', null)).toBeNull();
    expect(approvalDetail('createJob', 'text')).toBeNull();
  });
});

describe('the careers page change', () => {
  it('is named by what it does', () => {
    expect(approvalTitle('updateCareersPage', { careers_enabled: true })).toBe('Turn on the public careers page?');
    expect(approvalTitle('updateCareersPage', { careers_enabled: false })).toBe('Turn off the public careers page?');
    expect(approvalTitle('updateCareersPage', { careers_headline: 'Join us' })).toBe('Save changes to the careers page?');
  });
  it('says what turning it on exposes, and shows the words being saved', () => {
    expect(approvalDetail('updateCareersPage', { careers_enabled: true }))
      .toBe('Your open jobs become visible to anyone with the link, and can appear in search engines.');
    expect(approvalDetail('updateCareersPage', { careers_enabled: true, careers_headline: 'Join us' }))
      .toBe('Your open jobs become visible to anyone with the link, and can appear in search engines. · Headline: “Join us”');
    expect(approvalDetail('updateCareersPage', { careers_headline: '', careers_tagline: 'Good coffee' }))
      .toBe('Headline: none · Tagline: “Good coffee”');
    expect(approvalDetail('updateCareersPage', { careers_enabled: false })).toBe('The page and every job page stop being public.');
    expect(approvalDetail('updateCareersPage', null)).toBeNull();
    expect(approvalDetail('updateCareersPage', 'text')).toBeNull();
  });
});

describe('the application form change', () => {
  it('is named by what it does', () => {
    expect(approvalTitle('updateApplicationForm', { require_cv: true })).toBe('Require a CV on applications?');
    expect(approvalTitle('updateApplicationForm', { require_cv: false })).toBe('Stop requiring a CV on applications?');
    expect(approvalTitle('updateApplicationForm', { ask_expected_salary: false })).toBe('Stop asking for expected salary on applications?');
    expect(approvalTitle('updateApplicationForm', { ask_portfolio: true })).toBe('Ask for a portfolio link on applications?');
    // Several at once: one question, and the detail line lists them.
    expect(approvalTitle('updateApplicationForm', { require_cv: true, ask_portfolio: false })).toBe('Change what the application form asks for?');
    expect(approvalTitle('updateApplicationForm', {})).toBe('Change what the application form asks for?');
  });
  it('lists each switch being changed when there is more than one', () => {
    expect(approvalDetail('updateApplicationForm', { require_cv: true, ask_portfolio: false }))
      .toBe('Require a CV · Stop asking for a portfolio link');
    // One change is already the title.
    expect(approvalDetail('updateApplicationForm', { require_cv: true })).toBeNull();
    expect(approvalDetail('updateApplicationForm', null)).toBeNull();
  });
});

describe('approval cards for an application', () => {
  const APP = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const STRANGER = '66666666-6666-4666-8666-666666666666';
  const listed = {
    tool: 'listApplications',
    output: {
      total: 2,
      applications: [
        { id: APP, candidate: 'Aina Rahman', job: 'Barista', stage: 'screening', outcome: 'active' },
        { id: OTHER, candidate: 'Hafiz Omar', job: 'Cashier', stage: 'applied', outcome: 'active' },
      ],
    },
  };
  const found = nameIn([listed]);
  const nothing = nameIn([]);

  it('names an application from a listApplications row, as candidate (job)', () => {
    const known = collectNames([listed]);
    expect(known[`application:${APP}`]).toBe('Aina Rahman (Barista)');
    expect(known[`application:${OTHER}`]).toBe('Hafiz Omar (Cashier)');
  });
  it('does not turn a row of another tool into an application name', () => {
    const other = collectNames([{ tool: 'listJobs', output: { jobs: [{ id: APP, name: 'Sales Executive', candidate: 'X', job: 'Y' }] } }]);
    expect(other[`application:${APP}`]).toBeUndefined();
    expect(other[`job:${APP}`]).toBe('Sales Executive');
  });
  it('words a move', () => {
    expect(approvalTitle('moveApplication', { id: APP, stage: 'interview' }, found)).toBe('Move Aina Rahman (Barista) to Interview?');
    expect(approvalTitle('moveApplication', { id: APP, stage: 'offer' }, found)).toBe('Move Aina Rahman (Barista) to Offer?');
  });
  it('words a rejection and a withdrawal, with the reason on the detail line', () => {
    expect(approvalTitle('rejectApplication', { id: APP, outcome: 'rejected' }, found)).toBe('Reject Aina Rahman (Barista)?');
    expect(approvalTitle('rejectApplication', { id: APP, outcome: 'withdrawn' }, found)).toBe('Mark Aina Rahman (Barista) as withdrawn?');
    expect(approvalDetail('rejectApplication', { id: APP, outcome: 'rejected', reason: 'experience' })).toBe('Reason: Not enough experience');
    expect(approvalDetail('rejectApplication', { id: APP, outcome: 'rejected', reason: 'not_reachable' })).toBe('Reason: Could not reach the candidate');
    expect(approvalDetail('rejectApplication', { id: APP, outcome: 'rejected' })).toBeNull();
    expect(approvalDetail('rejectApplication', { id: APP, outcome: 'rejected', reason: null })).toBeNull();
    expect(approvalDetail('rejectApplication', { id: APP, outcome: 'rejected', reason: 'made up' })).toBeNull();
  });
  it('words a reopen and a rating', () => {
    expect(approvalTitle('reopenApplication', { id: APP }, found)).toBe('Reopen Aina Rahman (Barista)?');
    expect(approvalTitle('rateApplication', { id: APP, rating: 4 }, found)).toBe('Rate Aina Rahman (Barista) 4 out of 5?');
    expect(approvalTitle('rateApplication', { id: APP, rating: null }, found)).toBe('Clear the rating of Aina Rahman (Barista)?');
  });
  it('puts the grounds for a rating on the detail line, and nothing when there are none', () => {
    expect(approvalDetail('rateApplication', { id: APP, rating: 3, basis: 'Six years in B2B sales, but no key account work.' }))
      .toBe('Why: Six years in B2B sales, but no key account work.');
    // Trimmed, and one paragraph whatever the line breaks.
    expect(approvalDetail('rateApplication', { id: APP, rating: 3, basis: '  Six years in sales.\n\n  No tender work.  ' }))
      .toBe('Why: Six years in sales. No tender work.');
    expect(approvalDetail('rateApplication', { id: APP, rating: 3 })).toBeNull();
    expect(approvalDetail('rateApplication', { id: APP, rating: 3, basis: '   ' })).toBeNull();
    expect(approvalDetail('rateApplication', { id: APP, rating: 3, basis: null })).toBeNull();
    expect(approvalDetail('rateApplication', { id: APP, rating: 3, basis: 7 })).toBeNull();
    // Only a rating carries one.
    expect(approvalDetail('moveApplication', { id: APP, stage: 'offer', basis: 'x' })).toBeNull();
    expect(approvalDetail('reopenApplication', { id: APP, basis: 'x' })).toBeNull();
  });
  it('says "this application" when the conversation never listed it', () => {
    expect(approvalTitle('moveApplication', { id: STRANGER, stage: 'offer' }, found)).toBe('Move an application that was not in the list above to Offer?');
    expect(approvalTitle('rejectApplication', { id: STRANGER, outcome: 'rejected' }, nothing)).toBe('Reject an application that was not in the list above?');
    expect(approvalTitle('rejectApplication', { id: STRANGER, outcome: 'withdrawn' }, nothing)).toBe('Mark an application that was not in the list above as withdrawn?');
    expect(approvalTitle('reopenApplication', { id: STRANGER }, nothing)).toBe('Reopen an application that was not in the list above?');
    expect(approvalTitle('rateApplication', { id: STRANGER, rating: 2 }, nothing)).toBe('Rate an application that was not in the list above 2 out of 5?');
    expect(approvalTitle('rateApplication', { id: STRANGER, rating: null }, nothing)).toBe('Clear the rating of an application that was not in the list above?');
    expect(approvalTitle('moveApplication', { id: STRANGER, stage: 'offer' })).toBe('Move an application that was not in the list above to Offer?');
  });
  it('also learns the name from the row a change tool returned', () => {
    const results = [{ tool: 'rateApplication', output: { ok: true, data: { id: APP, candidate: 'Aina Rahman', job: 'Barista' } } }];
    expect(collectNames(results)[`application:${APP}`]).toBe('Aina Rahman (Barista)');
    expect(approvalTitle('reopenApplication', { id: APP }, nameIn(results))).toBe('Reopen Aina Rahman (Barista)?');
  });
});

describe('approval cards for a candidate', () => {
  const CAND = '77777777-7777-4777-8777-777777777777';
  const JOB = '88888888-8888-4888-8888-888888888888';
  const STRANGER = '99999999-9999-4999-8999-999999999999';
  const listed = { tool: 'listCandidates', output: { total: 1, candidates: [{ id: CAND, name: 'Aina Rahman', applications: 2 }] } };
  const jobs = { tool: 'listJobs', output: { total: 1, jobs: [{ id: JOB, name: 'Barista', title: 'Barista' }] } };
  const found = nameIn([listed, jobs]);
  const nothing = nameIn([]);

  it('names a candidate from a listCandidates row, and from what addCandidate and updateCandidate returned', () => {
    expect(collectNames([listed])[`candidate:${CAND}`]).toBe('Aina Rahman');
    const added = [{ tool: 'addCandidate', output: { ok: true, data: { id: CAND, name: 'Aina Rahman', job_id: JOB, job: 'Barista', message: 'Added Aina Rahman.' } } }];
    const known = collectNames(added);
    expect(known[`candidate:${CAND}`]).toBe('Aina Rahman');
    // Only the candidate is named, with the mark that the name came from a lookup of everyone on file: the job is not.
    expect(Object.keys(known)).toEqual([`candidate:${CAND}`, `candidate-on-file:${CAND}`]);
    const saved = [{ tool: 'updateCandidate', output: { ok: true, data: { id: CAND, name: 'Aina R.' } } }];
    expect(collectNames(saved)[`candidate:${CAND}`]).toBe('Aina R.');
  });
  it('does not take a job or an application row for a candidate', () => {
    expect(collectNames([jobs])[`candidate:${JOB}`]).toBeUndefined();
    expect(found(JOB, 'candidate')).toBeNull();
    expect(found(CAND, 'job')).toBeNull();
    expect(found(CAND, 'candidate')).toBe('Aina Rahman');
  });
  it('words an add and an edit', () => {
    expect(approvalTitle('addCandidate', { name: 'Aina Rahman' }, found)).toBe('Add candidate “Aina Rahman”?');
    expect(approvalTitle('updateCandidate', { id: CAND, headline: 'x' }, found)).toBe('Save changes to candidate “Aina Rahman”?');
  });
  it('says so when the conversation never listed the candidate', () => {
    expect(approvalTitle('updateCandidate', { id: STRANGER, headline: 'x' }, found)).toBe('Save changes to a candidate that was not in the list above?');
    expect(approvalTitle('updateCandidate', { id: STRANGER, headline: 'x' }, nothing)).toBe('Save changes to a candidate that was not in the list above?');
    expect(approvalTitle('updateCandidate', { id: STRANGER, headline: 'x' })).toBe('Save changes to a candidate that was not in the list above?');
  });
  it('lists what an add sets, the job by its title, the email shown and the phone only named', () => {
    expect(approvalDetail('addCandidate', {
      name: 'Aina Rahman', job_id: JOB, email: ' aina@example.com ', phone: '+60 12-345 6789', headline: 'Barista', location: 'Shah Alam',
      skills: ['Latte art', 'POS'], source: 'Referral', cover_letter: 'Hello', cv_url: 'https://example.com/cv',
    }, undefined, found)).toBe(
      'Sets: job (Barista), email (aina@example.com), phone, headline, location, skills (Latte art, POS), source, cover note, CV link',
    );
    expect(approvalDetail('addCandidate', { name: 'Aina Rahman', phone: '+60 12-345 6789' }, undefined, found)).toBe('Sets: phone');
  });
  it('names a job that was not looked up without a title, and says nothing for an add with only a name', () => {
    expect(approvalDetail('addCandidate', { name: 'Aina Rahman', job_id: STRANGER }, undefined, found)).toBe('Sets: job');
    expect(approvalDetail('addCandidate', { name: 'Aina Rahman', job_id: JOB })).toBe('Sets: job');
    expect(approvalDetail('addCandidate', { name: 'Aina Rahman' }, undefined, found)).toBeNull();
    // A new person has nothing to clear: a null or blank field sets nothing.
    expect(approvalDetail('addCandidate', { name: 'Aina Rahman', job_id: null, email: '', headline: null, skills: [] }, undefined, found)).toBeNull();
  });
  it('lists what an edit changes, and says "(cleared)" for a field sent null or blank', () => {
    expect(approvalDetail('updateCandidate', { id: CAND, name: 'Aina R.', email: 'a@example.com', phone: '012', headline: 'Lead barista', location: 'Klang', skills: ['POS'], source: 'Walk-in' }, undefined, found))
      .toBe('Changes: name, email (a@example.com), phone, headline, location, skills (POS), source');
    expect(approvalDetail('updateCandidate', { id: CAND, email: null, phone: '', headline: '  ', skills: [], source: null }, undefined, found))
      .toBe('Changes: email (cleared), phone (cleared), headline (cleared), skills (cleared), source (cleared)');
    expect(approvalDetail('updateCandidate', { id: CAND, phone: '+60 12-345 6789' }, undefined, found)).toBe('Changes: phone');
  });
  it('has no second line for an edit that sends nothing, or without a usable input', () => {
    expect(approvalDetail('updateCandidate', { id: CAND }, undefined, found)).toBeNull();
    expect(approvalDetail('updateCandidate')).toBeNull();
    expect(approvalDetail('updateCandidate', 'text')).toBeNull();
  });
});

describe('approval cards for a deletion', () => {
  const APP = '77777777-7777-4777-8777-777777777777';
  const PERSON = '88888888-8888-4888-8888-888888888888';
  const STRANGER = '99999999-9999-4999-8999-999999999999';
  const applications = { tool: 'listApplications', output: { total: 1, applications: [{ id: APP, candidate: 'Aina Rahman', job: 'Sales Executive' }] } };
  const candidates = { tool: 'listCandidates', output: { total: 1, candidates: [{ id: PERSON, name: 'Aina Rahman', applications: 2 }] } };
  const found = nameIn([applications, candidates]);

  it('names the person and the job on an application\'s card, and says what else goes', () => {
    expect(approvalTitle('deleteApplication', { id: APP }, found)).toBe('Delete the application of Aina Rahman (Sales Executive)?');
    expect(approvalDetail('deleteApplication', { id: APP }, undefined, found))
      .toBe('Its interviews and its CV file are deleted too. The candidate stays on file. This cannot be undone.');
  });
  it('names the person on a candidate\'s card, and says what else goes', () => {
    expect(approvalTitle('deleteCandidate', { id: PERSON }, found)).toBe('Delete candidate “Aina Rahman”?');
    expect(approvalDetail('deleteCandidate', { id: PERSON }, undefined, found))
      .toBe('Every application, interview and CV file of theirs is deleted too. This cannot be undone.');
  });
  it('never names someone from an id of the other kind, or one that was not looked up', () => {
    expect(approvalTitle('deleteApplication', { id: PERSON }, found)).toBe('Delete an application that was not in the list above?');
    expect(approvalTitle('deleteApplication', { id: STRANGER }, found)).toBe('Delete an application that was not in the list above?');
    expect(approvalTitle('deleteApplication', { id: APP })).toBe('Delete an application that was not in the list above?');
    expect(approvalTitle('deleteCandidate', { id: APP }, found)).toBe('Delete a candidate that was not in the list above?');
    expect(approvalTitle('deleteCandidate', { id: STRANGER }, found)).toBe('Delete a candidate that was not in the list above?');
    expect(approvalTitle('deleteCandidate', {})).toBe('Delete a candidate that was not in the list above?');
  });
  it('carries the warning whatever the input, and no number the model could have made up', () => {
    for (const input of [undefined, null, 'text', { id: APP, applications: 99 }]) {
      expect(approvalDetail('deleteApplication', input)).toMatch(/This cannot be undone\.$/);
      expect(approvalDetail('deleteCandidate', input)).toMatch(/This cannot be undone\.$/);
      expect(approvalDetail('deleteCandidate', input)).not.toMatch(/\d/);
    }
  });
  it('remembers a deleted candidate\'s name, so a later sentence can still say who it was', () => {
    const done = [{ tool: 'deleteCandidate', output: { ok: true, data: { id: PERSON, name: 'Aina Rahman', job: null, applications: 2, interviews: 0, cv_files: 0, message: 'Deleted Aina Rahman, with 2 applications.' } } }];
    expect(collectNames(done)[`candidate:${PERSON}`]).toBe('Aina Rahman');
  });
});

describe('approval cards for the talent pool', () => {
  const PERSON = '88888888-8888-4888-8888-888888888881';
  const JOB = '77777777-7777-4777-8777-777777777771';
  const STRANGER = '99999999-9999-4999-8999-999999999991';
  const candidates = {
    tool: 'listCandidates',
    output: { total: 1, candidates: [{ id: PERSON, name: 'Aina binti Salleh', headline: 'Sales Executive', location: 'Kuala Lumpur', pool_status: 'passive' }] },
  };
  const jobs = { tool: 'listJobs', output: { total: 1, jobs: [{ id: JOB, name: 'Sales Executive' }] } };
  const found = nameIn([candidates, jobs]);

  it('says add, mark or remove, naming the person', () => {
    expect(approvalTitle('setPoolStatus', { id: PERSON, status: 'available', only_if_outside: true }, found))
      .toBe('Add candidate “Aina binti Salleh” to the talent pool as Available?');
    expect(approvalTitle('setPoolStatus', { id: PERSON, status: 'passive' }, found))
      .toBe('Mark candidate “Aina binti Salleh” as Passive in the talent pool?');
    expect(approvalTitle('setPoolStatus', { id: PERSON, status: 're_engaged', only_if_outside: false }, found))
      .toBe('Mark candidate “Aina binti Salleh” as Re-engaged in the talent pool?');
    expect(approvalTitle('setPoolStatus', { id: PERSON, status: 'none' }, found))
      .toBe('Remove candidate “Aina binti Salleh” from the talent pool?');
  });
  it('names the person and the job on a move', () => {
    expect(approvalTitle('moveToPipeline', { id: PERSON, job_id: JOB }, found))
      .toBe('Move candidate “Aina binti Salleh” to the pipeline for “Sales Executive”?');
    expect(approvalTitle('moveToPipeline', { id: PERSON, job_id: STRANGER }, found))
      .toBe('Move candidate “Aina binti Salleh” to the pipeline for a job?');
  });
  it('never names someone from an id of another kind, or one that was not looked up', () => {
    expect(approvalTitle('setPoolStatus', { id: JOB, status: 'passive' }, found)).toBe('Mark a candidate that was not in the list above as Passive in the talent pool?');
    expect(approvalTitle('setPoolStatus', { id: STRANGER, status: 'none' }, found)).toBe('Remove a candidate that was not in the list above from the talent pool?');
    expect(approvalTitle('moveToPipeline', { id: STRANGER, job_id: PERSON }, found)).toBe('Move a candidate that was not in the list above to the pipeline for a job?');
    expect(approvalTitle('setPoolStatus', {})).toBe('Change the talent pool status of a candidate that was not in the list above?');
  });
  it('the second line says what the status means, or what a removal keeps, or what a move does', () => {
    expect(approvalDetail('setPoolStatus', { id: PERSON, status: 'available', only_if_outside: true }, undefined, found))
      .toBe('Available: Open to hearing about a role now.');
    expect(approvalDetail('setPoolStatus', { id: PERSON, status: 'passive' }, undefined, found))
      .toBe('Passive: Not looking right now. Worth keeping in touch for later.');
    expect(approvalDetail('setPoolStatus', { id: PERSON, status: 're_engaged' }, undefined, found))
      .toBe('Re-engaged: You have been back in touch and put them forward for a job again.');
    expect(approvalDetail('setPoolStatus', { id: PERSON, status: 'none' }, undefined, found))
      .toBe('They stay on file with their details and applications.');
    expect(approvalDetail('moveToPipeline', { id: PERSON, job_id: JOB }, undefined, found))
      .toBe('Adds an application at Applied and marks them Re-engaged. They stay in the talent pool.');
  });
  it('has no second line for a status that is not one, or without a usable input', () => {
    expect(approvalDetail('setPoolStatus', { id: PERSON, status: 'shortlisted' }, undefined, found)).toBeNull();
    expect(approvalDetail('setPoolStatus')).toBeNull();
    expect(approvalDetail('setPoolStatus', 'text')).toBeNull();
    // A move's line is fixed: nothing in it comes from the model.
    expect(approvalDetail('moveToPipeline')).toBe('Adds an application at Applied and marks them Re-engaged. They stay in the talent pool.');
  });
  it('an id from the pool lookup counts as a candidate\'s, and never as a job\'s', () => {
    const pool = nameIn([{ tool: 'listTalentPool', output: { total: 1, candidates: [{ id: PERSON, name: 'Aina binti Salleh' }] } }]);
    expect(pool(PERSON, 'candidate')).toBe('Aina binti Salleh');
    expect(pool(PERSON, 'job')).toBeNull();
    expect(approvalTitle('setPoolStatus', { id: PERSON, status: 'none' }, pool)).toBe('Remove candidate “Aina binti Salleh” from the talent pool?');
  });
  it('remembers who a pool change was about, from its result', () => {
    const done = [
      { tool: 'setPoolStatus', output: { ok: true, data: { id: PERSON, name: 'Aina binti Salleh', from: 'none', to: 'available', message: 'Added Aina binti Salleh to the talent pool as Available.' } } },
      { tool: 'moveToPipeline', output: { ok: true, data: { id: STRANGER, name: 'Kamal Ariffin', application_id: JOB, job_id: JOB, job: 'Sales Executive', from: 'available', to: 're_engaged', message: 'x' } } },
    ];
    const kept = collectNames(done);
    expect(kept[`candidate:${PERSON}`]).toBe('Aina binti Salleh');
    expect(kept[`candidate:${STRANGER}`]).toBe('Kamal Ariffin');
  });
});

describe('where a candidate\'s name came from, for a deletion', () => {
  const PERSON = '88888888-8888-4888-8888-888888888882';
  const pooled = { tool: 'listTalentPool', output: { total: 1, candidates: [{ id: PERSON, name: 'Zarina Lau' }] } };
  const changed = { tool: 'setPoolStatus', output: { ok: true, data: { id: PERSON, name: 'Zarina Lau', from: 'none', to: 'available', message: 'x' } } };
  const moved = { tool: 'moveToPipeline', output: { ok: true, data: { id: PERSON, name: 'Zarina Lau', application_id: null, job_id: 'j', job: null, from: 'available', to: 're_engaged', message: 'x' } } };
  const listed = { tool: 'listCandidates', output: { total: 1, candidates: [{ id: PERSON, name: 'Zarina Lau' }] } };

  it('a name known only from the pool\'s side is not known as on file; one from a lookup of everyone is', () => {
    for (const side of [pooled, changed, moved]) {
      const names = collectNames([side]);
      expect(names[`candidate:${PERSON}`], side.tool).toBe('Zarina Lau');
      expect(knownOnFile(names, PERSON), side.tool).toBe(false);
    }
    expect(knownOnFile(collectNames([listed]), PERSON)).toBe(true);
    expect(knownOnFile(collectNames([pooled, listed]), PERSON)).toBe(true);
    expect(knownOnFile(collectNames([listed, pooled]), PERSON)).toBe(true);
    // Two reports put together, as the chat's names are.
    expect(knownOnFile({ ...collectNames([listed]), ...collectNames([pooled]) }, PERSON)).toBe(true);
    // Names kept before there were marks are as they were; someone never named is not known at all.
    expect(knownOnFile({ [`candidate:${PERSON}`]: 'Zarina Lau' }, PERSON)).toBe(true);
    expect(knownOnFile({}, PERSON)).toBe(false);
    expect(knownOnFile(undefined, PERSON)).toBe(false);
    for (const odd of [undefined, null, '', 7]) expect(knownOnFile(collectNames([listed]), odd)).toBe(false);
  });
  it('a name is kept with its mark or not at all, so the cap can never turn a pool-side name into one on file', () => {
    const full = Object.fromEntries(Array.from({ length: 199 }, (_, n) => [`job:${n}`, 'x']));
    const names = collectNames([pooled], full);
    expect(names[`candidate:${PERSON}`]).toBeUndefined();
    expect(knownOnFile(names, PERSON)).toBe(false);
  });
  it('withoutPoolSide drops the pool lookup and the two pool changes, and nothing else', () => {
    expect(withoutPoolSide([pooled, listed, changed, moved]).map((r) => r.tool)).toEqual(['listCandidates']);
    expect(nameIn(withoutPoolSide([pooled]))(PERSON, 'candidate')).toBeNull();
    expect(nameIn([pooled])(PERSON, 'candidate')).toBe('Zarina Lau');
  });
});
