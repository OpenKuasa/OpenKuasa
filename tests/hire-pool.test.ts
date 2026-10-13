// tests/hire-pool.test.ts
import { describe, expect, it } from 'vitest';
import {
  PICKER_CAPPED, PICKER_FAILED, PIPELINE_CARD_DETAIL, POOL_LABEL, POOL_MEANING, POOL_NOT_SENT, POOL_READ_CAPPED, POOL_SAVE_FAILED,
  POOL_SEARCH_MAX, POOL_STATUSES, isInPool, isPoolStatus, matchesPoolSearch, movedMessage, pipelineCardTitle, poolCardDetail,
  poolCardTitle, poolChangedMessage, poolFooter, poolNoMatch, poolRefusal, poolSearchText,
} from '@/lib/hire/pool';

describe('the three statuses', () => {
  it('are named and explained as agreed', () => {
    expect(POOL_STATUSES).toEqual(['available', 'passive', 're_engaged']);
    expect(POOL_LABEL).toEqual({ available: 'Available', passive: 'Passive', re_engaged: 'Re-engaged' });
    expect(POOL_MEANING).toEqual({
      available: 'Open to hearing about a role now.',
      passive: 'Not looking right now. Worth keeping in touch for later.',
      re_engaged: 'You have been back in touch and put them forward for a job again.',
    });
  });
  it('tell a pool status from anything else', () => {
    for (const status of POOL_STATUSES) expect(isInPool(status)).toBe(true);
    for (const other of ['none', 'Available', '', null, undefined, 3]) expect(isInPool(other)).toBe(false);
    expect(isPoolStatus('none')).toBe(true);
    expect(isPoolStatus('passive')).toBe(true);
    expect(isPoolStatus('shortlisted')).toBe(false);
  });
});

describe('what a person reads after a change', () => {
  it('says added, marked or removed, from where the person was and where they are now', () => {
    expect(poolChangedMessage('Aina Rahman', 'none', 'available')).toBe('Added Aina Rahman to the talent pool as Available.');
    expect(poolChangedMessage('Aina Rahman', 'none', 'passive')).toBe('Added Aina Rahman to the talent pool as Passive.');
    expect(poolChangedMessage('Aina Rahman', 'available', 're_engaged')).toBe('Aina Rahman is now marked Re-engaged.');
    expect(poolChangedMessage('Aina Rahman', 'passive', 'none')).toBe('Removed Aina Rahman from the talent pool. They are still on file.');
    // Where they were is not known: it still says where they are now.
    expect(poolChangedMessage('Aina Rahman', null, 'passive')).toBe('Aina Rahman is now marked Passive.');
  });
  it('leaves the name out when it could not be read back', () => {
    expect(poolChangedMessage('', 'none', 'available')).toBe('Added to the talent pool as Available.');
    expect(poolChangedMessage('  ', 'available', 'passive')).toBe('Now marked Passive.');
    expect(poolChangedMessage('', 'passive', 'none')).toBe('Removed from the talent pool. They are still on file.');
  });
  it('says what a move to the pipeline did', () => {
    expect(movedMessage('Aina Rahman', 'Barista')).toBe('Aina Rahman now has an application for Barista at Applied, and is marked Re-engaged.');
    expect(movedMessage('Aina Rahman', null)).toBe('Aina Rahman now has an application for the job at Applied, and is marked Re-engaged.');
    expect(movedMessage('', 'Barista')).toBe('Added an application for Barista at Applied, and marked them Re-engaged.');
  });
});

describe('poolRefusal', () => {
  const about = { name: 'Aina Rahman', job: 'Barista' };
  it('has one sentence for each word', () => {
    expect(poolRefusal('not_found', about)).toBe('That candidate could not be found.');
    expect(poolRefusal('forbidden', about)).toBe('You do not have permission to make changes here.');
    expect(poolRefusal('invalid_status', about)).toBe('Choose Available, Passive or Re-engaged.');
    expect(poolRefusal('already_in_pool', { ...about, from: 'passive' })).toBe('Aina Rahman is already in the talent pool as Passive. Nothing was changed.');
    expect(poolRefusal('job_not_found', about)).toBe('That job could not be found.');
    expect(poolRefusal('job_not_open', about)).toBe('Only an open or paused job can take a new application.');
    expect(poolRefusal('not_in_pool', about)).toBe('Aina Rahman is not in the talent pool. Add them to the pool first.');
  });
  it('has two sentences for the status a person already has: one for a status, one for not being in the pool', () => {
    expect(poolRefusal('same_status', { ...about, from: 're_engaged' })).toBe('Aina Rahman is already marked Re-engaged. Nothing was changed.');
    expect(poolRefusal('same_status', { ...about, from: 'none' })).toBe('Aina Rahman is not in the talent pool. Nothing was changed.');
  });
  it('tells a live application from a closed one', () => {
    expect(poolRefusal('already_applied', { ...about, outcome: 'active' })).toBe('Aina Rahman has already applied for Barista. Nothing was changed.');
    expect(poolRefusal('already_applied', { ...about, outcome: 'rejected' }))
      .toBe('Aina Rahman already has a rejected application for Barista. Reopen it from Applications. Nothing was changed.');
    expect(poolRefusal('already_applied', { ...about, outcome: 'withdrawn' }))
      .toBe('Aina Rahman already has a withdrawn application for Barista. Reopen it from Applications. Nothing was changed.');
    // An outcome that was not sent reads as a live application: the sentence that promises least.
    expect(poolRefusal('already_applied', about)).toBe('Aina Rahman has already applied for Barista. Nothing was changed.');
  });
  it('still makes a sentence without a name, a job or a status', () => {
    expect(poolRefusal('already_in_pool', {})).toBe('This person is already in the talent pool. Nothing was changed.');
    expect(poolRefusal('not_in_pool')).toBe('This person is not in the talent pool. Add them to the pool first.');
    expect(poolRefusal('already_applied', { name: ' ' })).toBe('This person has already applied for that job. Nothing was changed.');
  });
  it('gives the generic sentence for any other word', () => {
    for (const word of ['surprise', '', null, undefined, 7, { word: 'ok' }]) expect(poolRefusal(word, about)).toBe(POOL_SAVE_FAILED);
    expect(POOL_SAVE_FAILED).toBe('That change could not be saved. Please try again.');
    expect(POOL_NOT_SENT).toBe('That change could not be sent. Check your connection and try again.');
  });
});

describe('the pool table\'s search', () => {
  const person = { name: 'Zarina binti Hashim', headline: 'Warehouse Supervisor', location: 'Klang', source: 'Referral', skills: ['Forklift', 'Stock control'] };
  it('reads the text from the address: trimmed, cut to 80, the first of several, and blank is no search', () => {
    expect(poolSearchText('  zarina ')).toBe('zarina');
    expect(poolSearchText(['zarina', 'kamal'])).toBe('zarina');
    expect(poolSearchText('x'.repeat(200))).toHaveLength(POOL_SEARCH_MAX);
    expect(POOL_SEARCH_MAX).toBe(80);
    for (const none of ['', '   ', undefined, null, 5, [], [3]]) expect(poolSearchText(none)).toBeNull();
    // Cut first, then trimmed again: a space left at the cut is not searched for.
    expect(poolSearchText(`${'x'.repeat(79)} y`)).toBe('x'.repeat(79));
  });
  it('matches any part of the name, the headline, the location, the source or one skill, in any letter case', () => {
    for (const text of ['zarina', 'HASHIM', 'house sup', 'klang', 'referr', 'forklift', 'stock c']) {
      expect(matchesPoolSearch(person, text), text).toBe(true);
    }
    for (const text of ['kamal', 'zarina klang', 'forklift, stock']) expect(matchesPoolSearch(person, text), text).toBe(false);
    expect(matchesPoolSearch({ ...person, headline: null, location: null, source: null, skills: [] }, 'zarina')).toBe(true);
    expect(matchesPoolSearch({ ...person, headline: null, location: null, source: null, skills: [] }, 'klang')).toBe(false);
  });
  it('words the line under the table with no search', () => {
    expect(poolFooter({ search: null, matched: 37, shown: 37, size: 37 })).toBe('Showing 37 candidates');
    expect(poolFooter({ search: null, matched: 50, shown: 50, size: 50 })).toBe('Showing 50 candidates');
    expect(poolFooter({ search: null, matched: 51, shown: 50, size: 51 })).toBe('Showing the newest 50 of 51. Search to find anyone else.');
    expect(poolFooter({ search: null, matched: 1137, shown: 50, size: 1137 })).toBe('Showing the newest 50 of 1,137. Search to find anyone else.');
  });
  it('words it with a search, for 0, 1, 2, 50 and 51 matches', () => {
    const line = (matched: number) => poolFooter({ search: 'aina', matched, shown: Math.min(matched, 50), size: 200 });
    expect(line(0)).toBeNull();
    expect(line(1)).toBe('1 person matches “aina”.');
    expect(line(2)).toBe('2 people match “aina”.');
    expect(line(50)).toBe('50 people match “aina”.');
    expect(line(51)).toBe('Showing the newest 50 of 51 people who match “aina”. Type more to narrow it down.');
    expect(poolNoMatch('aina')).toBe('No one in the talent pool matches “aina”.');
  });
  it('has the two lines for the read limit', () => {
    expect(POOL_READ_CAPPED).toBe('Only the newest 1,000 people on file are read, so someone added long ago may be missing from this list and from search.');
    expect(PICKER_CAPPED).toBe('Only the newest 1,000 people on file are listed here, so someone added long ago may be missing.');
    expect(PICKER_FAILED).toBe('The list could not be loaded. Check your connection and try again.');
  });
});

describe('the words of an Approve card', () => {
  const who = 'candidate “Aina binti Salleh”';
  it('says add, mark or remove', () => {
    expect(poolCardTitle(who, 'available', true)).toBe('Add candidate “Aina binti Salleh” to the talent pool as Available?');
    expect(poolCardTitle(who, 'passive', true)).toBe('Add candidate “Aina binti Salleh” to the talent pool as Passive?');
    expect(poolCardTitle(who, 'passive', undefined)).toBe('Mark candidate “Aina binti Salleh” as Passive in the talent pool?');
    expect(poolCardTitle(who, 're_engaged', false)).toBe('Mark candidate “Aina binti Salleh” as Re-engaged in the talent pool?');
    expect(poolCardTitle(who, 'none', undefined)).toBe('Remove candidate “Aina binti Salleh” from the talent pool?');
    // Only a real true is an add: the word "true" from a model is not.
    expect(poolCardTitle(who, 'available', 'true')).toBe('Mark candidate “Aina binti Salleh” as Available in the talent pool?');
    expect(poolCardTitle(who, 'shortlisted', true)).toBe('Change the talent pool status of candidate “Aina binti Salleh”?');
  });
  it('gives the meaning of the status, or what a removal keeps', () => {
    expect(poolCardDetail('available')).toBe('Available: Open to hearing about a role now.');
    expect(poolCardDetail('passive')).toBe('Passive: Not looking right now. Worth keeping in touch for later.');
    expect(poolCardDetail('re_engaged')).toBe('Re-engaged: You have been back in touch and put them forward for a job again.');
    expect(poolCardDetail('none')).toBe('They stay on file with their details and applications.');
    expect(poolCardDetail('shortlisted')).toBeNull();
    expect(poolCardDetail(undefined)).toBeNull();
  });
  it('names the person and the job on a move', () => {
    expect(pipelineCardTitle(who, 'Sales Executive')).toBe('Move candidate “Aina binti Salleh” to the pipeline for “Sales Executive”?');
    expect(pipelineCardTitle(who, null)).toBe('Move candidate “Aina binti Salleh” to the pipeline for a job?');
    expect(PIPELINE_CARD_DETAIL).toBe('Adds an application at Applied and marks them Re-engaged. They stay in the talent pool.');
  });
});
