INSERT INTO tenants (name, slug) VALUES ('System', 'system');
INSERT INTO users (tenant_id, email, password_hash, name, role) 
VALUES ((SELECT id FROM tenants WHERE slug = 'system'), 'sunil@hsk.com', '$2a$10$n.60JvPJG9S7TWAhiFRJJ.2eiGo2KWxLLd6cFATcx8SNfzoFoYhom', 'Sunil Admin', 'SUPER_ADMIN');
