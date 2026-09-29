DO $$ 
DECLARE
  v_tenant_id uuid;
  v_user1_id uuid;
  v_user2_id uuid;
BEGIN
  -- Insert tenant
  INSERT INTO tenants (name, slug) 
  VALUES ('HSK Organization', 'hsk-org') 
  RETURNING id INTO v_tenant_id;
  
  -- Insert rachana@hsk.com
  INSERT INTO users (tenant_id, email, password_hash, name, role) 
  VALUES (v_tenant_id, 'rachana@hsk.com', '$2a$10$n.60JvPJG9S7TWAhiFRJJ.2eiGo2KWxLLd6cFATcx8SNfzoFoYhom', 'Rachana', 'SUPER_ADMIN')
  RETURNING id INTO v_user1_id;

  INSERT INTO profiles (user_id) VALUES (v_user1_id);

  -- Insert harshit@hsk.com
  INSERT INTO users (tenant_id, email, password_hash, name, role) 
  VALUES (v_tenant_id, 'harshit@hsk.com', '$2a$10$n.60JvPJG9S7TWAhiFRJJ.2eiGo2KWxLLd6cFATcx8SNfzoFoYhom', 'Harshit', 'SUPER_ADMIN')
  RETURNING id INTO v_user2_id;

  INSERT INTO profiles (user_id) VALUES (v_user2_id);
END $$;
