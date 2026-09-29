UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email='sunil@hsk.com') WHERE email='sunil@gadhiya.biz';
