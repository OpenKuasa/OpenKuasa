// tests/hire-deletion.test.ts
import { describe, expect, it } from 'vitest';
import {
  CHECKING, DELETE_FAILED, SUMMARY_FAILED, confirmBody, confirmTitle, deletedMessage, deletionMessage, joinParts,
  removedParts, type Removal,
} from '@/lib/hire/deletion';

const removal = (over: Partial<Removal> = {}): Removal => ({
  name: 'Aina Rahman', job: 'Sales Executive', applications: 1, interviews: 0, cvFiles: 0, ...over,
});

describe('the parts a deletion names', () => {
  it('leaves out a part that is zero, and uses the singular for one', () => {
    expect(removedParts({ applications: 2, interviews: 1, cvFiles: 1 }, true)).toEqual(['2 applications', '1 interview', '1 CV file']);
    expect(removedParts({ applications: 1, interviews: 2, cvFiles: 3 }, true)).toEqual(['1 application', '2 interviews', '3 CV files']);
    expect(removedParts({ applications: 4, interviews: 0, cvFiles: 0 }, true)).toEqual(['4 applications']);
    expect(removedParts({ applications: 1, interviews: 2, cvFiles: 0 }, false)).toEqual(['2 interviews']);
    expect(removedParts({ applications: 1, interviews: 0, cvFiles: 0 }, false)).toEqual([]);
  });
  it('treats anything that is not a whole number above zero as zero', () => {
    const odd = { applications: -1, interviews: 1.5, cvFiles: Number.NaN };
    expect(removedParts(odd, true)).toEqual([]);
  });
  it('joins with commas and a final and', () => {
    expect(joinParts([])).toBe('');
    expect(joinParts(['a'])).toBe('a');
    expect(joinParts(['a', 'b'])).toBe('a and b');
    expect(joinParts(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('the confirm dialog', () => {
  it('titles each kind, with the possessive always the name and an s', () => {
    expect(confirmTitle('application', 'Aina Rahman', 'Sales Executive')).toBe("Delete Aina Rahman's application for Sales Executive?");
    expect(confirmTitle('application', 'Iris', 'Barista')).toBe("Delete Iris's application for Barista?");
    expect(confirmTitle('application', 'Aina Rahman', null)).toBe("Delete Aina Rahman's application?");
    expect(confirmTitle('candidate', 'Aina Rahman', null)).toBe('Delete Aina Rahman?');
    expect(confirmTitle('candidate', 'Aina Rahman', 'Sales Executive')).toBe('Delete Aina Rahman?');
  });
  it('says what an application takes with it, and that the candidate stays', () => {
    const tail = " Aina Rahman stays on file as a candidate. This can't be undone.";
    expect(confirmBody('application', removal())).toBe(`This removes the application.${tail}`);
    expect(confirmBody('application', removal({ interviews: 1 }))).toBe(`This removes the application and 1 interview.${tail}`);
    expect(confirmBody('application', removal({ cvFiles: 1 }))).toBe(`This removes the application and 1 CV file.${tail}`);
    expect(confirmBody('application', removal({ interviews: 2, cvFiles: 1 }))).toBe(`This removes the application, 2 interviews and 1 CV file.${tail}`);
  });
  it('says what a candidate takes with them', () => {
    expect(confirmBody('candidate', removal({ applications: 2, interviews: 1, cvFiles: 1 })))
      .toBe("This removes 2 applications, 1 interview and 1 CV file. This can't be undone.");
    expect(confirmBody('candidate', removal())).toBe("This removes 1 application. This can't be undone.");
    expect(confirmBody('candidate', removal({ applications: 3, cvFiles: 2 }))).toBe("This removes 3 applications and 2 CV files. This can't be undone.");
    expect(confirmBody('candidate', removal({ applications: 0 }))).toBe("This removes the candidate. They have no applications. This can't be undone.");
  });
  it('has its loading and failed lines', () => {
    expect(CHECKING).toBe('Checking what this removes…');
    expect(SUMMARY_FAILED).toBe("Couldn't check what this removes. Close this and try again.");
  });
});

describe('the sentence after a deletion', () => {
  it('names what went with an application, and that the person is still on file', () => {
    expect(deletedMessage('application', removal())).toBe("Deleted Aina Rahman's application for Sales Executive. Aina Rahman is still on file.");
    expect(deletedMessage('application', removal({ interviews: 1, cvFiles: 1 })))
      .toBe("Deleted Aina Rahman's application for Sales Executive, with 1 interview and 1 CV file. Aina Rahman is still on file.");
    expect(deletedMessage('application', removal({ job: null }))).toBe("Deleted Aina Rahman's application. Aina Rahman is still on file.");
  });
  it('names what went with a candidate', () => {
    expect(deletedMessage('candidate', removal({ applications: 0 }))).toBe('Deleted Aina Rahman.');
    expect(deletedMessage('candidate', removal({ applications: 2, interviews: 1, cvFiles: 1 })))
      .toBe('Deleted Aina Rahman, with 2 applications, 1 interview and 1 CV file.');
  });
  it('still says it was deleted when the answer carried no name', () => {
    expect(deletedMessage('application', removal({ name: '' }))).toBe('Deleted the application.');
    expect(deletedMessage('candidate', removal({ name: '  ' }))).toBe('Deleted the candidate.');
  });
});

describe('a refusal', () => {
  it('has one sentence per word and kind', () => {
    expect(deletionMessage('application', 'not_found')).toBe('That application could not be found. It may already have been deleted.');
    expect(deletionMessage('candidate', 'not_found')).toBe('That candidate could not be found. They may already have been deleted.');
    expect(deletionMessage('application', 'forbidden')).toBe('You do not have permission to make changes here.');
    expect(deletionMessage('candidate', 'forbidden')).toBe('You do not have permission to make changes here.');
    expect(deletionMessage('candidate', 'changed')).toBe('This candidate was changed a moment ago. Nothing was deleted. Try again.');
  });
  it('gives the generic sentence for anything else', () => {
    expect(DELETE_FAILED).toBe('That could not be deleted. Please try again.');
    for (const word of ['changed', 'ok', 'toString', '', null, undefined, 7, { word: 'not_found' }]) {
      expect(deletionMessage('application', word), String(word)).toBe(DELETE_FAILED);
    }
    for (const word of ['constructor', null, undefined]) expect(deletionMessage('candidate', word), String(word)).toBe(DELETE_FAILED);
  });
});
