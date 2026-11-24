import { describe, it, expect } from 'vitest';
import { DEFAULT_MODULE_COLOR, MODULE_COLORS } from '@/lib/documentCategories';
import { docCategoryName, docColors, docTaxonomyLabel } from '@/lib/records/documentRowFormat';

const row = (categoryRef: any, extra: Record<string, any> = {}) => ({ categoryRef, ...extra });

describe('an ordinary document row — exactly what the Document Manager always showed', () => {
  const gst = row({ moduleKey: 'biz_tax', documentKey: 'gst_registration', moduleName: 'Tax Documents', documentName: 'GST Registration Certificate (GSTIN)' });

  it('is labelled "Module - Sub-category"', () => {
    expect(docTaxonomyLabel(gst)).toBe('Tax Documents - GST Registration Certificate (GSTIN)');
  });

  it('takes its own module colour, and the default for an unknown module', () => {
    expect(docColors(gst)).toBe(MODULE_COLORS.biz_tax);
    expect(docColors(row({ moduleKey: 'made_up', documentKey: 'x' }))).toBe(DEFAULT_MODULE_COLOR);
    expect(docColors({})).toBe(DEFAULT_MODULE_COLOR);
  });

  it('shows the member\'s own label under an Others category', () => {
    const others = row({ moduleKey: 'other', documentKey: 'uncategorized', moduleName: 'Others', documentName: 'Others' }, { customSubcategory: 'Gym Membership' });
    expect(docTaxonomyLabel(others)).toBe('Others - Gym Membership');
    expect(docCategoryName(others)).toBe('Gym Membership');
  });

  it('never prints the same word either side of a hyphen, and falls back to Uncategorized', () => {
    expect(docTaxonomyLabel(row({ moduleKey: 'other', documentKey: 'uncategorized', moduleName: 'Others', documentName: 'Others' }))).toBe('Others');
    expect(docTaxonomyLabel({})).toBe('Uncategorized');
    expect(docTaxonomyLabel({ category: 'Legacy' })).toBe('Legacy');
    expect(docCategoryName({})).toBe('Uncategorized');
  });
});

describe('a CLIENT document row — named for what it is, not where it is filed', () => {
  const pan = row({ moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card', moduleName: 'Client Documents — Individual', documentName: 'PAN Card' });

  it('reads "Identity - PAN Card", not "Client Documents — Individual - PAN Card"', () => {
    expect(docTaxonomyLabel(pan)).toBe('Identity - PAN Card');
  });

  it("takes the SOURCE module's colour, the same as a household member's PAN card", () => {
    expect(docColors(pan)).toBe(MODULE_COLORS.identity);
  });

  it('does the same for a company client\'s document', () => {
    const gst = row({ moduleKey: 'biz_client_company', documentKey: 'biz_tax-gst_registration', moduleName: 'Client Documents — Company', documentName: 'GST Registration Certificate (GSTIN)' });
    expect(docTaxonomyLabel(gst)).toBe('Tax Documents - GST Registration Certificate (GSTIN)');
    expect(docColors(gst)).toBe(MODULE_COLORS.biz_tax);
  });

  it("the client catch-all reads simply 'Others'", () => {
    const others = row({ moduleKey: 'biz_client_individual', documentKey: 'uncategorized', moduleName: 'Client Documents — Individual', documentName: 'Others' });
    expect(docTaxonomyLabel(others)).toBe('Others');
  });

  it("a client category whose name is not in the compiled list keeps its own module name", () => {
    const odd = row({ moduleKey: 'biz_client_individual', documentKey: 'nohyphen', moduleName: 'Client Documents — Individual', documentName: 'Thing' });
    expect(docTaxonomyLabel(odd)).toBe('Client Documents — Individual - Thing');
  });
});
