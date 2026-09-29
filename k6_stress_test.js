import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      preAllocatedVUs: 500,
      timeUnit: '1s',
      startRate: 50,
      stages: [
        { duration: '10s', target: 100 },
        { duration: '20s', target: 500 },
        { duration: '20s', target: 1000 },
        { duration: '10s', target: 0 },
      ],
    },
  },
};

export default function () {
  const url = 'http://localhost:3005/';
  const res = http.get(url);
  check(res, {
    'is status 200': (r) => r.status === 200,
  });
}
