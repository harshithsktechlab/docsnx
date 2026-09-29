import 'dotenv/config';
import { POST } from '../src/app/api/ai/scan/route';
import fs from 'fs';

async function testApi() {
  const fileContent = fs.readFileSync('d:/hsk development/apps/docsnx/public/sample_receipt.txt');
  const fileBlob = new Blob([fileContent], { type: 'text/plain' });
  
  const formData = new FormData();
  formData.append('files', fileBlob, 'sample_receipt.txt');

  const mockReq: any = {
    formData: async () => formData,
    headers: new Headers({
      'cookie': 'auth_token=' // wait let's get a real token
    })
  };

  // Or let's just inspect what error scanMultipleFiles throws for tenantId
  console.log("Testing POST...");
}
testApi();
