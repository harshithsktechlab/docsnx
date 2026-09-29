import http from 'node:http';
import os from 'node:os';

const TARGET_URLS = [
  'http://localhost:3006/',
  'http://localhost:3006/login'
];

// Helper to make a single HTTP request and return duration + status
function makeRequest(url) {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = http.get(url, { agent: false, timeout: 5000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        const duration = performance.now() - start;
        resolve({ duration, status: res.statusCode, error: null });
      });
    });
    req.on('error', (err) => {
      const duration = performance.now() - start;
      resolve({ duration, status: 0, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      const duration = performance.now() - start;
      resolve({ duration, status: 408, error: 'timeout' });
    });
  });
}

async function runConcurrencyPhase(concurrency, durationSec) {
  const endTime = Date.now() + durationSec * 1000;
  const latencies = [];
  let successCount = 0;
  let errorCount = 0;
  let totalCount = 0;

  const startCpu = process.cpuUsage();
  const startMem = process.memoryUsage();
  const startTime = performance.now();

  const worker = async () => {
    while (Date.now() < endTime) {
      const url = TARGET_URLS[totalCount % TARGET_URLS.length];
      const res = await makeRequest(url);
      totalCount++;
      latencies.push(res.duration);
      if (res.status >= 200 && res.status < 400) {
        successCount++;
      } else {
        errorCount++;
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const totalTimeSec = (performance.now() - startTime) / 1000;
  const endCpu = process.cpuUsage(startCpu);
  const endMem = process.memoryUsage();

  latencies.sort((a, b) => a - b);
  const getPercentile = (p) => {
    if (latencies.length === 0) return 0;
    const idx = Math.floor((p / 100) * latencies.length);
    return latencies[Math.min(idx, latencies.length - 1)].toFixed(2);
  };

  const rps = (totalCount / totalTimeSec).toFixed(2);
  const p50 = getPercentile(50);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);
  const p99 = getPercentile(99);

  return {
    concurrency,
    durationSec,
    totalRequests: totalCount,
    successCount,
    errorCount,
    rps: Number(rps),
    p50: Number(p50),
    p90: Number(p90),
    p95: Number(p95),
    p99: Number(p99),
    memoryDeltaMB: ((endMem.rss - startMem.rss) / (1024 * 1024)).toFixed(2),
    cpuUserSec: (endCpu.user / 1e6).toFixed(2),
    cpuSystemSec: (endCpu.system / 1e6).toFixed(2),
  };
}

async function main() {
  console.log('====================================================');
  console.log('   SHADOW ENVIRONMENT STRESS & CAPACITY BENCHMARK   ');
  console.log('   Target: http://localhost:3006                    ');
  console.log('====================================================\n');

  const concurrencyLevels = [10, 25, 50, 100];
  const results = [];

  for (const c of concurrencyLevels) {
    console.log(`Running benchmark at Concurrency = ${c} VUs (5 seconds)...`);
    const res = await runConcurrencyPhase(c, 5);
    results.push(res);
    console.log(` -> Completed: ${res.totalRequests} reqs | RPS: ${res.rps} | P95: ${res.p95}ms | Errors: ${res.errorCount}\n`);
  }

  console.log('\n====================================================');
  console.log('                  SUMMARY TABLE                     ');
  console.log('====================================================');
  console.table(results.map(r => ({
    'VUs': r.concurrency,
    'Total Reqs': r.totalRequests,
    'RPS': r.rps,
    'Success %': ((r.successCount / r.totalRequests) * 100).toFixed(1) + '%',
    'P50 (ms)': r.p50,
    'P95 (ms)': r.p95,
    'P99 (ms)': r.p99,
    'Mem Delta (MB)': r.memoryDeltaMB
  })));

  // Write JSON output
  const fs = await import('node:fs/promises');
  await fs.writeFile('benchmark_results_3006.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('Saved detailed results to benchmark_results_3006.json');
}

main().catch(console.error);
