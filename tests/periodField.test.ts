import { describe, it, expect } from 'vitest';
import { fieldsFor } from '../src/lib/documentCategoryFields';

/**
 * `period` belongs to documents filed once per FY / quarter / month, and to no
 * others. It used to be granted per MODULE, which left an annual EPF summary or
 * ROC filing with nowhere to say its year while a GST registration asked for one.
 */
const periodOf = (moduleKey: string, documentKey: string) =>
  fieldsFor({ moduleKey, documentKey }).find((f) => f.fieldKey === 'period');

const PERIODIC: Record<string, string[]> = {
  biz_compliance: [
    'roc_annual_filings', 'esi_registration_returns', 'epf_registration_returns',
    'labour_law_compliance', 'statutory_audit_reports',
  ],
  biz_governance: ['agm_records'],
  biz_tax: ['gst_returns', 'income_tax_returns', 'tds_certificates', 'advance_tax_challans', 'tax_audit_reports'],
  biz_finance: [
    'balance_sheet', 'profit_loss_statement', 'cash_flow_statement', 'audited_financial_statements',
    'bank_statements', 'ledger_trial_balance', 'invoices',
  ],
  biz_banking: ['cheque_rtgs_neft_records'],
  biz_hr: ['payroll_records', 'pf_esi_employee_records', 'performance_appraisals'],
  biz_procurement: ['supplier_compliance'],
  biz_operations: ['asset_registers', 'utility_bills'],
  employment: ['epf_uan_documents'],
  bank_investments: ['demat_trading_documents'],
  tax_compliance: ['pension_payment_order'],
  insurance: ['premium_receipts'],
};

const ONE_OFF: Record<string, string[]> = {
  biz_tax: ['gst_registration', 'professional_tax_registration'],
  biz_finance: ['credit_debit_notes'],
  biz_banking: [
    'current_account_documents', 'loan_sanction_letters', 'loan_agreements', 'cash_credit_overdraft',
    'bank_guarantee', 'letter_of_credit',
  ],
  biz_hr: ['offer_letters', 'appointment_letters', 'employment_contracts', 'hr_policy_documents'],
  biz_insurance: [
    'business_property_insurance', 'professional_indemnity', 'employee_group_insurance',
    'fire_theft_insurance', 'marine_cargo_insurance',
  ],
  biz_procurement: ['purchase_orders', 'vendor_contracts', 'quality_certifications'],
  biz_sales: ['sales_agreements', 'marketing_collateral_approvals', 'customer_contracts_slas', 'warranty_documents'],
  biz_operations: ['property_lease_deeds', 'equipment_purchase_maintenance'],
  biz_compliance: ['board_resolutions'],
  biz_registration: ['certificate_of_incorporation'],
};

describe('period field', () => {
  for (const [moduleKey, keys] of Object.entries(PERIODIC)) {
    for (const documentKey of keys) {
      it(`${moduleKey}.${documentKey} asks for its period, with the FY hint`, () => {
        const f = periodOf(moduleKey, documentKey);
        expect(f, 'period missing').toBeDefined();
        expect(f!.fieldLabel).toBe('Period / Year');
        expect(f!.dataType).toBe('text');
        expect(f!.isPii).toBe(false);
        expect(f!.isRequired ?? false).toBe(false);
        expect(f!.validation?.example).toMatch(/FY 2025-26/);
      });
    }
  }

  for (const [moduleKey, keys] of Object.entries(ONE_OFF)) {
    for (const documentKey of keys) {
      it(`${moduleKey}.${documentKey} does not`, () => {
        expect(fieldsFor({ moduleKey, documentKey }).length).toBeGreaterThan(0);
        expect(periodOf(moduleKey, documentKey)).toBeUndefined();
      });
    }
  }

  it('the EPF form keeps its dates and puts the period after them', () => {
    const keys = fieldsFor({ moduleKey: 'biz_compliance', documentKey: 'epf_registration_returns' })
      .map((f) => f.fieldKey);
    expect(keys).toEqual(expect.arrayContaining(['issue_date', 'valid_from', 'valid_to', 'period']));
    expect(keys.indexOf('period')).toBeGreaterThan(keys.indexOf('valid_to'));
  });

  it('the Others catch-all still classifies a scanned period', () => {
    expect(periodOf('other', 'uncategorized')).toBeDefined();
  });
});
