// src/lib/hire/deletion.ts
/**
 * How a deletion is counted and worded: by the confirm dialog, by the
 * capabilities and by the tests, so every place says the same thing. Pure.
 */

export type DeletionKind = 'application' | 'candidate';

/** What a deletion removes (or would remove): the person, the job for an application, and three counts. */
export type Removal = {
  name: string;
  /** The job's title, for an application; null for a candidate, or when it is not known. */
  job: string | null;
  applications: number;
  interviews: number;
  /** Uploaded CV files. A CV given as a link is a field of the application and is not counted. */
  cvFiles: number;
};

export const CHECKING = 'Checking what this removes…';
export const SUMMARY_FAILED = `Couldn't check what this removes. Close this and try again.`;
export const DELETE_FAILED = 'That could not be deleted. Please try again.';
const CANNOT_UNDO = `This can't be undone.`;
const FORBIDDEN = 'You do not have permission to make changes here.';

/** What the person is told for each word the two database functions answer with. */
const DELETION_MESSAGES: Record<DeletionKind, Record<string, string>> = {
  application: {
    not_found: 'That application could not be found. It may already have been deleted.',
    forbidden: FORBIDDEN,
  },
  candidate: {
    not_found: 'That candidate could not be found. They may already have been deleted.',
    forbidden: FORBIDDEN,
    changed: 'This candidate was changed a moment ago. Nothing was deleted. Try again.',
  },
};

export function deletionMessage(kind: DeletionKind, word: unknown): string {
  const known = DELETION_MESSAGES[kind];
  return typeof word === 'string' && Object.hasOwn(known, word) ? known[word] : DELETE_FAILED;
}

/** A count as it is shown: a whole number above zero, or zero. */
const whole = (n: number) => (Number.isInteger(n) && n > 0 ? n : 0);
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 applications", "1 interview", "1 CV file": only the parts that are not zero, in that order. */
export function removedParts(
  removal: Pick<Removal, 'applications' | 'interviews' | 'cvFiles'>,
  withApplications: boolean,
): string[] {
  const parts: string[] = [];
  const applications = whole(removal.applications);
  const interviews = whole(removal.interviews);
  const cvFiles = whole(removal.cvFiles);
  if (withApplications && applications > 0) parts.push(counted(applications, 'application', 'applications'));
  if (interviews > 0) parts.push(counted(interviews, 'interview', 'interviews'));
  if (cvFiles > 0) parts.push(counted(cvFiles, 'CV file', 'CV files'));
  return parts;
}

/** "a", "a and b", "a, b and c". */
export function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function confirmTitle(kind: DeletionKind, name: string, job: string | null): string {
  if (kind === 'candidate') return `Delete ${name}?`;
  return job ? `Delete ${name}'s application for ${job}?` : `Delete ${name}'s application?`;
}

export function confirmBody(kind: DeletionKind, removal: Removal): string {
  if (kind === 'application') {
    const what = joinParts(['the application', ...removedParts(removal, false)]);
    return `This removes ${what}. ${removal.name} stays on file as a candidate. ${CANNOT_UNDO}`;
  }
  if (whole(removal.applications) === 0) return `This removes the candidate. They have no applications. ${CANNOT_UNDO}`;
  return `This removes ${joinParts(removedParts(removal, true))}. ${CANNOT_UNDO}`;
}

/** The sentence after a deletion, from what the database said it removed. */
export function deletedMessage(kind: DeletionKind, removal: Removal): string {
  const name = removal.name.trim();
  if (!name) return kind === 'application' ? 'Deleted the application.' : 'Deleted the candidate.';
  const parts = removedParts(removal, kind === 'candidate');
  const extra = parts.length > 0 ? `, with ${joinParts(parts)}` : '';
  if (kind === 'candidate') return `Deleted ${name}${extra}.`;
  const job = removal.job?.trim();
  return `Deleted ${name}'s application${job ? ` for ${job}` : ''}${extra}. ${name} is still on file.`;
}
