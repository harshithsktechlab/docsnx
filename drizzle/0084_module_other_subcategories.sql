-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0084 — an "Other" sub-category in every module (29 rows)                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A member who knows a document is Insurance, but finds no sub-category that
-- fits, had two bad choices: file it under the wrong one, or drop it into the
-- global Others and out of the Insurance list. Each of the 14 personal and 15
-- business modules now ends with its own `<module>/other`. The two catch-alls
-- (`other`, `biz_other`) are untouched — they remain for a document whose
-- MODULE could not be determined.
--
-- The key is `other`, not the `miscellaneous` that 0023 retired and 0036 reaped:
-- a key is a Drive path and half the AAD binding, so a dead one is never reused.
--
-- Module-level permission grants already cover the new rows. The field spec /
-- encryption policy is written by scripts/seed_document_category_fields.ts,
-- which `npm run migrate` runs next. The TS constant in
-- src/lib/documentCategories.ts carries the same rows.
--
-- Additive only; ON CONFLICT DO NOTHING makes re-running a no-op.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (1,'identity','Identity','other','Other',1009),
  (2,'bank_investments','Bank & Investments','other','Other',2013),
  (3,'insurance','Insurance','other','Other',3007),
  (4,'property_legal','Property & Legal','other','Other',4009),
  (5,'education','Education','other','Other',5005),
  (6,'health_medical','Health & Medical','other','Other',6007),
  (7,'employment','Employment','other','Other',7005),
  (8,'vehicle','Vehicle','other','Other',8005),
  (9,'civil_government','Civil & Government Records','other','Other',9006),
  (10,'warranty_amc','Warranty & AMC','other','Other',10004),
  (11,'rentals_subscriptions','Rentals & Subscriptions','other','Other',11003),
  (12,'utility_bills','Utility Bills','other','Other',12004),
  (13,'tax_compliance','Tax & Compliance','other','Other',13005),
  (14,'travel','Travel & Tickets','other','Other',14007),
  (101,'biz_registration','Business Registration & Legal Structure','other','Other',101009),
  (102,'biz_tax','Tax Documents','other','Other',102008),
  (103,'biz_finance','Financial & Accounting','other','Other',103009),
  (104,'biz_banking','Banking & Credit','other','Other',104008),
  (105,'biz_licenses','Licenses & Permits','other','Other',105008),
  (106,'biz_compliance','Compliance & Regulatory Filings','other','Other',106007),
  (107,'biz_contracts','Contracts & Agreements','other','Other',107008),
  (108,'biz_hr','Human Resources','other','Other',108008),
  (109,'biz_ip','Intellectual Property','other','Other',109006),
  (110,'biz_insurance','Insurance','other','Other',110006),
  (111,'biz_governance','Corporate Governance','other','Other',111006),
  (112,'biz_procurement','Vendor & Procurement','other','Other',112005),
  (113,'biz_sales','Sales & Marketing','other','Other',113005),
  (114,'biz_operations','Operations & Assets','other','Other',114005),
  (115,'biz_travel','Travel & Expenses','other','Other',115007)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;
