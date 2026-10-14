import { formatBpsPercent } from './percent.js';

describe('formatBpsPercent', () => {
  it.each([
    [100, '1'],
    [1500, '15'],
    [1250, '12.5'],
    [1234, '12.34'],
    [1205, '12.05'],
    [9900, '99'],
  ])('%i bps reads %s', (bps, text) => {
    expect(formatBpsPercent(bps)).toBe(text);
  });
  it('refuses a value that is not a whole, non-negative number of basis points', () => {
    expect(() => formatBpsPercent(12.5)).toThrow();
    expect(() => formatBpsPercent(-1)).toThrow();
  });
});
