ALTER TABLE public_status_pages ADD COLUMN hide_expired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public_status_pages ADD COLUMN hide_lifetime INTEGER NOT NULL DEFAULT 0;
