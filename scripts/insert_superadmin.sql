INSERT INTO tenants (id, name, subscription_plan) VALUES ('b2b1a9e3-855c-4d56-a9b8-8f815a5f6e87', 'Sunil''s Organization', 'PRO');
INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES ('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 'b2b1a9e3-855c-4d56-a9b8-8f815a5f6e87', 'sunil@hsk.com', '$2a$10$MWq1MFZQ61m9VyRB0h3Cde1PUzxJdpgCJbFO5L18rwvEAJd3Irtk.', 'Sunil', 'SUPER_ADMIN');
INSERT INTO profiles (id, user_id) VALUES ('c3d4e5f6-a7b8-9c0d-1e2f-3a4b5c6d7e8f', 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
