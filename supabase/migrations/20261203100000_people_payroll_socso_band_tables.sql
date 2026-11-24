-- Lekiu payroll: SOCSO employer shares come from PERKESO's Akta 4 band table,
-- not as a rate of wages (issue #423, part 1).
--
-- The employer rows were one rate each (1.75% below 60, 1.25% from 60, capped at
-- RM104.15 and RM74.40), and a rate moves with every sen inside a band while the
-- schedule prints one figure for the whole band. Swept at every whole ringgit from
-- RM1.00 to RM6,000.00, the employer first-category figure was wrong on 5,790 of
-- 6,000 points, up to RM0.90 either way (2,907 over and 2,883 under): RM299.01 and
-- RM300.01 both gave 5.25 where the table says 4.35 and 6.15. The second category
-- was wrong on 5,697 points, up to RM0.65.
--
-- Where the figures come from: PERKESO's Akta 4 contribution schedule including
-- SKBBK (NewContributionRateIncludingSKBBK.pdf), 8 pages of real text, 65 rows:
-- 64 bands and the row above the RM6,000 ceiling. Each printed row satisfies
-- employer + employee invalidity + employee SKBBK = its total and second-category
-- employer + SKBBK = its total, 0 mismatches over the 455 figures.
-- supabase/tests/people_payroll_socso_bands_check.sql pins the 65 figures this
-- migration stores and reads them back through the function.
--
-- Only the employer column lands here. The employee's SOCSO figure is three
-- components now (invalidity, a SKBBK share that carries on after 60), and whether
-- a Malaysian pays SKBBK at all is contested, so that half waits on the decision
-- the issue records. The employee rows keep their rate unchanged, which is why a
-- below-60 employee still pays 0.5% capped at RM29.75 above RM5,950.
--
-- The key does not move: a band row carries amount_cents, so the proposal reads it
-- and no rate. Eight sets, four citizenships by two categories, 65 rows each.

-- ---- the rate rows these bands replace ------------------------------------
delete from public.hr_statutory_rules where scheme = 'socso' and payer = 'employer';

-- ---- first category, below 60: 65 bands x 4 citizenships -------------------
insert into public.hr_statutory_rules
  (scheme, payer, citizenship, employee_from_age, employee_until_age, wage_from_cents,
   rate, max_cents, round_to_cents, note, amount_cents)
select 'socso', 'employer', s.citizenship, 0, 60, b.from_cents,
       null, null, 1, 'Akta 4 schedule, first category, below 60', b.amount_cents
from (values
    (1, 40),
    (3001, 70),
    (5001, 110),
    (7001, 150),
    (10001, 210),
    (14001, 295),
    (20001, 435),
    (30001, 615),
    (40001, 785),
    (50001, 965),
    (60001, 1135),
    (70001, 1315),
    (80001, 1485),
    (90001, 1665),
    (100001, 1835),
    (110001, 2015),
    (120001, 2185),
    (130001, 2365),
    (140001, 2535),
    (150001, 2715),
    (160001, 2885),
    (170001, 3065),
    (180001, 3235),
    (190001, 3415),
    (200001, 3585),
    (210001, 3765),
    (220001, 3935),
    (230001, 4115),
    (240001, 4285),
    (250001, 4465),
    (260001, 4635),
    (270001, 4815),
    (280001, 4985),
    (290001, 5165),
    (300001, 5335),
    (310001, 5515),
    (320001, 5685),
    (330001, 5865),
    (340001, 6035),
    (350001, 6215),
    (360001, 6385),
    (370001, 6565),
    (380001, 6735),
    (390001, 6915),
    (400001, 7085),
    (410001, 7265),
    (420001, 7435),
    (430001, 7615),
    (440001, 7785),
    (450001, 7965),
    (460001, 8135),
    (470001, 8315),
    (480001, 8485),
    (490001, 8665),
    (500001, 8835),
    (510001, 9015),
    (520001, 9185),
    (530001, 9365),
    (540001, 9535),
    (550001, 9715),
    (560001, 9885),
    (570001, 10065),
    (580001, 10235),
    (590001, 10415),
    (600001, 10415)
  ) as b(from_cents, amount_cents)
cross join (values
    ('citizen'),
    ('permanent_resident'),
    ('non_citizen_before_1998'),
    ('non_citizen')
  ) as s(citizenship);

-- ---- second category, 60 and over: 65 bands x 4 citizenships --------------
-- From 60 the employer pays the injury share only, so the figures step down. The
-- top row repeats the ceiling band's figure, as the schedule prints it.
insert into public.hr_statutory_rules
  (scheme, payer, citizenship, employee_from_age, employee_until_age, wage_from_cents,
   rate, max_cents, round_to_cents, note, amount_cents)
select 'socso', 'employer', s.citizenship, 60, null, b.from_cents,
       null, null, 1, 'Akta 4 schedule, second category, 60 and over', b.amount_cents
from (values
    (1, 30),
    (3001, 50),
    (5001, 80),
    (7001, 110),
    (10001, 150),
    (14001, 210),
    (20001, 310),
    (30001, 440),
    (40001, 560),
    (50001, 690),
    (60001, 810),
    (70001, 940),
    (80001, 1060),
    (90001, 1190),
    (100001, 1310),
    (110001, 1440),
    (120001, 1560),
    (130001, 1690),
    (140001, 1810),
    (150001, 1940),
    (160001, 2060),
    (170001, 2190),
    (180001, 2310),
    (190001, 2440),
    (200001, 2560),
    (210001, 2690),
    (220001, 2810),
    (230001, 2940),
    (240001, 3060),
    (250001, 3190),
    (260001, 3310),
    (270001, 3440),
    (280001, 3560),
    (290001, 3690),
    (300001, 3810),
    (310001, 3940),
    (320001, 4060),
    (330001, 4190),
    (340001, 4310),
    (350001, 4440),
    (360001, 4560),
    (370001, 4690),
    (380001, 4810),
    (390001, 4940),
    (400001, 5060),
    (410001, 5190),
    (420001, 5310),
    (430001, 5440),
    (440001, 5560),
    (450001, 5690),
    (460001, 5810),
    (470001, 5940),
    (480001, 6060),
    (490001, 6190),
    (500001, 6310),
    (510001, 6440),
    (520001, 6560),
    (530001, 6690),
    (540001, 6810),
    (550001, 6940),
    (560001, 7060),
    (570001, 7190),
    (580001, 7310),
    (590001, 7440),
    (600001, 7440)
  ) as b(from_cents, amount_cents)
cross join (values
    ('citizen'),
    ('permanent_resident'),
    ('non_citizen_before_1998'),
    ('non_citizen')
  ) as s(citizenship);

-- ---- how many rows the load should leave ---------------------------------
-- 520 band rows replace 8 rate rows. The check file pins the count it reads.

