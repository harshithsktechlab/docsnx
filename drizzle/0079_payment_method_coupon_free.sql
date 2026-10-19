-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0079 — Correct the payment method on orders Razorpay never saw          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- /api/payments/create-order settles a ₹0 order (or a super admin's manual
-- checkout) itself, without Razorpay, but left `payment_method` at its
-- 'RAZORPAY' default — so a plan bought with a 100% coupon showed on the
-- Payments page as a Razorpay payment. The route now writes the method; this
-- corrects the rows written before, identified by the order id that path
-- generates (`trial_<ms>` / `manual_<ms>`, never a Razorpay `order_…` id):
--   manual_…                              → MANUAL
--   trial_… with a discount that saved >0 → COUPON
--   trial_… otherwise                     → FREE
--
-- Data only. Idempotent: only rows still marked RAZORPAY are touched.
UPDATE "payments" p
SET "payment_method" = CASE
      WHEN p.razorpay_order_id LIKE 'manual\_%' THEN 'MANUAL'
      WHEN EXISTS (
        SELECT 1 FROM "discount_usages" du WHERE du.payment_id = p.id AND du.amount_saved > 0
      ) THEN 'COUPON'
      ELSE 'FREE'
    END,
    "updated_at" = now()
WHERE p.payment_method = 'RAZORPAY'
  AND p.razorpay_payment_id IS NULL
  AND (p.razorpay_order_id LIKE 'trial\_%' OR p.razorpay_order_id LIKE 'manual\_%');
