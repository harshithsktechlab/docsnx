import '@testing-library/jest-dom';

// Provide deterministic secrets so modules that require them can be imported in tests.
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'test_encryption_secret_key_docsnx_32bytes';
process.env.BLIND_INDEX_KEY = process.env.BLIND_INDEX_KEY || 'test_blind_index_key_docsnx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_docsnx';
