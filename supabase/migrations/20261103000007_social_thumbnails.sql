-- Post thumbnails for the social dashboard (a picture link from the platform, refreshed on each sync)
alter table vt.social_posts add column if not exists thumbnail_url text;
