-- Migration to add detailed guest visit tracking info
ALTER TABLE guest_visits ADD COLUMN ip TEXT;
ALTER TABLE guest_visits ADD COLUMN user_agent TEXT;
ALTER TABLE guest_visits ADD COLUMN country TEXT;
ALTER TABLE guest_visits ADD COLUMN city TEXT;
ALTER TABLE guest_visits ADD COLUMN asn_org TEXT;
ALTER TABLE guest_visits ADD COLUMN first_visit_time TEXT;
