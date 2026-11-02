-- "Member" and "seat" are now "user" everywhere the customer reads it.
--
-- The UI, emails and API messages changed in code. Plan and add-on names and
-- descriptions are DATA — edited by hand in Admin — so the code change cannot
-- reach them. This does, for rows that still use the old words.
--
-- Whole words only, case and plural kept, so "Extra 5 Members" becomes
-- "Extra 5 Users" and nothing like "Membership" is touched. Safe to run again:
-- once a row is renamed it no longer matches, and the WHERE clauses leave it
-- alone.
UPDATE "addons"
   SET "name" = regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace("name", '\mMembers\M', 'Users', 'g'), '\mmembers\M', 'users', 'g'), '\mMember\M', 'User', 'g'), '\mmember\M', 'user', 'g'), '\mSeats\M', 'Users', 'g'), '\mseats\M', 'users', 'g'), '\mSeat\M', 'User', 'g'), '\mseat\M', 'user', 'g'),
       "description" = regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace("description", '\mMembers\M', 'Users', 'g'), '\mmembers\M', 'users', 'g'), '\mMember\M', 'User', 'g'), '\mmember\M', 'user', 'g'), '\mSeats\M', 'Users', 'g'), '\mseats\M', 'users', 'g'), '\mSeat\M', 'User', 'g'), '\mseat\M', 'user', 'g')
 WHERE "name" ~* '\m(members?|seats?)\M'
    OR "description" ~* '\m(members?|seats?)\M';--> statement-breakpoint

UPDATE "subscription_plans"
   SET "name" = regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace("name", '\mMembers\M', 'Users', 'g'), '\mmembers\M', 'users', 'g'), '\mMember\M', 'User', 'g'), '\mmember\M', 'user', 'g'), '\mSeats\M', 'Users', 'g'), '\mseats\M', 'users', 'g'), '\mSeat\M', 'User', 'g'), '\mseat\M', 'user', 'g')
 WHERE "name" ~* '\m(members?|seats?)\M';
