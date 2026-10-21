import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SstReportScreen from '@/screens/finance/sst-report';

/**
 * The SST Report is still a sample, but it should not teach what SST is not (#222). SST has no input tax and
 * no "net payable"; the return takes deductions off the total tax. It is administered by Customs (JKDM), not
 * LHDN, and nothing is filed from this screen.
 */
const html = renderToStaticMarkup(<SstReportScreen />);
const text = html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');

describe('the SST Report sample', () => {
  it('shows nothing from GST or LHDN, and no way to file', () => {
    for (const wrong of [/input/i, /net payable/i, /LHDN/, /file return/i, /collected/i]) {
      expect(text, String(wrong)).not.toMatch(wrong);
    }
  });

  it('follows the SST-02 items of a service tax return', () => {
    for (const item of ['Part A', 'Part B1', 'Part B2', '11(c)', '11(d)', '11(e)', '12', '13(a)', '13(c)', '13(d)', '14', 'Part D']) {
      expect(text).toContain(item);
    }
    // Part D of a service tax return is item 18(c), lines 1 to 4; 18(a) and 18(b) are for manufacturers.
    for (const line of ['18(c)(1)', '18(c)(2)', '18(c)(3)', '18(c)(4)']) expect(text).toContain(line);
    expect(text).not.toMatch(/18\((a|b)\)/);
    // 13(b) and 13A belong to the sales tax return.
    expect(text).not.toMatch(/13\(b\)|13A/);
  });

  it('says it is a summary to copy, administered by Customs', () => {
    expect(text).toContain('Nothing is sent to Customs (JKDM) from here');
    expect(text).toContain('MySST');
  });
});
