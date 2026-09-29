$sshCmd = "ssh -i `"C:\Users\Admin\.ssh\ssh-key-2026-06-11.key`" -o StrictHostKeyChecking=no ubuntu@80.225.252.161 `"docker cp docsnx-app:/app/src/app/investments/page.js /tmp/investments_page.js && docker cp docsnx-app:/app/src/app/lic-mediclaim/page.js /tmp/lic_mediclaim_page.js && docker cp docsnx-app:/app/src/app/medical/page.js /tmp/medical_page.js && docker cp docsnx-app:/app/src/app/rentals/page.js /tmp/rentals_page.js && docker cp docsnx-app:/app/src/app/follow-up/page.js /tmp/follow_up_page.js && docker cp docsnx-app:/app/src/app/vehicles/page.js /tmp/vehicles_page.js`""
Invoke-Expression $sshCmd
scp -i "C:\Users\Admin\.ssh\ssh-key-2026-06-11.key" -o StrictHostKeyChecking=no ubuntu@80.225.252.161:/tmp/investments_page.js src/app/investments/page.js
scp -i "C:\Users\Admin\.ssh\ssh-key-2026-06-11.key" -o StrictHostKeyChecking=no ubuntu@80.225.252.161:/tmp/lic_mediclaim_page.js src/app/lic-mediclaim/page.js
scp -i "C:\Users\Admin\.ssh\ssh-key-2026-06-11.key" -o StrictHostKeyChecking=no ubuntu@80.225.252.161:/tmp/medical_page.js src/app/medical/page.js
scp -i "C:\Users\Admin\.ssh\ssh-key-2026-06-11.key" -o StrictHostKeyChecking=no ubuntu@80.225.252.161:/tmp/rentals_page.js src/app/rentals/page.js
scp -i "C:\Users\Admin\.ssh\ssh-key-2026-06-11.key" -o StrictHostKeyChecking=no ubuntu@80.225.252.161:/tmp/follow_up_page.js src/app/follow-up/page.js
scp -i "C:\Users\Admin\.ssh\ssh-key-2026-06-11.key" -o StrictHostKeyChecking=no ubuntu@80.225.252.161:/tmp/vehicles_page.js src/app/vehicles/page.js
