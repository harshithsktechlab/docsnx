const { execSync } = require('child_process');

try {
  const result = execSync(`ssh -i "D:\\VM\\hsk-testing_key.pem" -o StrictHostKeyChecking=no azureuser@20.244.47.54 "sudo -u postgres psql -d docsnx_db -c \\"SELECT email, email_verified, email_verification_otp, email_verification_otp_expiry FROM users WHERE email='cottonakola@gmail.com'\\""`, { encoding: 'utf8' });
  console.log(result);
} catch (error) {
  console.error("Error:", error.stdout || error.message);
}
