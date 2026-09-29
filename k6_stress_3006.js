import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    shadow_stress: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '5s', target: 25 },
        { duration: '10s', target: 50 },
        { duration: '5s', target: 100 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'], // http errors should be less than 5%
    http_req_duration: ['p(95)<500'], // 95% of requests should be below 500ms
  },
};

export default function () {
  const endpoints = [
    'http://localhost:3006/',
    'http://localhost:3006/login',
  ];
  const url = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(url);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(0.1);
}
