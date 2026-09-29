CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
    t_id UUID := gen_random_uuid();
    u_id UUID := gen_random_uuid();
    p_id UUID := gen_random_uuid();
BEGIN
    INSERT INTO tenants (id, name) 
    VALUES (t_id, 'HSK Organization');
    
    INSERT INTO users (id, tenant_id, email, password_hash, name, role) 
    VALUES (u_id, t_id, 'rachana@hsk.com', crypt('123456', gen_salt('bf', 10)), 'Rachana', 'SUPER_ADMIN')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, tenant_id = EXCLUDED.tenant_id RETURNING id INTO u_id;
    
    INSERT INTO profiles (id, user_id) VALUES (p_id, u_id)
    ON CONFLICT (user_id) DO NOTHING;
END $$;
