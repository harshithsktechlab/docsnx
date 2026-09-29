import Razorpay from 'razorpay';
import crypto from 'crypto';

/**
 * Razorpay SDK client — initialized from environment variables.
 * key_secret is NEVER exposed to the client.
 */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret',
});

/**
 * Creates a new Razorpay order.
 * @param {number} amount - Amount in paise (e.g., 499900 for ₹4,999)
 * @param {string} currency - Currency code (default: INR)
 * @param {string} receipt - Unique receipt identifier
 * @param {object} notes - Optional metadata to attach to the order
 * @returns {Promise<object>} Razorpay order object
 */
export async function createOrder(amount, currency = 'INR', receipt, notes = {}) {
  const order = await razorpay.orders.create({
    amount,
    currency,
    receipt,
    notes,
  });
  return order;
}

/**
 * Verifies a Razorpay payment signature (HMAC SHA256).
 * This MUST be called server-side after the checkout modal closes.
 * @param {string} orderId - razorpay_order_id
 * @param {string} paymentId - razorpay_payment_id
 * @param {string} signature - razorpay_signature
 * @returns {boolean} True if signature is valid
 */
export function verifyPaymentSignature(orderId, paymentId, signature) {
  const body = orderId + '|' + paymentId;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  return expectedSignature === signature;
}

/**
 * Verifies a Razorpay webhook signature.
 * @param {string} body - Raw request body as string
 * @param {string} signature - X-Razorpay-Signature header value
 * @returns {boolean} True if webhook signature is valid
 */
export function verifyWebhookSignature(body, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return expectedSignature === signature;
}

/**
 * Returns the Razorpay key_id for client-side SDK initialization.
 * This is safe to expose — only the key_secret must remain server-side.
 */
export function getPublicKeyId() {
  return process.env.RAZORPAY_KEY_ID;
}

export default razorpay;
