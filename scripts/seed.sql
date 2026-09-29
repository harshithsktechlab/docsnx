INSERT INTO subscription_plans (id, code, name, price, duration_days, features, is_active, created_at, updated_at)
VALUES 
(gen_random_uuid(), 'FREE', 'Free Plan', 0, 365, '["Basic Vault", "Max 10 Documents"]', true, NOW(), NOW()),
(gen_random_uuid(), 'PRO', 'Pro Plan', 99900, 365, '["Unlimited Vault", "AI Scanning", "Priority Support"]', true, NOW(), NOW()),
(gen_random_uuid(), 'ENTERPRISE', 'Enterprise Plan', 999900, 3650, '["Everything in Pro", "Dedicated Account Manager"]', true, NOW(), NOW())
ON CONFLICT DO NOTHING;
