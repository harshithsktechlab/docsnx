/**
 * Centralized AI Analysis & Extraction Profiles for DocsNX.
 * Specifies structured extraction fields, analytical prompt focus areas,
 * and mandatory legal disclaimers for every record category.
 */

export interface AIProfile {
  category: string;
  name: string;
  extractionFields: string[];
  analyticalCapabilities: string[];
  mandatoryDisclaimer: string;
}

export const AI_PROFILES: Record<string, AIProfile> = {
  // ── THE BUSINESS SCOPES ──────────────────────────────────────────────────
  // One per business module. Not optional politeness: `getAIProfile` falls back
  // to a generic "General Record" profile on a miss, so a missing entry is a
  // SILENT quality loss rather than an error — which is exactly why
  // tests/moduleVocabularyReach.test.ts asserts every scope has one.
  //
  // Every disclaimer names the professional the user should actually consult;
  // company paperwork carries more regulatory consequence than personal
  // records, and the analysis must not read as advice.
  biz_registration: {
    category: 'biz_registration',
    name: 'Business Registration & Legal Structure',
    extractionFields: [
      'Entity Name',
      'Registration Number',
      'Entity Type',
      'Date of Incorporation',
      'Registered Address',
      'Issuing Authority',
    ],
    analyticalCapabilities: [
      'Entity-type consistency across registrations',
      'Registration renewal schedule',
    ],
    mandatoryDisclaimer: 'Informational company records summary only. Consult a Company Secretary / Legal Counsel.'
  },
  biz_tax: {
    category: 'biz_tax',
    name: 'Business Tax',
    extractionFields: [
      'Document Type',
      'Registration Number',
      'Assessment Year',
      'Filing Period',
      'Tax Amount',
      'Filing Date',
      'Due Date',
    ],
    analyticalCapabilities: [
      'Filing-period gap detection',
      'Return due-date schedule',
    ],
    mandatoryDisclaimer: 'Informational tax summary only. Consult a Chartered Accountant.'
  },
  biz_finance: {
    category: 'biz_finance',
    name: 'Financial & Accounting',
    extractionFields: [
      'Statement Type',
      'Period',
      'Total Revenue',
      'Total Expenses',
      'Net Profit',
      'Closing Balance',
    ],
    analyticalCapabilities: [
      'Period-on-period movement',
      'Missing statement detection',
    ],
    mandatoryDisclaimer: 'Informational financial summary only. Not audited advice. Consult a Chartered Accountant.'
  },
  biz_banking: {
    category: 'biz_banking',
    name: 'Banking & Credit',
    extractionFields: [
      'Facility Type',
      'Bank Name',
      'Account Number',
      'Sanctioned Amount',
      'Interest Rate',
      'Validity Period',
    ],
    analyticalCapabilities: [
      'Facility expiry schedule',
      'Sanctioned-versus-utilised comparison',
    ],
    mandatoryDisclaimer: 'Informational banking summary only. Consult your relationship manager.'
  },
  biz_licenses: {
    category: 'biz_licenses',
    name: 'Licenses & Permits',
    extractionFields: [
      'Licence Type',
      'Licence Number',
      'Issuing Authority',
      'Valid From',
      'Valid Until',
      'Premises Address',
    ],
    analyticalCapabilities: [
      'Licence renewal schedule',
      'Lapsed-permit detection',
    ],
    mandatoryDisclaimer: 'Informational licence tracking only. Consult the issuing authority for renewal rules.'
  },
  biz_compliance: {
    category: 'biz_compliance',
    name: 'Compliance & Regulatory Filings',
    extractionFields: [
      'Filing Type',
      'Form Number',
      'Financial Year',
      'Filing Date',
      'Due Date',
      'Acknowledgement Number',
    ],
    analyticalCapabilities: [
      'Statutory calendar coverage',
      'Late-filing detection',
    ],
    mandatoryDisclaimer: 'Informational compliance summary only. Consult a Company Secretary.'
  },
  biz_contracts: {
    category: 'biz_contracts',
    name: 'Contracts & Agreements',
    extractionFields: [
      'Agreement Type',
      'Counterparty',
      'Effective Date',
      'Expiry Date',
      'Notice Period',
      'Contract Value',
    ],
    analyticalCapabilities: [
      'Renewal and notice-period schedule',
      'Auto-renewal exposure',
    ],
    mandatoryDisclaimer: 'Informational contract summary only. Consult Legal Counsel.'
  },
  biz_hr: {
    category: 'biz_hr',
    name: 'Human Resources',
    extractionFields: [
      'Document Type',
      'Employee Name',
      'Designation',
      'Date of Joining',
      'Compensation',
      'Period',
    ],
    analyticalCapabilities: [
      'Payroll period coverage',
      'Joining and confirmation schedule',
    ],
    mandatoryDisclaimer: 'Informational HR record summary only. Consult a qualified HR or payroll adviser.'
  },
  biz_ip: {
    category: 'biz_ip',
    name: 'Intellectual Property',
    extractionFields: [
      'IP Type',
      'Application Number',
      'Registration Number',
      'Class',
      'Filing Date',
      'Renewal Due Date',
    ],
    analyticalCapabilities: [
      'Renewal schedule by IP class',
      'Lapsed-registration detection',
    ],
    mandatoryDisclaimer: 'Informational IP summary only. Consult an IP attorney.'
  },
  biz_insurance: {
    category: 'biz_insurance',
    name: 'Business Insurance',
    extractionFields: [
      'Policy Type',
      'Insurer Name',
      'Policy Number',
      'Sum Insured',
      'Premium',
      'Policy Period',
    ],
    analyticalCapabilities: [
      'Cover gap detection',
      'Premium renewal schedule',
    ],
    mandatoryDisclaimer: 'Informational insurance summary only. Consult a licensed insurance adviser.'
  },
  biz_governance: {
    category: 'biz_governance',
    name: 'Corporate Governance',
    extractionFields: [
      'Record Type',
      'Meeting Date',
      'Resolution Number',
      'Attendees',
      'Register Type',
    ],
    analyticalCapabilities: [
      'Meeting cadence against statutory minimums',
      'Register completeness',
    ],
    mandatoryDisclaimer: 'Informational governance summary only. Consult a Company Secretary.'
  },
  biz_procurement: {
    category: 'biz_procurement',
    name: 'Vendor & Procurement',
    extractionFields: [
      'Document Type',
      'Vendor Name',
      'Order Number',
      'Order Date',
      'Order Value',
      'Delivery Date',
    ],
    analyticalCapabilities: [
      'Vendor spend concentration',
      'Delivery schedule adherence',
    ],
    mandatoryDisclaimer: 'Informational procurement summary only.'
  },
  biz_sales: {
    category: 'biz_sales',
    name: 'Sales & Marketing',
    extractionFields: [
      'Document Type',
      'Customer Name',
      'Agreement Date',
      'Contract Value',
      'Service Level',
      'Validity Period',
    ],
    analyticalCapabilities: [
      'Customer contract renewal schedule',
      'Service-level commitment summary',
    ],
    mandatoryDisclaimer: 'Informational sales record summary only. Consult Legal Counsel on contract terms.'
  },
  biz_operations: {
    category: 'biz_operations',
    name: 'Operations & Assets',
    extractionFields: [
      'Record Type',
      'Asset or Premises',
      'Reference Number',
      'Acquisition Date',
      'Value',
      'Next Service or Renewal Date',
    ],
    analyticalCapabilities: [
      'Asset renewal and service schedule',
      'Premises cost trend',
    ],
    mandatoryDisclaimer: 'Informational asset and premises summary only.'
  },

  documents: {
    category: 'documents',
    name: '1. Identity & General Documents',
    extractionFields: [
      'Document Number',
      'Holder Name',
      'DOB',
      'Father/Spouse Name',
      'Expiry Date',
      'Issuing Authority',
      'Address',
      'HUF flag'
    ],
    analyticalCapabilities: [
      'Document validity & KYC readiness audit',
      'Name/DOB consistency verification across documents',
      'Expiry risk profiling'
    ],
    mandatoryDisclaimer: 'Informational identity verification only.'
  },
  medical: {
    category: 'medical',
    name: '2. Medical Records',
    extractionFields: [
      'Patient Name',
      'Record Type (Lab/Rx/Discharge/Scan)',
      'Date',
      'Doctor/Hospital Name',
      'Vital signs',
      'Test Parameters (Abnormal values highlighted)'
    ],
    analyticalCapabilities: [
      'Plain-English summary of diagnostic/lab results',
      'Longitudinal trend summary (e.g. cholesterol/HbA1c history)',
      'Highlights of abnormal biomarkers & follow-up questions for doctor'
    ],
    mandatoryDisclaimer: 'Informational only. Not a medical diagnosis or treatment plan. Consult a physician.'
  },
  lic_mediclaim: {
    category: 'lic_mediclaim',
    name: '3. LIC & Mediclaim Policies',
    extractionFields: [
      'Policy Type (Life/Health)',
      'Insurer',
      'Policy Name & Number',
      'Insured Person(s)',
      'Sum Assured',
      'Premium Amount & Due Date',
      'Expiry Date',
      'Nominee'
    ],
    analyticalCapabilities: [
      'Coverage adequacy & member gap analysis',
      'Premium cash-flow schedule summary',
      'Exclusions & waiting-period awareness tips'
    ],
    mandatoryDisclaimer: 'Informational summary only. Not insurance or financial advisory.'
  },
  vehicles: {
    category: 'vehicles',
    name: '4. Vehicles & Service Records',
    extractionFields: [
      'Vehicle Name/Model',
      'Registration Number',
      'Owner Name',
      'Reg Date',
      'Insurance Expiry',
      'PUC Expiry',
      'Fitness Expiry',
      'Service Odometer & Costs'
    ],
    analyticalCapabilities: [
      'Total Cost of Ownership (TCO) & maintenance efficiency',
      'Compliance risk score (PUC/Insurance/Service gaps)',
      'Service interval recommendations'
    ],
    mandatoryDisclaimer: 'Informational maintenance tracking only.'
  },
  investments: {
    category: 'investments',
    name: '5. Investments & Property',
    extractionFields: [
      'Category (Property/Shares/MF/Gold)',
      'Title',
      'Purchase Date',
      'Purchase Value',
      'Current Value',
      'Quantity',
      'Property Tax Due Date',
      'Document completeness flags'
    ],
    analyticalCapabilities: [
      'Portfolio asset allocation breakdown',
      'Missing statutory property document audit (7/12, Namuna D)',
      'Historical appreciation & cash-flow summaries'
    ],
    mandatoryDisclaimer: 'Informational insights only. Not financial, investment, or legal advice.'
  },
  bank_info: {
    category: 'bank_info',
    name: '6. Banking Information',
    extractionFields: [
      'Bank Name',
      'Account Number',
      'Account Type (Savings/Current/NRE/FD)',
      'IFSC',
      'Branch',
      'Cards (Type, Last 4, Expiry)',
      'Maturity Dates'
    ],
    analyticalCapabilities: [
      'Account consolidation & nominee presence audit',
      'FD maturity timeline & liquidity calendar',
      'Card expiry tracking'
    ],
    mandatoryDisclaimer: 'Informational record management only.'
  },
  trading: {
    category: 'trading',
    name: '7. Trading & Demat Accounts',
    extractionFields: [
      'Broker Name',
      'Client ID/BOID',
      'Demat Account Number',
      'Login Username',
      'Nominee Name'
    ],
    analyticalCapabilities: [
      'Nominee verification check across all demat holdings',
      'Broker account consolidation audit'
    ],
    mandatoryDisclaimer: 'Informational record management only.'
  },
  warranty: {
    category: 'warranty',
    name: '8. Warranties & AMCs',
    extractionFields: [
      'Appliance Name',
      'Manufacturer',
      'Type (Warranty/AMC)',
      'Purchase Date',
      'Expiry Date',
      'Support Contact'
    ],
    analyticalCapabilities: [
      'Appliance lifecycle cost vs. AMC replacement evaluation',
      'Expedited customer care contact retrieval'
    ],
    mandatoryDisclaimer: 'Informational maintenance tracking only.'
  },
  rentals: {
    category: 'rentals',
    name: '9. Contract Agreements',
    extractionFields: [
      'Contract Type (Rental/Maintenance/Utility)',
      'Parties',
      'Account Number',
      'Start Date',
      'End Date',
      'Amount',
      'Billing Cycle'
    ],
    analyticalCapabilities: [
      'Key lease terms, notice period & escalation clause extraction',
      'Financial liability schedule summary'
    ],
    mandatoryDisclaimer: 'Informational summary only. Not legal advice.'
  },
  tax_compliance: {
    category: 'tax_compliance',
    name: '13. Tax & Compliance',
    extractionFields: [
      'AY/FY',
      'ITR Acknowledgement No',
      'Taxable Income',
      'TDS Deducted',
      'GSTIN',
      'Return Period'
    ],
    analyticalCapabilities: [
      'Year-on-year tax liability and TDS reconciliation summary',
      'Missing form/challan alerts'
    ],
    mandatoryDisclaimer: 'Informational tax summary only. Consult a Chartered Accountant.'
  },
  wills_estate: {
    category: 'wills_estate',
    name: '14. Wills & Estate',
    extractionFields: [
      'Testator Name',
      'Registered/Unregistered status',
      'Date of Execution',
      'Executor Name',
      'Nominated Beneficiaries'
    ],
    analyticalCapabilities: [
      'Asset-to-nominee mapping consistency check',
      'Documentation completeness checklist'
    ],
    mandatoryDisclaimer: 'Informational estate inventory only. Consult a legal counsel.'
  },
  loans_debt: {
    category: 'loans_debt',
    name: '15. Loans & Debt',
    extractionFields: [
      'Lender Name',
      'Loan Account No',
      'Loan Type',
      'Principal Amount',
      'Interest Rate',
      'Tenure',
      'EMI Amount',
      'Maturity Date'
    ],
    analyticalCapabilities: [
      'Debt amortization summary & total interest burden overview',
      'Closure NOC reminder checklist'
    ],
    mandatoryDisclaimer: 'Informational loan summary only.'
  },
  utility_bills: {
    category: 'utility_bills',
    name: 'Utility Bills',
    extractionFields: [
      'Service Type',
      'Provider Name',
      'Consumer Number',
      'Bill Amount',
      'Due Date',
      'Billing Period'
    ],
    analyticalCapabilities: [
      'Seasonal consumption anomaly detection',
      'Due date reminder schedule'
    ],
    mandatoryDisclaimer: 'Informational utility tracking only.'
  },
  employment_payroll: {
    category: 'employment_payroll',
    name: 'Employment & Payroll',
    extractionFields: [
      'Document Type',
      'Employer Name',
      'Employee Name',
      'Designation',
      'Issue Date'
    ],
    analyticalCapabilities: [
      'Compensation breakdown and PF/EPFO continuity check'
    ],
    mandatoryDisclaimer: 'Informational payroll tracking only.'
  }
};

/**
 * Get AI Profile for a given category slug or return a safe default.
 */
export function getAIProfile(category: string): AIProfile {
  const norm = (category || '').toLowerCase().trim();

  // Profiles are keyed by MODULE NAME, the same name the taxonomy, the
  // permission check and the vault folder use. `/api/analysis` passes exactly
  // that, so the common path is a direct hit.
  const direct = AI_PROFILES[norm];
  if (direct) return direct;

  // The AI SCAN vocabulary is deliberately separate — those tokens are chosen
  // for the model's benefit ("bank", "will_estate") and are part of the prompt
  // contract in src/lib/ai.js, so they are translated rather than renamed.
  // Anything not mapped here falls through to the generic profile BELOW, which
  // is a silent quality loss: six modules were doing exactly that before this
  // table was completed.
  const ALIASES: Record<string, string> = {
    document: 'documents', vehicle: 'vehicles', investment: 'investments',
    bank: 'bank_info', banking: 'bank_info', demat: 'trading',
    warranty_amc: 'warranty', warranties: 'warranty',
    contract_agreement: 'rentals', contracts: 'rentals',
    will_estate: 'wills_estate', loan_debt: 'loans_debt',
    utility_bill: 'utility_bills', insurance: 'lic_mediclaim', tax: 'tax_compliance',
  };
  const aliased = ALIASES[norm];
  if (aliased && AI_PROFILES[aliased]) return AI_PROFILES[aliased];

  return {
    category: norm,
    name: 'General Record',
    extractionFields: ['Title', 'Date', 'Entity Name', 'Reference Number', 'Details'],
    analyticalCapabilities: ['Record validity and completeness audit', 'Key information extraction'],
    mandatoryDisclaimer: 'Informational summary only.'
  };
}
