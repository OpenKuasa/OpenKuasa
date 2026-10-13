import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, unfilledInLetter, unfilledPlaceholders } from '@/lib/people/letter-placeholders';

describe('PLACEHOLDERS', () => {
  it('is the eight names the database fills, in its order', () => {
    expect(PLACEHOLDERS).toEqual([
      'employee_name',
      'employee_no',
      'designation',
      'department',
      'join_date',
      'company_name',
      'today',
      'salary',
    ]);
  });

  it('finds {salary} (the eighth name) and treats its look-alikes as ordinary text', () => {
    expect(unfilledPlaceholders('Gaji {salary} sebulan.')).toEqual(['salary']);
    expect(unfilledPlaceholders('{Salary} { salary } {salary {SALARY} {salary_x}')).toEqual([]);
    expect(unfilledPlaceholders('{today} {salary} {employee_name}')).toEqual(['today', 'salary', 'employee_name']);
  });
});

describe('unfilledPlaceholders', () => {
  it.each(PLACEHOLDERS)('finds {%s}', (name) => {
    expect(unfilledPlaceholders(`Dear all, {${name}} here.`)).toEqual([name]);
  });

  it('finds nothing in text without braces, and in empty text', () => {
    expect(unfilledPlaceholders('')).toEqual([]);
    expect(unfilledPlaceholders('Welcome aboard.')).toEqual([]);
  });

  it('leaves unknown names, other cases, spaces and unclosed braces alone', () => {
    expect(unfilledPlaceholders('{Salary} {Today} {TODAY} { today } {today {employee_name')).toEqual([]);
    expect(unfilledPlaceholders('{}')).toEqual([]);
    expect(unfilledPlaceholders('{today }')).toEqual([]);
  });

  it('finds a name inside nested braces', () => {
    expect(unfilledPlaceholders('{{today}}')).toEqual(['today']);
    expect(unfilledPlaceholders('{{employee_name}')).toEqual(['employee_name']);
    expect(unfilledPlaceholders('{a{designation}b}')).toEqual(['designation']);
  });

  it('finds adjacent names, in the order they appear', () => {
    expect(unfilledPlaceholders('{today}{employee_name}')).toEqual(['today', 'employee_name']);
    expect(unfilledPlaceholders('{department} then {employee_no}')).toEqual(['department', 'employee_no']);
  });

  it('names a repeated placeholder once', () => {
    expect(unfilledPlaceholders('{today} and {today} and {designation} and {today}')).toEqual(['today', 'designation']);
  });

  it('is not fooled by repeated calls (no sticky regex state)', () => {
    expect(unfilledPlaceholders('{today}')).toEqual(['today']);
    expect(unfilledPlaceholders('{today}')).toEqual(['today']);
  });
});

describe('unfilledInLetter', () => {
  it('reads the title as well as the body', () => {
    expect(unfilledInLetter('Offer for {employee_name}', 'Join us on {join_date}.')).toEqual(['employee_name', 'join_date']);
  });

  it('names a placeholder used in both once', () => {
    expect(unfilledInLetter('Dear {employee_name}', 'Hi {employee_name}')).toEqual(['employee_name']);
  });

  it('does not join the title and the body into a placeholder', () => {
    expect(unfilledInLetter('Hello {to', 'day} there')).toEqual([]);
    expect(unfilledInLetter('Hello {today', '} there')).toEqual([]);
  });
});
