-- What the dealer's team did with each lead, beyond its stage: first contact, calls, a connected call,
-- test drive booked or given, and the model asked about. Read from the dealer feed's history.
alter table vt.journeys add column if not exists first_contact_at timestamptz;
alter table vt.journeys add column if not exists calls int not null default 0;
alter table vt.journeys add column if not exists connected boolean not null default false;
alter table vt.journeys add column if not exists td_booked boolean not null default false;
alter table vt.journeys add column if not exists td_given boolean not null default false;
alter table vt.journeys add column if not exists model text;
alter table vt.journeys add column if not exists lead_at timestamptz;
