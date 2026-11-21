import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmployeeForm } from '@/components/people/employee-form';

/**
 * The citizenship field at phone width. There is no DOM or layout here, so the markup is read: a grid item does not
 * shrink below its own content unless it says `min-w-0`, and the select's value is `whitespace-nowrap`
 * (`select.tsx`, `*:data-[slot=select-value]:line-clamp-1`), so the row's min-content was the whole sentence
 * "Not recorded (paid as a Malaysian citizen)" and the single track of the private details grid grew to fit it.
 *
 * Measured in Chrome on the production build, this form inside the employee dialog's own classes
 * (`employees-table.tsx:528`: `w-[calc(100%-2rem)] max-w-2xl p-5`, `max-h-[90vh] overflow-y-auto`): at 390px the grid's
 * content box is 316px, the single track resolved to 329.73px, and all thirteen rows overhung the content edge by
 * 13.73px into the dialog's right padding. With `min-w-0` on the row the track is 316px, no row overhangs, and the
 * value clips inside the trigger, which gives it 274px of the 288px it asks for. At 768, 1024 and 1280 the grid is two
 * 309px tracks and nothing overhangs either way.
 */

const html = renderToStaticMarkup(
  <EmployeeForm
    initial={null}
    departments={[]}
    employees={[]}
    showReportsTo={false}
    disabled={false}
    error={null}
    onCancel={() => {}}
    onSubmit={() => {}}
  />,
);

const citizenshipRow =
  html.match(/<div class="([^"]*)"><div class="space-y-1\.5"><span[^>]*>Citizenship \(for EPF and EIS\)<\/span>/)?.[1] ?? '';

describe('the citizenship field on a phone', () => {
  it('is in the form', () => {
    expect(citizenshipRow).not.toBe('');
    expect(html).toContain('Citizenship (for EPF and EIS)');
  });

  it('lets its grid track shrink below the value\u2019s own width, so the private details do not overhang the form', () => {
    expect(citizenshipRow.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'sm:col-span-2']));
  });
});
