$sshCmd = "ssh -i `"C:\Users\Admin\.ssh\ssh-key-2026-06-11.key`" -o StrictHostKeyChecking=no ubuntu@80.225.252.161 `"docker cp docsnx-app:/app/src/app/warranty/page.js /tmp/warranty_page.js`""
Invoke-Expression $sshCmd
scp -i "C:\Users\Admin\.ssh\ssh-key-2026-06-11.key" -o StrictHostKeyChecking=no ubuntu@80.225.252.161:/tmp/warranty_page.js src/app/warranty/page.js
