## 2026-07-04T10:28:27Z
You are the teamwork_preview_worker.
Your working directory is d:\Apps\familyos\.agents\worker_m3_auth.
Your task is to implement the Forgot Password and Password Reset flows utilizing nodemailer and SMTP SystemConfig configurations, and add UI/API routes and a link to `/forgot-password` on the login page.

Please follow these steps:
1. Open and update `package.json` to include `"nodemailer": "^6.9.13"` (or similar compatible version) in dependencies.
2. Run `npm install` to install dependencies and verify it completes successfully.
3. Create an email utility `src/lib/mailer.js`:
   - It should retrieve the active SMTP settings from the database: `prisma.systemConfig.findFirst()`.
   - If configured, it should decrypt the SMTP password using `decrypt` from `src/lib/encryption.js`.
   - Initialize a `nodemailer` transport using:
     - `host: config.smtpHost`
     - `port: config.smtpPort`
     - `secure: config.smtpSecure`
     - `auth: { user: config.smtpUser, pass: decryptedPassword }`
   - Implement `sendPasswordResetEmail(email, name, resetLink)`:
     - Send the email from `config.smtpFrom` containing a link like: `${process.env.APP_URL || 'http://localhost:3005'}/reset-password?token=${token}`.
     - Include an offline/fail-safe try-catch: if `nodemailer` fails to send the email (e.g. because of connection timeout in our network-restricted environment), it must print the reset link to `console.log` and write it to `public/reset_link_debug.log` (or another debug file) so that automated tests or judges can find it and complete the flow.
4. Implement API route `/src/app/api/auth/forgot-password/route.js` (POST):
   - Receive `{ email }`.
   - Find the user with this email using Prisma client. If user does not exist, return a generic success message (to prevent user enumeration) or return an error (standard is to return success so it's secure, but let's check: "The Forgot Password route successfully generates a reset token in the database and triggers the SMTP mailer logic" - returning success with details or error is fine, let's return a clean success message: `{ success: true, message: 'Password reset link sent' }`).
   - If user exists:
     - Generate a random 32-byte hex token: `crypto.randomBytes(32).toString('hex')`.
     - Set the token and expiry (e.g., 1 hour from now) on the user model:
       - `resetToken: token`
       - `resetTokenExpiry: new Date(Date.now() + 3600000)`
     - Save changes to the database.
     - Send the reset email via `src/lib/mailer.js`'s `sendPasswordResetEmail` function.
     - Write the token/link to console and `public/reset_link_debug.log` to support testing in our offline/CODE_ONLY mode.
5. Implement API route `/src/app/api/auth/reset-password/route.js` (POST):
   - Receive `{ token, newPassword }`.
   - Query the user by `resetToken: token` and verify that `resetTokenExpiry` is in the future. If not found or expired, return an error `{ error: 'Invalid or expired token' }` with status 400.
   - If user is found:
     - Hash the `newPassword` using `bcryptjs` (`bcrypt.hash(newPassword, 10)`).
     - Update the user's password hash in the database, clear `resetToken` and `resetTokenExpiry`.
     - Return `{ success: true, message: 'Password reset successful' }`.
6. Implement frontend page `/src/app/forgot-password/page.js`:
   - Create a clean form asking for email, calling `/api/auth/forgot-password` on submit, and displaying success/error alerts. Match the cozy Terracotta & Sand branding layout.
7. Implement frontend page `/src/app/reset-password/page.js`:
   - Retrieve the `token` from query parameters (`useSearchParams`).
   - Show a form asking for a new password and password confirmation.
   - On submit, call `/api/auth/reset-password` with the token and new password.
   - On success, display a success alert and redirect to `/login`.
8. Edit `src/app/login/page.js` to add a "Forgot your password?" button/link under the form or near the sign-in actions, routing to `/forgot-password`.
9. Test and verify the flow:
   - Create a test script `scripts/verify_auth_flow.js` that programmatically tests the password reset flow:
     - Creates a user (or uses John Doe).
     - Hits the forgot password API.
     - Reads the reset token from the database.
     - Hits the reset password API.
     - Verifies that the password hash is updated and we can log in with the new password.
10. Write `handoff.md` and report back.
