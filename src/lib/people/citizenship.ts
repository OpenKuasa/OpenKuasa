/**
 * An employee's citizenship, in KWSP's own categories. It decides which EPF and
 * EIS rates the payroll proposes; the rates themselves are rows of
 * hr_statutory_rules. Not recorded is worked out as a Malaysian citizen.
 */
export const CITIZENSHIPS = ['citizen', 'permanent_resident', 'non_citizen_before_1998', 'non_citizen'] as const;

export type Citizenship = (typeof CITIZENSHIPS)[number];

export const CITIZENSHIP_LABEL: Record<Citizenship, string> = {
  citizen: 'Malaysian citizen',
  permanent_resident: 'Permanent resident',
  non_citizen_before_1998: 'Non-citizen, EPF member since before 1 August 1998',
  non_citizen: 'Non-citizen',
};

/** What an empty choice means, in the words the form and profile show. */
export const CITIZENSHIP_NOT_RECORDED = 'Not recorded (paid as a Malaysian citizen)';

export const isCitizenship = (value: unknown): value is Citizenship =>
  typeof value === 'string' && (CITIZENSHIPS as readonly string[]).includes(value);
