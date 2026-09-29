-- Rename name column to title for consistency with schema convention
ALTER TABLE documents RENAME COLUMN name TO title;
ALTER TABLE contract_agreements RENAME COLUMN name TO title;
